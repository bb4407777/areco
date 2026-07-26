#!/usr/bin/env python3
"""
StandCode Caller 测试脚本

模拟接收一条简单请求并调用 Caller 派发给 Stand，
验证流程是否通畅（不必等待 Stand 真正完成）。

用法:
    python3 caller/test_dispatch.py [--task-type TYPE] [--request TEXT] [--wait]

选项:
    --task-type  任务类型（search/coding/writing/analysis/general，默认 general）
    --request    自定义请求文本（默认使用示例请求）
    --wait       等待 Stand 回复（默认只验证派发不等待完成）
    --timeout    等待超时秒数（默认 30，仅 --wait 时生效）
    --room-id    复用现有房间 ID（可选）
    --template   指定模板 ID（可选，覆盖 task_type 映射）
    --cleanup    测试完成后删除房间
"""

import argparse
import json
import logging
import sys
import time

# 添加父目录到 path
sys.path.insert(0, str(__file__).rsplit("/", 1)[0])

from caller import Caller

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("test_dispatch")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="StandCode Caller 测试脚本")
    parser.add_argument("--task-type", default="general", help="任务类型")
    parser.add_argument("--request", default=None, help="请求文本")
    parser.add_argument("--wait", action="store_true", help="等待 Stand 回复")
    parser.add_argument("--timeout", type=int, default=30, help="等待超时秒数")
    parser.add_argument("--room-id", default=None, help="复用现有房间 ID")
    parser.add_argument("--template", default=None, help="指定模板 ID")
    parser.add_argument("--cleanup", action="store_true", help="测试完成后删除房间")
    # ── 主动轮询 + 微信代发（dispatch_and_relay）──────────────
    parser.add_argument(
        "--relay",
        action="store_true",
        help="走 dispatch_and_relay 一站式：派发→主动轮询→代发微信（验证 Caller 主动拉结果）",
    )
    parser.add_argument(
        "--send-wechat",
        action="store_true",
        help="配合 --relay：真正发送微信（默认 dry-run，只验证轮询链路）",
    )
    parser.add_argument("--summary", default=None, help="一句话结论（--relay 代发微信用）")
    parser.add_argument("--file-path", default=None, help="产物文件路径（--relay 代发微信用）")
    parser.add_argument(
        "--poll-timeout", type=int, default=600, help="--relay 轮询超时秒数（默认 600）"
    )
    parser.add_argument(
        "--role",
        choices=["thinker", "worker"],
        default=None,
        help="--relay 按角色分派：thinker=GLM-5.2（默认） / worker=Reasonix（默认）",
    )
    parser.add_argument(
        "--plan",
        action="store_true",
        help="走 plan_and_execute 两段式：Thinker 出计划 → Worker 执行（dry-run 默认）",
    )
    return parser.parse_args()


SAMPLE_REQUESTS = {
    "search": '请搜索 2026 年 7 月中国最高人民法院发布的典型案例，列出标题与要点',
    "coding": '请用 Python 写一个斐波那契数列生成器，包含注释和测试用例',
    "writing": '请写一篇 200 字左右的短文，主题为「法律与科技」',
    "analysis": '请分析以下场景的风险：甲方是软件公司，乙方是客户，合同约定按季度付款但未约定违约金比例',
    "general": '你好，请用一句话说明今天你能帮我做什么',
}


