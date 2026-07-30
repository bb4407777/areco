# VENDORED — 第三方代码归属说明

## hermes_cli/（Hermes Agent 本体）

- **名称/版本**：hermes-agent 0.19.0（Python 包，import 名 `hermes_cli`）
- **作者/归属**：Nous Research
- **协议**：MIT（完整协议文本见 `hermes_cli/LICENSE`，vendor 时已随包带上）
- **来源**：本机 pip 安装的系统 site-packages（Python 3.12），上游为 PyPI `hermes-agent`
- **vendor 日期**：2026-07-30
- **处理方式**：原样拷贝，仅剔除 `__pycache__`，代码零改动；钉版依赖清单见 `requirements.txt`（抄自 `hermes_agent-0.19.0.dist-info/METADATA` 的 `Requires-Dist`，核心依赖不含 extras）

### 再 vendor（升级快照）方法

```bash
# 1. 升级本机 pip 包
pip install -U hermes-agent
# 2. 确认目标 site-packages 里的 hermes_cli 与 hermes_agent-<新版本>.dist-info
# 3. 重新同步（剔除 __pycache__）
rsync -a --delete --exclude __pycache__ \
  <site-packages>/hermes_cli/ standcode/caller/hermes/hermes_cli/
# 4. 从 dist-info/licenses/LICENSE 更新 hermes_cli/LICENSE；
#    从 dist-info/METADATA 的 Requires-Dist 重新生成 requirements.txt
# 5. 更新本文件的版本号与 vendor 日期
```

注意：仓内是 0.19.0 快照，之后 pip 侧升级**不会**自动反映到仓内，须按上面步骤手动再 vendor。

## bin/tirith 与 bin/lens

- **tirith**：18MB arm64 二进制，来源是 Hermes 家目录 `bin/` 自带工具（随本机 Hermes 环境部署，非 hermes-agent pip 包内容），原样收编、未改动。其上游归属以该二进制自身声明为准；若日后想给仓库瘦身，可单独 `git rm` 移出。
- **lens**：同为 Hermes 家目录 `bin/` 自带的 Python 瘦命令工具箱（自有脚本），原样收编（仅注释级脱敏，见 README）。

## bin/ 其余脚本

`qoder-llm-shim.py`、`hermes-profile-sync.py`、`kimi-oauth-proxy.py`、`hermes-charter-sync.py`、`hermes-token-report.py`、`hermes-nightly-qclaw.sh`、`qclaw-reasonix-shim.py` 均为本环境自有脚本（非第三方），收编前已逐文件密扫：无硬编码凭证，注释中出现的真实人名已脱敏为「管理者」。
