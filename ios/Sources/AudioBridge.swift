import AVFoundation
import UIKit
import WebKit

/// 原生音频通道：网页把 TTS 的 PCM 分片经 WKWebView 桥送进来，这里用 AVAudioEngine 播。
///
/// 为什么不直接用网页的 Web Audio：WKWebView 进后台时 WebAudio 上下文会被挂起，
/// 锁屏/切走后播报立刻断（2026-11-19 实测）。音频走原生引擎后，App 凭
/// UIBackgroundModes=audio 一直在播，锁屏也继续出声。
///
/// 协议（JS → 原生，message name = "arecoAudio"）：
///   { t: "start", id }            开始一句
///   { t: "chunk", id, b64 }       PCM16LE 单声道 24kHz 一片
///   { t: "end", id }              这一句送完，排空后回调
///   { t: "config", background }  是否锁屏继续播（设置页「锁屏继续播报」）
///   { t: "stop", id } / { t: "stopAll" }
/// 原生 → JS：window.__arecoAudioDone(id) / window.__arecoAudioFail(id, msg)
final class AudioBridge: NSObject, WKScriptMessageHandler {
    static let messageName = "arecoAudio"
    static let shared = AudioBridge()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// 保活用的静音循环：自动播报一打开就常驻播着，不等进后台、更不等一句播完。
    /// 没有这一路，队列一空系统就判「没在播音频」→ 挂起 App，网页收不到新消息
    private let silentNode = AVAudioPlayerNode()
    private var silentBuffer: AVAudioPCMBuffer?
    private var keepAlive = false
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24_000,
        channels: 1,
        interleaved: false
    )!
    private var ready = false
    private var attached = false
    /// 分片可能落在半个采样上：留一个字节接到下一片，字节错位会让整句变成电流声
    private var oddByte: [String: UInt8] = [:]
    private var sessionObservers: [NSObjectProtocol] = []
    /// 重建引擎时防止重入（路由变化常连发几次通知）
    private var rebuilding = false
    private var lastRebuild = Date.distantPast
    /// 锁屏/切后台是否继续播；关闭时一进后台就停引擎并释放音频会话
    private var backgroundEnabled = true
    /// 自动播报是否开着：只有开着才在后台保活，免得白耗电
    private var autoSpeak = false
    private var backgroundObserver: NSObjectProtocol?
    /// 原生自己播的句子（后台微信轮询）：播完调这里的闭包，不走 JS 回调
    private var nativeDone: [String: () -> Void] = [:]

    /// 网页可读的两个开关：后台微信轮询据此决定要不要接管
    var autoSpeakEnabled: Bool { autoSpeak }
    var backgroundAudioEnabled: Bool { backgroundEnabled }

    override init() {
        super.init()
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleEnterBackground()
        }

        // 耳机插拔、蓝牙接管、来电打断、媒体服务重启：硬件采样率会变，
        // 旧引擎还按老格式输出就是一片电流声，必须按新路由重建一次
        let center = NotificationCenter.default
        sessionObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.scheduleRebuild()
        })
        sessionObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            switch AVAudioSession.InterruptionType(rawValue: raw) {
            case .began:
                AppAudioSession.invalidate()
            case .ended:
                self?.scheduleRebuild(force: true)
            default:
                break
            }
        })
        sessionObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.scheduleRebuild(force: true)
        })
        // 引擎自己也会在硬件格式变化时停一下，这条一到必须重建
        sessionObservers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.scheduleRebuild(force: true)
        })
    }

    /// 每个 id 还有几个 buffer 没播完；收到 end 且归零才回调结束
    private var scheduled: [String: Int] = [:]
    private var ended: Set<String> = []
    private weak var webView: WKWebView?

    func attach(to webView: WKWebView) {
        self.webView = webView
        // 连续播报时不希望每次 start 都重启引擎，起一次、队列空了暂停播放节点
        guard !ready else { return }
        if !attached { buildGraph() }
        AppAudioSession.apply()
        do {
            try engine.start()
            ready = true
        } catch {
            ready = false
        }
    }

    /// 建图：24kHz 单声道 float 直接接混音器，硬件采样率由引擎自己转
    private func buildGraph() {
        engine.attach(player)
        engine.attach(silentNode)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.connect(silentNode, to: engine.mainMixerNode, format: format)
        // 0.5 秒静音，循环播；显式清零，别让未初始化内存变成噪声
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 12_000)!
        buffer.frameLength = 12_000
        if let channel = buffer.floatChannelData?[0] {
            for i in 0..<12_000 { channel[i] = 0 }
        }
        silentBuffer = buffer
        engine.prepare()
        attached = true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let body = message.body as? [String: Any],
              let type = body["t"] as? String else { return }
        if let view = message.webView { webView = view }

        switch type {
        case "config":
            if let enabled = body["background"] as? Bool {
                backgroundEnabled = enabled
                if enabled, autoSpeak { startKeepAlive() } else if !enabled { stopKeepAlive() }
                // 已经在后台又被关掉：立刻停，不等下一次进后台
                if !enabled, UIApplication.shared.applicationState != .active {
                    handleEnterBackground()
                }
            }
            if let auto = body["auto"] as? Bool {
                autoSpeak = auto
                // 一打开自动播报就起保活（前台也播着），不留「进后台那一刻才起」的空窗
                if auto, backgroundEnabled { startKeepAlive() } else { stopKeepAlive() }
            }
        case "start":
            guard let id = body["id"] as? String else { return }
            scheduled[id] = 0
            ended.remove(id)
            startEngineIfNeeded()
        case "chunk":
            guard let id = body["id"] as? String, let b64 = body["b64"] as? String else { return }
            guard let data = Data(base64Encoded: b64) else { return }
            enqueue(id: id, pcm: align(id: id, data: data))
        case "end":
            guard let id = body["id"] as? String else { return }
            ended.insert(id)
            finishIfDrained(id)
        case "stop":
            if let id = body["id"] as? String { stop(id) }
        case "stopAll":
            stopAll()
        case "wxwatch":
            // 后台微信轮询：网页进后台后定时器就停了，改由原生接管这段
            WxWatch.shared.sync(
                on: body["on"] as? Bool ?? false,
                session: body["session"] as? String,
                cursor: (body["cursor"] as? NSNumber)?.intValue,
                since: (body["since"] as? NSNumber)?.doubleValue
            )
        default:
            break
        }
    }

    /// 原生侧直接送一段 PCM16LE 24kHz：播完回调（后台微信播报用，不经过网页）
    func speakPCM(_ data: Data, onDone: @escaping () -> Void) {
        let id = "n-\(UUID().uuidString)"
        scheduled[id] = 0
        ended.remove(id)
        nativeDone[id] = onDone
        enqueue(id: id, pcm: align(id: id, data: data))
        ended.insert(id)
        finishIfDrained(id)
    }

    /// 壳内执行 JS（后台把已念时间戳回传给网页做去重）
    func evaluate(_ script: String) {
        callJS(script)
    }

    /// 音频会话被电话/其他 App 抢走后，回前台补一次（与 AppAudioSession 同口径）
    func reactivate() {
        AppAudioSession.apply()
        if !engine.isRunning {
            rebuildEngine()
            return
        }
        // 保活是常驻的：回前台不掉，只把静音循环重新排上（引擎重启后原循环可能已清空）
        if keepAlive {
            silentNode.stop()
            keepAlive = false
            startKeepAlive()
        }
    }

    /// 路由/打断变化后延迟重建一次，避开系统连发的几条通知。
    /// 没在出声、也没有保活时不折腾；硬件格式真变了，配置变更通知会强制重建。
    private func scheduleRebuild(force: Bool = false) {
        guard attached else { return }
        if !force, scheduled.isEmpty, !keepAlive { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.rebuildEngine()
        }
    }

    /// 按当前硬件重新建图并重启引擎：路由一变采样率就变，旧图继续跑就是电流声
    private func rebuildEngine() {
        guard attached, !rebuilding else { return }
        // 配置变更通知可能连发，短时间内只重建一次
        let now = Date()
        if now.timeIntervalSince(lastRebuild) < 2 { return }
        lastRebuild = now
        rebuilding = true
        defer { rebuilding = false }

        let wasKeepAlive = keepAlive
        let pending = Array(scheduled.keys)
        player.stop()
        silentNode.stop()
        engine.stop()
        engine.disconnectNodeInput(player)
        engine.disconnectNodeInput(silentNode)
        engine.detach(player)
        engine.detach(silentNode)
        attached = false
        ready = false
        keepAlive = false

        buildGraph()
        AppAudioSession.apply()
        do {
            try engine.start()
            ready = true
        } catch {
            ready = false
        }

        // 老队列已随 stop() 丢掉：把这几句收尾，别让网页一直等回调
        for id in pending {
            scheduled[id] = 0
            ended.insert(id)
            finishIfDrained(id)
        }
        if wasKeepAlive { startKeepAlive() }
    }

    /// 后台播放开关为关：进后台即清队列、停引擎、放掉音频会话，系统照常挂起 App
    private func handleEnterBackground() {
        guard backgroundEnabled else {
            scheduled.removeAll()
            ended.removeAll()
            stopKeepAlive()
            player.stop()
            engine.pause()
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            AppAudioSession.invalidate()
            return
        }
        // 自动播报开着：静音循环本来就该在跑，这里补一次防中途被系统清掉
        if autoSpeak { startKeepAlive() }
    }

    private func startKeepAlive() {
        guard ready, let buffer = silentBuffer else { return }
        if !engine.isRunning { try? engine.start() }
        guard !silentNode.isPlaying else { return }
        silentNode.scheduleBuffer(buffer, at: nil, options: .loops)
        silentNode.play()
        keepAlive = true
    }

    private func stopKeepAlive() {
        guard keepAlive else { return }
        keepAlive = false
        silentNode.stop()
        if scheduled.isEmpty { player.pause() }
    }

    // MARK: - 播放

    private func startEngineIfNeeded() {
        guard ready else { return }
        AppAudioSession.apply()
        if !engine.isRunning { try? engine.start() }
        if !player.isPlaying { player.play() }
    }

    private func enqueue(id: String, pcm: Data) {
        guard ready, let buffer = makeBuffer(pcm) else { return }
        startEngineIfNeeded()
        scheduled[id, default: 0] += 1
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, let left = self.scheduled[id] else { return }
                self.scheduled[id] = max(0, left - 1)
                self.finishIfDrained(id)
            }
        }
    }

    /// PCM16LE → AVAudioPCMBuffer（24kHz 单声道 Float32）
    private func makeBuffer(_ data: Data) -> AVAudioPCMBuffer? {
        let frames = data.count / 2
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<frames { channel[i] = Float(samples[i]) / 32768 }
        }
        return buffer
    }

    /// 把落在半个采样上的那一个字节留到下一片，保证每片都从采样边界开始。
    /// 网络分片按字节切，不管样本边界；错一个字节后整句都会被读成噪声。
    private func align(id: String, data: Data) -> Data {
        var bytes = data
        if let leftover = oddByte[id] {
            var merged = Data([leftover])
            merged.append(data)
            bytes = merged
            oddByte[id] = nil
        }
        if bytes.count % 2 == 1 {
            oddByte[id] = bytes.last
            bytes = Data(bytes.dropLast())
        }
        return bytes
    }

    private func finishIfDrained(_ id: String) {
        guard ended.contains(id), (scheduled[id] ?? 0) <= 0 else { return }
        ended.remove(id)
        scheduled[id] = nil
        oddByte[id] = nil
        // 队列空了就暂停播放节点，别让 engine 空转占着音频会话
        if scheduled.isEmpty { player.pause() }
        if let done = nativeDone.removeValue(forKey: id) {
            done()
            return
        }
        callJS("window.__arecoAudioDone && window.__arecoAudioDone(\(jsString(id)))")
    }

    private func stop(_ id: String) {
        scheduled[id] = nil
        ended.remove(id)
        // AVAudioPlayerNode 只能整体清队列：这一句的残余会一起丢，下一句重新排队
        queueClear()
    }

    private func stopAll() {
        scheduled.removeAll()
        ended.removeAll()
        let callbacks = nativeDone.values
        nativeDone.removeAll()
        queueClear()
        callbacks.forEach { $0() }
    }

    private func queueClear() {
        player.stop()
        if ready { player.play() }
    }

    private func callJS(_ script: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func jsString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
