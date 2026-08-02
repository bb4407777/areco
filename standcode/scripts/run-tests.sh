#!/bin/bash
# StandCode 全量测试入口（2026-08-02 检查报告 P2-6：npm test 原只跑 2/10 个测试文件）。
# 逐个执行 caller/test_*.py（全部为零依赖自跑式脚本，默认离线、不碰 areco/微信），
# 任一失败整体退出码 1。live/e2e 冒烟仍走各脚本自己的 --live 旗标，不在本入口。
set -uo pipefail
cd "$(dirname "$0")/.."

python3 -m py_compile caller/caller.py || exit 1

pass=0; fail=0; failed=()
for t in caller/test_*.py; do
  echo "=========================== $t"
  if python3 "$t"; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed+=("$t")
  fi
done

echo "==========================="
echo "test suites: $pass passed, $fail failed"
if [ $fail -gt 0 ]; then
  printf '  ✗ %s\n' "${failed[@]}"
  exit 1
fi
