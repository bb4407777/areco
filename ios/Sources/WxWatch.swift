import Foundation
import UIKit
import WebKit

/// 微信自动播报的后台兜底。
///
/// WKWebView 一进后台，网页里的 5 秒轮询就停了（WebContent 进程被挂起），
/// 新消息既到不了页面、也触发不了播报——App 有后台音频权限也没用，那只保住 App 进程。
/// 所以后台这段由原生按同一接口自己轮询：取到新的 assistant 正文 → /api/tts 合成 →
/// AVAudioEngine 直接播。前台仍归网页自己轮询，原生只在后台接管。
///
/// 网页通过 arecoAudio 桥的 `{ t: "wxwatch", on, session, cursor }` 告知当前会话与已载条数；
/// 原生念完把最大时间戳回传 `window.__arecoWxSpoken(ts)`，前台补载时按它跳过，避免重念。
final class WxWatch {
    static let shared = WxWatch()

    private let host = "areco.gaochengbin.com"

    private var enabled = false
    private var session: String?
    private var cursor = 0
    /// 网页点「自动播报」的时刻（毫秒）：只念这之后到的消息，历史不碰
    private var since: Double = 0
    private var timer: Timer?
    private var polling = false
    private var speaking = false
    private var pending: [String] = []
    private var cookies: [HTTPCookie] = []
    /// 已在后台念过的最大消息时间戳（毫秒）；回前台报给网页做去重
    private var spokenMaxTs: Double = 0

    private init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleForeground),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    // MARK: - 网页同步过来的状态

    func sync(on: Bool, session: String?, cursor: Int?, since: Double?) {
        self.enabled = on
        if let session { self.session = session }
        else if !on { self.session = nil }
        if let cursor { self.cursor = cursor }
        if let since { self.since = since }
        refreshTimer()
    }

    // MARK: - 生命周期

    @objc private func handleBackground() {
        refreshTimer()
    }

    @objc private func handleForeground() {
        stopTimer()
        // 把后台念过的时间戳交给网页，让它补载时不再重念
        if spokenMaxTs > 0 {
            AudioBridge.shared.evaluate("window.__arecoWxSpoken && window.__arecoWxSpoken(\(Int64(spokenMaxTs)))")
        }
    }

    private func refreshTimer() {
        let bg = UIApplication.shared.applicationState != .active
        let shouldRun = enabled
            && bg
            && session != nil
            && AudioBridge.shared.autoSpeakEnabled
            && AudioBridge.shared.backgroundAudioEnabled
        if shouldRun { startTimer() } else { stopTimer() }
    }

    private func startTimer() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.poll()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        poll()
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: - 轮询

    private func poll() {
        guard !polling, let session, let url = transcriptURL(session: session, cursor: cursor) else { return }
        polling = true
        loadCookies { [weak self] in
            guard let self else { return }
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            let cookie = self.cookieHeader()
            if !cookie.isEmpty { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
            URLSession.shared.dataTask(with: request) { data, _, _ in
                defer { DispatchQueue.main.async { self.polling = false } }
                guard let data, let page = Self.parseTranscript(data, since: self.since) else { return }
                DispatchQueue.main.async {
                    self.cursor = page.cursor
                    for text in page.texts { self.enqueueSpeech(text) }
                }
            }.resume()
        }
    }

    private func transcriptURL(session: String, cursor: Int) -> URL? {
        let encoded = session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? session
        return URL(string: "https://\(host)/api/weixin/sessions/\(encoded)/transcript?cursor=\(cursor)")
    }

    private struct Page {
        var cursor: Int
        var texts: [String]
        var maxTs: Double
    }

    private static func parseTranscript(_ data: Data, since: Double) -> Page? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = root["data"] as? [String: Any] else { return nil }
        let rows = payload["messages"] as? [[String: Any]] ?? []
        let next = (payload["cursor"] as? NSNumber)?.intValue ?? 0
        var texts: [String] = []
        var maxTs: Double = 0
        for row in rows {
            let ms = messageMs(row["timestamp"])
            maxTs = max(maxTs, ms)
            guard (row["role"] as? String) == "assistant" else { continue }
            // 点「自动播报」之前的旧消息不念（没带时间戳的照念，宁可多念不漏）
            if since > 0, ms > 0, ms < since { continue }
            let parts = row["parts"] as? [[String: Any]] ?? []
            let text = parts
                .filter { ($0["kind"] as? String) == "text" }
                .compactMap { ($0["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
            if !text.isEmpty { texts.append(text) }
        }
        return Page(cursor: next, texts: texts, maxTs: maxTs)
    }

    /// 服务端给 ISO 字符串；旧的给秒/毫秒数字，两种都吃
    private static func messageMs(_ raw: Any?) -> Double {
        if let n = raw as? NSNumber {
            let v = n.doubleValue
            return v < 1_000_000_000_000 ? v * 1000 : v
        }
        if let text = raw as? String {
            if let date = isoFractional.date(from: text) ?? isoPlain.date(from: text) {
                return date.timeIntervalSince1970 * 1000
            }
        }
        return 0
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    // MARK: - 播报

    /// 串行播：一条消息的句子合成完一句播一句，避免整段等合成
    private func enqueueSpeech(_ text: String) {
        pending.append(contentsOf: Self.chunks(text))
        pump()
    }

    private func pump() {
        guard !speaking else { return }
        guard !pending.isEmpty else {
            reportSpoken()
            return
        }
        speaking = true
        let sentence = pending.removeFirst()
        synthesize(sentence) { [weak self] data in
            guard let self else { return }
            guard let data, !data.isEmpty else {
                self.speaking = false
                DispatchQueue.main.async { self.pump() }
                return
            }
            AudioBridge.shared.speakPCM(data) {
                DispatchQueue.main.async {
                    self.speaking = false
                    self.pump()
                }
            }
        }
    }

    private func synthesize(_ text: String, done: @escaping (Data?) -> Void) {
        guard let url = URL(string: "https://\(host)/api/tts") else { return done(nil) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let cookie = cookieHeader()
        if !cookie.isEmpty { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
        URLSession.shared.dataTask(with: request) { data, _, _ in
            done(data)
        }.resume()
    }

    /// 按句切，单片不超过 ~140 字：首句合成完就能开口
    private static func chunks(_ text: String, limit: Int = 140) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            let isBreak = "。！？!?；;\n".contains(ch)
            if isBreak || current.count >= limit {
                let piece = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !piece.isEmpty { out.append(piece) }
                current = ""
            }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { out.append(tail) }
        return out
    }

    private func reportSpoken() {
        // 真正播完才记账：中断的不算，前台补载时仍会念
        spokenMaxTs = max(spokenMaxTs, Date().timeIntervalSince1970 * 1000)
    }

    // MARK: - 会话凭证

    private func loadCookies(_ then: @escaping () -> Void) {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { list in
            self.cookies = list.filter { $0.domain.contains("gaochengbin.com") }
            then()
        }
    }

    private func cookieHeader() -> String {
        cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }
}
