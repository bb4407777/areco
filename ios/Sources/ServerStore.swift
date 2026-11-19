import Foundation
import Combine
import UIKit

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

    /// 自动连接的重试节奏：一轮＝公网→局域网各探一次，轮间留空档再探。
    /// 网络刚切（Wi-Fi↔蜂窝）、Mac 刚唤醒、公网隧道刚起时，头一两轮常常探不通，
    /// 隔几秒再探就通了，一轮就报失败会逼用户手点「重连」（2026-11-19 高律师令）。
    private static let maxAttempts = 4
    private static let retryDelays: [TimeInterval] = [1.5, 3, 4.5]
    private static let pageFailureAttempts = 3

    @Published private(set) var phase: Phase = .probing
    @Published private(set) var active: Endpoint?
    @Published var customURL: String
    /// 每次 resolve 递增：手动「重试」与自动重连并发时，只让最后一次生效，避免两边互相覆盖
    private var resolveGeneration = 0

    init() {
        customURL = UserDefaults.standard.string(forKey: Self.customKey) ?? ""
        // 回到前台若还停在失败页，自动再连，不用进设置页点「重连」
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, case .failed = self.phase else { return }
                await self.resolve()
            }
        }
    }

    var isAuto: Bool { customURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func resolve() async {
        resolveGeneration &+= 1
        let generation = resolveGeneration
        phase = .probing
        active = nil

        if let custom = Self.normalize(customURL) {
            for attempt in 0..<Self.maxAttempts {
                if generation != resolveGeneration { return }
                if await probe(custom, timeout: attempt == 0 ? 5 : 3) {
                    guard generation == resolveGeneration else { return }
                    activate(Endpoint(url: custom, mode: .custom))
                    return
                }
                guard await linger(attempt, generation: generation) else { return }
            }
            phase = .failed("填写的地址连不上（已重试 \(Self.maxAttempts) 次）")
            return
        }

        for attempt in 0..<Self.maxAttempts {
            if generation != resolveGeneration { return }
            // 首轮给足时间，之后每次都收紧，免得重试把等待拖得太长
            if await probe(Self.publicURL, timeout: attempt == 0 ? 5 : 3) {
                guard generation == resolveGeneration else { return }
                activate(Endpoint(url: Self.publicURL, mode: .wan))
                return
            }
            if await probe(Self.lanURL, timeout: attempt == 0 ? 3 : 2) {
                guard generation == resolveGeneration else { return }
                activate(Endpoint(url: Self.lanURL, mode: .lan))
                return
            }
            guard await linger(attempt, generation: generation) else { return }
        }

        phase = .failed("公网和局域网都没连上（已重试 \(Self.maxAttempts) 次）")
    }

    /// 轮间空档。返回 false 表示已有一轮新的 resolve 接管，调用方直接退出
    private func linger(_ attempt: Int, generation: Int) async -> Bool {
        guard attempt < Self.retryDelays.count else { return true }
        try? await Task.sleep(nanoseconds: UInt64(Self.retryDelays[attempt] * 1_000_000_000))
        return generation == resolveGeneration
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

    /// WebView 加载失败：先原路重探，公网挂了就退局域网，几轮都探不通才判失败
    func handlePageFailure(of endpoint: Endpoint) {
        resolveGeneration &+= 1
        let generation = resolveGeneration
        Task { [weak self] in
            guard let self else { return }
            // 自定义地址先重试自己，再按老规矩退局域网
            let targets: [(URL, ServerMode)] = switch endpoint.mode {
            case .lan: [(Self.lanURL, .lan)]
            case .wan: [(Self.publicURL, .wan), (Self.lanURL, .lan)]
            case .custom: [(endpoint.url, .custom), (Self.lanURL, .lan)]
            }

            for attempt in 0..<Self.pageFailureAttempts {
                if generation != self.resolveGeneration { return }
                for (url, mode) in targets {
                    if await self.probe(url, timeout: attempt == 0 ? 3 : 2) {
                        guard generation == self.resolveGeneration else { return }
                        self.activate(Endpoint(url: url, mode: mode))
                        return
                    }
                }
                guard await self.linger(attempt, generation: generation) else { return }
            }

            guard generation == self.resolveGeneration else { return }
            phase = .failed(
                endpoint.mode == .lan
                    ? "局域网也打不开页面（已重试 \(Self.pageFailureAttempts) 次）"
                    : "公网与局域网都打不开页面（已重试 \(Self.pageFailureAttempts) 次）"
            )
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
