#!/usr/bin/env python3
"""kimi-oauth-proxy: 把 Hermes 的静态 api_key 调用桥接到 Kimi Code 订阅的 OAuth 端点。

- 监听 127.0.0.1:8643，转发 /v1/* 到 https://api.kimi.com/coding/v1/*
- 每次请求从 ~/.kimi-code/credentials/kimi-code.json 读最新 access_token 注入
- 令牌临期（<60s）或上游 401 时用 refresh_token 刷新并原子写回（refresh_token 每次轮换）
- 与 kimi CLI 共用同一份凭据文件；刷新前先重读文件，尽量用 CLI 已刷新的令牌
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = 'https://api.kimi.com/coding'
TOKEN_URL = 'https://auth.kimi.com/api/oauth/token'
CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
CRED_PATH = os.path.expanduser('~/.kimi-code/credentials/kimi-code.json')
LISTEN = ('127.0.0.1', 8643)
REFRESH_MARGIN = 60  # 秒

_lock = threading.Lock()


def _load_cred():
    with open(CRED_PATH) as f:
        return json.load(f)


def _save_cred(cred):
    tmp = CRED_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cred, f, indent=2)
    os.replace(tmp, CRED_PATH)


def _refresh(cred):
    body = urllib.parse.urlencode({
        'grant_type': 'refresh_token',
        'refresh_token': cred['refresh_token'],
        'client_id': CLIENT_ID,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body,
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    resp = json.load(urllib.request.urlopen(req, timeout=15))
    if 'access_token' not in resp:
        raise RuntimeError(f"token refresh failed: {resp}")
    cred['access_token'] = resp['access_token']
    if resp.get('refresh_token'):
        cred['refresh_token'] = resp['refresh_token']
    cred['expires_at'] = int(time.time()) + int(resp.get('expires_in', 900))
    cred['expires_in'] = resp.get('expires_in', 900)
    _save_cred(cred)
    return cred


def get_token(force_refresh=False):
    with _lock:
        cred = _load_cred()
        fresh = cred.get('expires_at', 0) - time.time() > REFRESH_MARGIN
        if force_refresh or not fresh:
            cred = _refresh(cred)
        return cred['access_token']


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _proxy(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        url = UPSTREAM + self.path
        for attempt in range(2):
            token = get_token(force_refresh=(attempt == 1))
            req = urllib.request.Request(url, data=body, method=self.command)
            req.add_header('Authorization', f'Bearer {token}')
            req.add_header('Content-Type', self.headers.get('Content-Type', 'application/json'))
            try:
                resp = urllib.request.urlopen(req, timeout=300)
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    continue
                self._relay(e)
                return
            self._relay(resp)
            return

    def _relay(self, resp):
        self.send_response(resp.status)
        for k, v in resp.headers.items():
            if k.lower() in ('transfer-encoding', 'connection', 'content-length',
                             'content-encoding'):
                continue
            self.send_header(k, v)
        # 流式/非流式统一按块透传
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        while True:
            chunk = resp.read(8192)
            if not chunk:
                break
            self.wfile.write(b'%x\r\n%s\r\n' % (len(chunk), chunk))
            self.wfile.flush()
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()

    do_GET = do_POST = do_PUT = do_DELETE = _proxy

    def log_message(self, fmt, *args):
        print('%s %s' % (self.address_string(), fmt % args), flush=True)


if __name__ == '__main__':
    print(f'kimi-oauth-proxy listening on {LISTEN[0]}:{LISTEN[1]} -> {UPSTREAM}', flush=True)
    ThreadingHTTPServer(LISTEN, Handler).serve_forever()
