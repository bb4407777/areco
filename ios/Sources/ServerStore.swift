import Foundation
import Combine
import UIKit

struct Endpoint: Equatable {
    let url: URL
}

/// 只走公网：https 是安全上下文，麦克风（语音输入）只有这条线能用；也不做局域网回退。
/// 连不上就每 1 秒重探一次、不限轮数，不用手点重连（2026-11-19 高律师令）。
@MainActor
final class ServerStore: ObservableObject {
    enum Phase: Equatable {
        case probing
        case ready
        case failed(String)
    }

    static let publicURL = URL(string: "https://areco.gaochengbin.com")!

    private static let retryInterval: TimeInterval = 1

    @Published private(set) var phase: Phase = .probing
    @Published private(set) var active: Endpoint?
    /// 每次 resolve 递增：手动「立即重试」与自动重连并发时，只让最后一次生效，避免两边互相覆盖
    private var resolveGeneration = 0

    init() {
        // 回到前台若还停在失败页，立刻再连，不用等下一轮
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

    func resolve() async {
        resolveGeneration &+= 1
        let generation = resolveGeneration
        phase = .probing
        active = nil

        var first = true
        while generation == resolveGeneration {
            // 首轮给足时间，之后收紧——探不通时约 1 秒一轮
            if await probe(Self.publicURL, timeout: first ? 5 : 2) {
                guard generation == resolveGeneration else { return }
                activate(Endpoint(url: Self.publicURL))
                return
            }
            first = false
            phase = .failed("公网连不上，正在自动重连…")
            guard await waitRetry(generation: generation) else { return }
        }
    }

    /// 隔 1 秒再探。返回 false 表示已有新的 resolve 接管，调用方直接退出
    private func waitRetry(generation: Int) async -> Bool {
        try? await Task.sleep(nanoseconds: UInt64(Self.retryInterval * 1_000_000_000))
        return generation == resolveGeneration
    }

    /// WebView 加载失败：同样每 1 秒重探公网，直到连上
    func handlePageFailure() {
        resolveGeneration &+= 1
        let generation = resolveGeneration
        Task { [weak self] in
            guard let self else { return }
            var first = true
            while generation == self.resolveGeneration {
                if await self.probe(Self.publicURL, timeout: first ? 3 : 2) {
                    guard generation == self.resolveGeneration else { return }
                    self.activate(Endpoint(url: Self.publicURL))
                    return
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
}
