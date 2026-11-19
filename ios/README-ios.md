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

本机现用机：iPhone 14 Pro Max（iOS 16.6.1，UDID `00008120-001849343AE0C01E`），**先走 USB 有线**。
iOS 16 不支持 `devicectl`（CoreDevice 只支持 iOS 17+），装 App 用：

```bash
ios-deploy --id 00008120-001849343AE0C01E --bundle <Areco.app> --no-wifi --justlaunch
```

`devicectl` 报「device locked / DDI 挂载失败」时先查是不是走成了无线（`xcrun xcdevice list` 看 `interface`）。

## 手机端使用

- **只连公网**：固定 `https://areco.gaochengbin.com`，不用填地址、也没有局域网回退；https 是安全上下文，
  麦克风（语音输入）只有这条线能用。
- **自动重连**：探不通不设次数上限——失败后每 1 秒自动再探一次（首轮超时 5 秒，之后收紧到 2 秒），
  网络刚切换、Mac 刚唤醒的几十秒基本能自己连上；回到前台若还停在失败页，也会立刻再连。
- **语音输入**：需要麦克风权限（首次点麦克风弹系统授权），仅公网 https 下可用。
- **后台播放**：Info.plist 已开 `UIBackgroundModes=audio`，音频会话为 `.playback`；锁屏／切走后播报继续。
- **后台新消息**：WKWebView 进后台定时器会停，微信自动播报改由原生接管——`WxWatch.swift` 按同一接口每 5 秒轮询当前会话，取到新的 assistant 正文直接调 `/api/tts` 交给 `AVAudioEngine` 播；回前台把已念时间戳报给网页，补载时只上屏不重念。
- **没有设置页、没有齿轮**：地址全自动，连不上就等它自己连（失败页上的「立即重试」只是不想等时催一下）。
- 登录一次后 cookie 落盘，杀掉 App 再开仍是登录态；会话/终端数据都在 Mac 上，换手机不影响。
- 地址栏与浏览器 UI 不出现，全屏即座舱。

## 已知边界

- 个人签 7 天过期：App 打不开就连 Xcode ⌘R 重装。
- 锁屏后 WebView 会被系统挂起，实时终端输出暂停（回到前台自动重连，与浏览器切后台一致）。
  需要锁屏不断的话得改原生音频保活，areco 不是语音场景，暂不做。
- 取不到 APNs 推送：座舱是主动打开用的工具，不做通知。
- ATS 放开了任意明文（`NSAllowsArbitraryLoads`）与本地网络用途说明，都是走局域网时期的遗留，保留不影响只走公网的现行为。

## 目录

```
ios/
  project.yml          # xcodegen 定义（改这里再 generate）
  Info.plist
  Sources/ArecoApp.swift    # 入口、连接中/失败态
  Sources/WebAppView.swift  # WKWebView 封装、加载失败回调、弹窗/新窗口处理
  Sources/ServerStore.swift # 只走公网、每 1 秒无限重试
  Sources/AudioBridge.swift # 原生音频通道（PCM 播放、静音保活、后台开关）
  Sources/WxWatch.swift     # 后台微信轮询代播
  Assets.xcassets/AppIcon.appiconset/icon-1024.png
```