def run_dispatch_and_relay(caller: Caller, args, task_type: str, request: str) -> int:
    """跑一遍 dispatch_and_relay：派发 → 主动轮询 → 代发微信（默认 dry-run）

    dry-run 时只拼装微信内容不真正发送，用于验证「Caller 主动轮询能拿到 Stand 结果」。
    """
    dry_run = not args.send_wechat
    print(f"[dispatch_and_relay] dry_run={dry_run} poll_timeout={args.poll_timeout}s")
    print(
        f"[dispatch_and_relay] 请求: {request[:80]}{'…' if len(request) > 80 else ''}"
    )
    print()

    start = time.time()
    try:
        result = caller.dispatch_and_relay(
            request=request,
            task_type=task_type,
            request_summary=args.summary,
            role=args.role,
            room_id=args.room_id,
            template_id=args.template,
            file_path=args.file_path,
            poll_timeout=args.poll_timeout,
            dry_run=dry_run,
        )
    except Exception as e:
        logger.error("dispatch_and_relay 失败: %s", e)
        print(f"\n❌ dispatch_and_relay 失败: {e}")
        sys.exit(1)

    elapsed = time.time() - start
    status = result.get("status")
    print(f"   task_id    : {result.get('task_id')}")
    print(f"   room_id    : {result.get('room_id')}")
    print(f"   session_id : {result.get('session_id')}")
    print(
        f"   stand_name : {result.get('stand_name')}  (template={result.get('template_id')})"
    )
    print(
        f"   状态       : {status}（轮询 {result.get('elapsed')}s / 总 {elapsed:.1f}s）"
    )
    if result.get("completed_at"):
        print(f"   完成时间   : {result['completed_at']}")
    print()

    replies = result.get("stand_replies") or []
    if replies:
        print(f"   ── Stand 回复（{len(replies)} 条）──")
        for r in replies:
            body = str(r.get("body", ""))
            print(f"      [{r.get('from_agent')}] {body[:200]}{'…' if len(body) > 200 else ''}")
        print()

    wechat = result.get("wechat") or {}
    print(
        f"   relayed    : {result.get('relayed')} (dry_run={wechat.get('dry_run')})"
    )
    if wechat.get("content"):
        print("   ── 微信代发内容 ──")
        for line in wechat["content"].splitlines():
            print(f"      {line}")
    if not result.get("relayed") and not wechat.get("dry_run"):
        print(
            f"   ⚠️ 微信发送失败: rc={wechat.get('returncode')} "
            f"out={(wechat.get('stdout') or '')[-200:]}"
        )
    print()

    if args.cleanup:
        print("清理房间…")
        try:
            caller.delete_room(result["room_id"])
            print("   ✓ 房间已删除")
        except Exception as e:
            print(f"   ✗ 删除失败: {e}")

    ok = status == "completed"
    print(f"\n{'='*60}")
    print(
        f" {'✅ 主动轮询拿到 Stand 结果' if ok else '⚠️ 未拿到结果（status=' + str(status) + '）'}"
    )
    print(f"{'='*60}")
    return 0 if ok else 2


def run_plan_and_execute(caller: Caller, args, task_type: str, request: str) -> int:
    """跑一遍 plan_and_execute：Thinker 出计划 → Worker 执行（默认 dry-run）"""
    dry_run = not args.send_wechat
    print(f"[plan_and_execute] dry_run={dry_run} poll_timeout={args.poll_timeout}s")
    print(f"[plan_and_execute] 请求: {request[:80]}{'…' if len(request) > 80 else ''}")
    print()

    start = time.time()
    try:
        result = caller.plan_and_execute(
            request=request,
            task_type=task_type,
            request_summary=args.summary,
            file_path=args.file_path,
            poll_timeout=args.poll_timeout,
            dry_run=dry_run,
        )
    except Exception as e:
        logger.error("plan_and_execute 失败: %s", e)
        print(f"\n❌ plan_and_execute 失败: {e}")
        sys.exit(1)

    elapsed = time.time() - start
    print(f"   stage      : {result.get('stage')}（总 {elapsed:.1f}s）")

    plan = result.get("plan") or {}
    print(f"   Thinker    : {plan.get('stand_name')} (template={plan.get('template_id')}) "
          f"status={plan.get('status')} elapsed={plan.get('elapsed')}s")
    if result.get("plan_text"):
        print(f"   ── 计划摘要 ──\n      {str(result['plan_text'])[:300]}{'…' if len(str(result['plan_text']))>300 else ''}")

    exe = result.get("execute") or {}
    print(f"   Worker     : {exe.get('stand_name')} (template={exe.get('template_id')}) "
          f"status={exe.get('status')} elapsed={exe.get('elapsed')}s")
    if result.get("result_text"):
        print(f"   ── Worker 结果 ──\n      {str(result['result_text'])[:300]}{'…' if len(str(result['result_text']))>300 else ''}")
    print()

    wechat = result.get("wechat") or {}
    print(f"   relayed    : {result.get('relayed')} (dry_run={wechat.get('dry_run')})")
    if wechat.get("content"):
        print("   ── 微信代发内容 ──")
        for line in wechat["content"].splitlines():
            print(f"      {line}")
    print()

    if args.cleanup:
        for key in ("plan", "execute"):
            r = result.get(key) or {}
            if r.get("room_id"):
                try:
                    caller.delete_room(r["room_id"])
                    print(f"   ✓ 删除 {key} 房间 {r['room_id']}")
                except Exception as e:
                    print(f"   ✗ 删除 {key} 房间失败: {e}")

    ok = bool(result.get("result_text"))
    print(f"\n{'='*60}")
    print(f" {'✅ Thinker→Worker 两段式完成' if ok else '⚠️ 未产出结果'}")
    print(f"{'='*60}")
    return 0 if ok else 2


