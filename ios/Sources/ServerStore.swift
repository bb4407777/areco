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

    /// 重试节奏：一轮＝公网→局域网各探一次，探不通就报「正在重连」并隔 5 秒再来，不限轮数。
    /// 网络刚切（Wi-Fi↔蜂窝）、Mac 刚唤醒、公网隧道刚起时头几轮探不通很正常，
    /// 隔 5 秒自己再试就能连上，不用手点「重连」（2026-11-19 高律师令）。
    private static let retryInterval: TimeInterval = 5

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
            var first = true
            while generation == resolveGeneration {
                if await probe(custom, timeout: first ? 5 : 3) {
                    guard generation == resolveGeneration else { return }
                    activate(Endpoint(url: custom, mode: .custom))
                    return
                }
                first = false
                phase = .failed("填写的地址连不上，正在自动重连…")
                guard await waitRetry(generation: generation) else { return }
            }
            return
        }

        var first = true
        while generation == resolveGeneration {
            // 首轮给足时间，之后每次都收紧，重试不把等待拖太长
            if await probe(Self.publicURL, timeout: first ? 5 : 3) {
                guard generation == resolveGeneration else { return }
                activate(Endpoint(url: Self.publicURL, mode: .wan))
                return
            }
            if await probe(Self.lanURL, timeout: first ? 3 : 2) {
                guard generation == resolveGeneration else { return }
                activate(Endpoint(url: Self.lanURL, mode: .lan))
                return
            }
            first = false
            phase = .failed("公网和局域网都没连上，正在自动重连…")
            guard await waitRetry(generation: generation) else { return }
        }
    }

    /// 隔 5 秒再探一轮。返回 false 表示已有新的 resolve 接管，调用方直接退出
    private func waitRetry(generation: Int) async -> Bool {
        try? await Task.sleep(nanoseconds: UInt64(Self.retryInterval * 1_000_000_000))
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

    /// WebView 加载失败：先原路重探（公网挂了退局域网），探不通就每 5 秒再来，直到连上
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

            var first = true
            while generation == self.resolveGeneration {
                for (url, mode) in targets {
                    if await self.probe(url, timeout: first ? 3 : 2) {
                        guard generation == self.resolveGeneration else { return }
                        self.activate(Endpoint(url: url, mode: mode))
                        return
                    }
                }
                first = false
                self.phase = .failed("页面打不开，正在自动重连…")
                guard await self.waitRetry(generation: generation) else { return }
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
