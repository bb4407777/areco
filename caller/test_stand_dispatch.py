#!/usr/bin/env python3
"""StandCode end-to-end dispatch 测试：用 areco API 派发任务给 stand。"""
import argparse
import requests
import time

ARECO_BASE = "http://127.0.0.1:8790"


def dispatch(body: str, template_id: str, timeout: int = 120):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})

    # 创建临时 room
    r = s.post(f"{ARECO_BASE}/api/rooms", json={"name": f"Stand Dispatch {int(time.time())}"})
    room = r.json()["data"]
    rid = room["id"]
    print(f"room: {rid}")

    # 添加 stand
    r = s.post(f"{ARECO_BASE}/api/rooms/{rid}/members", json={"templateId": template_id})
    member = r.json()["data"]
    sid = member["sessionId"]
    name = member["name"]
    print(f"stand: {name} ({sid})")

    # 发消息
    r = s.post(f"{ARECO_BASE}/api/rooms/{rid}/messages", json={"body": body})
    print(f"sent: {r.status_code}")

    # 轮询结果
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(5)
        r = s.get(f"{ARECO_BASE}/api/rooms/{rid}/messages?limit=20")
        msgs = r.json().get("data", [])
        # 找 stand 的回复
        for m in msgs:
            if m.get("from") == name:
                print(f"\n✅ result from {name}:\n{m.get('body', '')}")
                # 删除临时 room
                s.delete(f"{ARECO_BASE}/api/rooms/{rid}")
                return m.get("body", "")
        # 检查 session 是否退出且无结果
        r = s.get(f"{ARECO_BASE}/api/sessions")
        for ss in r.json().get("data", []):
            if ss.get("id") == sid and ss.get("status") == "exited":
                print(f"⚠️ session exited without reply: code={ss.get('exitCode')} reason={ss.get('exitReason')}")
                s.delete(f"{ARECO_BASE}/api/rooms/{rid}")
                return None

    print("❌ timeout")
    s.delete(f"{ARECO_BASE}/api/rooms/{rid}")
    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--body", default="请用一句话解释什么是回文数。")
    parser.add_argument("--template", default="stand-thinker-workbuddy")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    dispatch(args.body, args.template, args.timeout)
