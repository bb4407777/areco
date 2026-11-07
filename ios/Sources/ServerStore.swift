import Foundation
import Combine

/// 服务器地址的唯一存放点：UserDefaults 持久化，改动即生效（ContentView 用 .id 重建 WebView）。
/// 默认为公网域名；局域网 / Tailscale 地址在设置页手填。
final class ServerStore: ObservableObject {
    private static let key = "areco.baseURL"
    static let fallback = "https://areco.gaochengbin.com"

    @Published var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: Self.key) }
    }

    init() {
        baseURL = UserDefaults.standard.string(forKey: Self.key) ?? Self.fallback
    }

    var url: URL? { Self.normalize(baseURL) }

    /// 补协议头：手填 `192.168.5.152:8790` 这类地址时不能默认成 https（局域网没有证书）。
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
