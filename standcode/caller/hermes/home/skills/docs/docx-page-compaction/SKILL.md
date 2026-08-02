---
name: docx-page-compaction
description: 批量把已有 docx 压页排版（收窄页边距、整治空行、每份文书缩到一页）的配方与验证门。核心坑：中文字体行高远大于字号，单倍行距压不动，必须用固定值行距（w:line exact）。适用于用户要求"全部改成相同页边距/把空行改改/相同内容缩到一页"类批量 Word 排版任务。
---

# docx 批量压页排版

## 触发
用户给一目录的 docx（或单份多文书合并 docx），要求统一页边距、整治空行、内容压缩到一页/节。不要逐份手调——写脚本批量 + 渲染验证。

## 配方（2026-07-31 四方协议 42 份实证）

1. **先备份**：`cp -R <目录> ~/.backups/<日期>-<名>-backup`，数目录核对一致再动手。
2. **侦查结构**：python-docx 读一份样本，列出每段字号/段距/分页符，确定节边界标记（如 22pt 标题）和签名盖章区位置。
3. **页边距**：上下 1.8cm、左右 2.0cm（原 3.17cm 左右距是常见浪费源）。
4. **行距必须固定值**：中文字体（仿宋/楷体等）单倍行距（`w:line=240 lineRule=auto`）实际渲染可达 1.7em 以上，怎么压都没用。直接改 XML：
   - 正文 14pt 字 → `w:line=360 w:lineRule=exact`（18pt 固定行距），段后 1pt
   - 内容特别满的节可降到 17pt（`w:line=340`），低于此有裁剪风险
   - 标题（22pt）保持 auto，段后 8pt
5. **空行整治**：
   - 连续空行合并为一条（保留第一条，删后续）
   - 普通空行压矮：exact 10pt + 段后 2pt（同时把段落标记 rPr sz 调小，否则空行仍按原字号撑高）
   - **签字盖章区空行例外**：每节尾部 ~6 段内的空行加高到 exact 30pt——盖章直径约 4cm，空行太矮上下两行的章会互压
   - 分页符承载段（含 `<w:br w:type="page"/>` 的空段）：行高清零（exact 2pt），**否则满页节会被它撑出一页空白页**
6. **验证门（必做，不报感觉）**：
   - `soffice --headless --convert-to pdf --outdir /tmp/xx <目录>/*/*.docx`
   - `pdfinfo <pdf> | grep Pages` 数页 == 每份文件应有的文书份数（按节标题数算，注意标题跨两段的要人工折算）
   - `pdftoppm -f N -l N -r 80 -png` 渲染满页节，目检 exact 行距无文字裁剪、落款完整在页内
   - mdls 的 kMDItemNumberOfPages 对 /tmp 新文件返回 -1（Spotlight 不索引），数页用 pdfinfo
7. **个别回调**：验证后发现某份溢出，单独把该文件行距降 1pt 或签章空行从 30pt 降到 18pt，重转验证，不要为一份改全局参数。

## 坑
- python-docx 的 `pf.line_spacing = 1.0` 生成 `lineRule=auto`，对 CJK 字体压不动——别用它当压缩手段，只用于"恢复单倍"。
- 段距（space_after）从大改小是次要杠杆，行距固定值才是主杠杆。
- 加高签章区空行可能让最满的节溢出：改完全量重跑验证门，溢出者个别回调（步骤 7）。
- exact 行距在 Word/WPS/LibreOffice 渲染一致性好，但低于字号 1.2em 有裁剪风险，14pt 字不要低于 17pt。

## 环境
- python-docx 在 `/Users/gao/.workbuddy/binaries/python/envs/default/bin/python`（1.2.0）。
- LibreOffice 在 `/Applications/LibreOffice.app/Contents/MacOS/soffice`；pdfinfo/pdftoppm 来自 homebrew poppler。
