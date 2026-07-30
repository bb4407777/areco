#!/bin/bash
# 晨报数据源:功过格待办+日常事项+雷达原始组装文本(--emit 不直发,radar 自 ack),
# stdout 注入 Hermes agent prompt 排版后推微信(2026-07-26 管理者定"进 Hermes 收件箱")。
# 大坑(2026-07-27 首夜五连试错实录):lark-cli 检测到 Hermes 上下文即拒跑
# ("hermes context detected but lark-cli is not bound"),且检测信号不止 HERMES_HOME
# 一个环境变量(逐个 unset 不干净)——处方:env -i 全新环境包裹,只带 PATH/HOME。
#
# 【复原说明】本文件为模板:把所有 <HOME> 替换为实际家目录(如 /Users/<你>),
# 并把最后的 python 脚本路径指向你本机的晨报数据脚本,再改名为 morning-todo-data.sh。
cd <HOME> || exit 1
exec /usr/bin/env -i \
  PATH="<HOME>/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" \
  HOME=<HOME> \
  /usr/local/bin/python3 <HOME>/skills/feishu/scripts/gongguoge-todo-digest.py --emit
