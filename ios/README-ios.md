# areco iOS 版

> 形态：WKWebView 壳。areco 前端本身是完整 PWA（会话 / 终端 / 微信 / 进程 / 设置），
> 原生端只做三件事——装这个前端、记住服务器地址、让登录 cookie 与 JS 弹窗正常工作。
> 前端改版后 App 不用重装，刷新即生效。

## 一次性准备

1. 装 Xcode（App Store），打开 → Settings → Accounts → 加 Apple ID（免费号即自动生成 Personal Team）。
2. iPhone 开开发者模式：设置 → 隐私与安全性 → 开发者模式 → 开，重启手机。

## 装到手机（个人签 7 天，之后每 7 天重装一次，数据不丢）

1. 打开 `ios/Areco.xcodeproj`（工程由 `ios/project.yml` 生成，改动后 `cd ios && xcodegen generate`）。
2. target Areco → Signing & Capabilities → Team 选 Personal Team；bundle id 撞车就在 `cn.gao.areco` 后面加几个字母。
3. 第一次用线：iPhone 插线（首次点「信任此电脑」），顶部设备选自己的 iPhone → ⌘R；
   首次运行手机拦截：设置 → 通用 → VPN 与设备管理 → 信任开发者证书。
4. **之后走局域网调试，不用插线**：Xcode → Window → Devices and Simulators → 选 iPhone →
   勾「Connect via network」，拔线。同一 Wi-Fi 下设备名旁出现网络标记，⌘R 直接无线安装。

命令行等价（本机已配对，`xcrun devicectl list devices` 可查）：

```bash
cd ios
xcodebuild -project Areco.xcodeproj -scheme Areco \
  -destination 'id=<xcodebuild -showdestinations 里的设备 id>' \
  -derivedDataPath /tmp/areco-dd-device -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=5L83JYDB49 build
xcrun devicectl device install app --device <devicectl 的 UUID> \
  /tmp/areco-dd-device/Build/Products/Debug-iphoneos/Areco.app
```

安装时手机要解锁（锁屏状态下 `devicectl process launch` 会报 Locked）。

## 手机端使用

- **不用填地址**：固定两个地址、固定顺序——先 `https://areco.gaochengbin.com`（公网，5 秒超时），
  不通再换 `http://gaodeMacBook-Pro.local:8790`（局域网，3 秒超时）。
  公网优先是因为 https 才有麦克风（语音输入）；局域网 http 是回退，那里点麦克风会提示环境不支持。
- **语音输入**：需要麦克风权限（首次点麦克风弹系统授权），仅公网 https 下可用。
- 右下角齿轮只在自动连不上、或要连别的机器时才用：可手动指定地址，也可切回「自动」。
- 首次会弹「本地网络」授权，局域网访问必须允许。
- 登录一次后 cookie 落盘，杀掉 App 再开仍是登录态；会话/终端数据都在 Mac 上，换手机不影响。
- 地址栏与浏览器 UI 不出现，全屏即座舱。

## 已知边界

- 个人签 7 天过期：App 打不开就连 Xcode ⌘R 重装。
- 锁屏后 WebView 会被系统挂起，实时终端输出暂停（回到前台自动重连，与浏览器切后台一致）。
  需要锁屏不断的话得改原生音频保活，areco 不是语音场景，暂不做。
- 取不到 APNs 推送：座舱是主动打开用的工具，不做通知。
- ATS 放开了任意明文（`NSAllowsArbitraryLoads`），只为局域网 http/ws；自用不过审。

## 目录

```
ios/
  project.yml          # xcodegen 定义（改这里再 generate）
  Info.plist
  Sources/ArecoApp.swift    # 入口、连接中/失败态、设置页
  Sources/WebAppView.swift  # WKWebView 封装、加载失败回调、弹窗/新窗口处理
  Sources/ServerStore.swift # 局域网→公网自动探测、地址规范化、上次可用模式
  Assets.xcassets/AppIcon.appiconset/icon-1024.png
```
