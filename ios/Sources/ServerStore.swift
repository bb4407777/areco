import Foundation
import Combine

enum ServerMode: String {
    case lan, wan, custom

    var label: String {
        switch self {
        case .lan: return "局域网"
        case .wan: return "公网"
        case .custom: return "自填"
        }
    }
}

struct Endpoint: Equatable {
    let url: URL
    let mode: ServerMode
}

/// 服务器地址不再手填：固定两个地址、固定顺序——先公网 https，不通再局域网。
///   公网是 Cloudflare 域名，https 是安全上下文，麦克风（语音输入）只有这条线能用；
///   局域网 mDNS 名是 http，WebKit 不给麦克风，只作回退。
/// 手填地址仍然保留，填了就压过自动逻辑（出差/临时换机时用）。
@MainActor
final class ServerStore: ObservableObject {
    enum Phase: Equatable {
        case probing
        case ready
        case failed(String)
    }

    static let lanURL = URL(string: "http://gaodeMacBook-Pro.local:8790")!
    static let publicURL = URL(string: "https://areco.gaochengbin.com")!
    private static let customKey = "areco.customURL"

    @Published private(set) var phase: Phase = .probing
    @Published private(set) var active: Endpoint?
    @Published var customURL: String

    init() {
        customURL = UserDefaults.standard.string(forKey: Self.customKey) ?? ""
    }

    var isAuto: Bool { customURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func resolve() async {
        phase = .probing
        active = nil

        if let custom = Self.normalize(customURL) {
            activate(Endpoint(url: custom, mode: .custom))
            return
        }

        if await probe(Self.publicURL, timeout: 5) {
            activate(Endpoint(url: Self.publicURL, mode: .wan))
            return
        }

        if await probe(Self.lanURL, timeout: 3) {
            activate(Endpoint(url: Self.lanURL, mode: .lan))
            return
        }

        phase = .failed("公网和局域网都没连上")
    }

    func saveCustom(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(trimmed, forKey: Self.customKey)
        customURL = trimmed
    }

    func useAuto() {
        UserDefaults.standard.removeObject(forKey: Self.customKey)
        customURL = ""
    }

    /// WebView 加载失败：公网挂了就退局域网，局域网也挂了才算真失败
    func handlePageFailure(of endpoint: Endpoint) {
        guard endpoint.mode != .lan else {
            phase = .failed("局域网也打不开页面")
            return
        }
        Task {
            if await probe(Self.lanURL, timeout: 3) {
                activate(Endpoint(url: Self.lanURL, mode: .lan))
            } else {
                phase = .failed("公网与局域网都打不开页面")
            }
        }
    }

    private func activate(_ endpoint: Endpoint) {
        active = endpoint
        phase = .ready
    }

    private func probe(_ base: URL, timeout: TimeInterval) async -> Bool {
        var request = URLRequest(url: base.appendingPathComponent("healthz"))
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            // 401/302 都说明服务在（只是要登录）；只有连不上或 5xx 才算不通
            return (200..<500).contains(http.statusCode)
        } catch {
            return false
        }
    }

    /// 手填地址补协议头：`192.168.5.152:8790` 这类地址不能默认 https（局域网没证书）
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            let host = s.split(separator: "/").first.map(String.init) ?? s
            let bareHost = host.split(separator: ":").first.map(String.init) ?? host
            let looksLikeIP = bareHost.first?.isNumber == true
            let isLocal = bareHost.hasSuffix(".local")
            s = (looksLikeIP || isLocal ? "http://" : "https://") + s
        }
        return URL(string: s)
    }
}
