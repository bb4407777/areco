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
    /// 后台保活用的静音循环：没有这一路，播完一句队列空了系统就判「没在播音频」→ 挂起 App，
    /// 网页收不到新消息，自动播报自然不触发
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
    /// 锁屏/切后台是否继续播；关闭时一进后台就停引擎并释放音频会话
    private var backgroundEnabled = true
    /// 自动播报是否开着：只有开着才在后台保活，免得白耗电
    private var autoSpeak = false
    private var backgroundObserver: NSObjectProtocol?

    override init() {
        super.init()
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleEnterBackground()
        }
    }

    /// 每个 id 还有几个 buffer 没播完；收到 end 且归零才回调结束
    private var scheduled: [String: Int] = [:]
    private var ended: Set<String> = []
    private weak var webView: WKWebView?

    func attach(to webView: WKWebView) {
        self.webView = webView
        // 连续播报时不希望每次 start 都重启引擎，起一次、队列空了暂停播放节点
        guard !ready else { return }
        if !attached {
            engine.attach(player)
            engine.attach(silentNode)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            engine.connect(silentNode, to: engine.mainMixerNode, format: format)
            // 0.5 秒静音，循环播；数据默认清零即静音，不会出声
            silentBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 12_000)
            silentBuffer?.frameLength = 12_000
            engine.prepare()
            attached = true
        }
        do {
            try engine.start()
            ready = true
        } catch {
            ready = false
        }
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
                // 已经在后台又被关掉：立刻停，不等下一次进后台
                if !enabled, UIApplication.shared.applicationState != .active {
                    handleEnterBackground()
                }
            }
            if let auto = body["auto"] as? Bool {
                autoSpeak = auto
                if auto, backgroundEnabled, UIApplication.shared.applicationState != .active {
                    startKeepAlive()
                } else if !auto {
                    stopKeepAlive()
                }
            }
        case "start":
            guard let id = body["id"] as? String else { return }
            scheduled[id] = 0
            ended.remove(id)
            startEngineIfNeeded()
        case "chunk":
            guard let id = body["id"] as? String, let b64 = body["b64"] as? String else { return }
            guard let data = Data(base64Encoded: b64) else { return }
            enqueue(id: id, pcm: data)
        case "end":
            guard let id = body["id"] as? String else { return }
            ended.insert(id)
            finishIfDrained(id)
        case "stop":
            if let id = body["id"] as? String { stop(id) }
        case "stopAll":
            stopAll()
        default:
            break
        }
    }

    /// 音频会话被电话/其他 App 抢走后，回前台补一次（与 AppAudioSession 同口径）
    func reactivate() {
        stopKeepAlive()
        AppAudioSession.apply()
        if ready && !engine.isRunning { try? engine.start() }
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
            return
        }
        // 自动播报开着：留一路静音循环，App 不被挂起，网页才能继续收消息、继续播
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

    private func finishIfDrained(_ id: String) {
        guard ended.contains(id), (scheduled[id] ?? 0) <= 0 else { return }
        ended.remove(id)
        scheduled[id] = nil
        // 队列空了就暂停播放节点，别让 engine 空转占着音频会话
        if scheduled.isEmpty { player.pause() }
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
        queueClear()
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