def main():
    args = parse_args()

    task_type = args.task_type
    request = args.request or SAMPLE_REQUESTS.get(task_type, SAMPLE_REQUESTS["general"])

    caller = Caller()

    print(f"\n{'='*60}")
    print(f" StandCode Caller 测试")
    print(f" 任务类型: {task_type}")
    print(f" 请求文本: {request[:80]}{'…' if len(request) > 80 else ''}")
    print(f" 模板指定: {args.template or '自动'}")
    print(f" 等待结果: {'是' if args.wait else '否'}")
    print(f"{'='*60}\n")

    # ── 主动轮询 + 微信代发 一站式（验证 Caller 主动拉结果）─────
    if args.plan:
        return run_plan_and_execute(caller, args, task_type, request)
    if args.relay:
        return run_dispatch_and_relay(caller, args, task_type, request)

    # ── 1. 派发任务 ────────────────────────────────────────────
    print("[1/3] 派发任务…")
    start = time.time()

    try:
        result = caller.dispatch(
            request=request,
            task_type=task_type,
            room_id=args.room_id,
            template_id=args.template,
        )
    except Exception as e:
        logger.error("派发失败: %s", e)
        print(f"\n❌ 派发失败: {e}")
        sys.exit(1)

    elapsed = time.time() - start
    print(f"   ✓ 派发成功（{elapsed:.1f}s）")
    print(f"   session_id : {result['session_id']}")
    print(f"   room_id    : {result['room_id']}")
    print(f"   stand_name : {result['stand_name']}")
    print(f"   template   : {result['template_id']}")
    print(f"   message_id : {result['message_id']}")
    print()

    # ── 2. 查看房间消息 ────────────────────────────────────────
    print("[2/3] 查看房间消息…")
    time.sleep(2)
    try:
        msgs = caller.get_messages(result["session_id"])
        print(f"   房间共有 {len(msgs)} 条消息:")
        for m in msgs:
            print(f"     [{m['from_agent']} → {m['to_agent']}] {m['body'][:60]}{'…' if len(m['body']) > 60 else ''}")
    except Exception as e:
        print(f"   查询消息失败: {e}")
    print()

    # ── 3. 等待结果（可选） ─────────────────────────────────────
    if args.wait:
        print(f"[3/3] 等待 Stand 回复（超时 {args.timeout}s）…")
        start = time.time()
        poll_result = caller.poll_result(
            session_id=result["session_id"],
            timeout=args.timeout,
        )
        elapsed = time.time() - start
        status = poll_result["status"]
        replies = poll_result["stand_replies"]
        print(f"   状态: {status}（耗时 {elapsed:.1f}s）")
        if replies:
            for r in replies:
                print(f"\n   ── Stand 回复 ──")
                print(f"      来自: {r['from_agent']}")
                print(f"      内容: {r['body'][:200]}{'…' if len(r['body']) > 200 else ''}")
        else:
            print("   （无 Stand 回复）")
    else:
        print("[3/3] 跳过等待（使用 --wait 可等待 Stand 完成）")
    print()

    # ── 清理 ────────────────────────────────────────────────────
    if args.cleanup:
        print("清理房间…")
        try:
            caller.delete_room(result["room_id"])
            print("   ✓ 房间已删除")
        except Exception as e:
            print(f"   ✗ 删除失败: {e}")

    print(f"\n{'='*60}")
    print(" 测试完成")
    print(f"{'='*60}")
    print(f"\n查看房间消息: curl -s http://127.0.0.1:8790/api/rooms/{result['room_id']}/messages | python3 -m json.tool")
    print(f"查看房间详情: curl -s http://127.0.0.1:8790/api/rooms | python3 -m json.tool | grep -A 20 {result['room_id']}")


if __name__ == "__main__":
    main()
