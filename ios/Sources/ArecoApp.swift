import AVFoundation
import SwiftUI

@main
struct ArecoApp: App {
    @StateObject private var store = ServerStore()
    @Environment(\.scenePhase) private var scenePhase
    /// 网页当前主题：前端 applyTheme 经 arecoTheme 桥回传。原生外观（状态栏、键盘、设置页、底色）
    /// 一律跟网页走，默认浅色——壳里曾硬编码 .dark，网页浅色时顶部状态栏和键盘却是黑的（2026-11-07 报障）
    @State private var webTheme = "light"

    init() {
        AppAudioSession.apply()
    }

    var body: some Scene {
        WindowGroup {
            ContentView(webTheme: $webTheme)
                .environmentObject(store)
                .preferredColorScheme(webTheme == "dark" ? .dark : .light)
                .task { await store.resolve() }
                .onChange(of: scenePhase) { phase in
                    // WebKit 播放媒体时可能把类别改回 ambient，回前台重设一次
                    if phase == .active { AppAudioSession.apply() }
                }
        }
    }
}

enum AppAudioSession {
    /// WKWebView 里的音频默认走 ambient，iPhone 侧边静音开关一拨就没声；
    /// playback 类别不受静音键影响，播报在静音模式下也能出声。
    static func apply() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: ServerStore
    @Binding var webTheme: String

    /// 与前端 --bar 同色（浅 #ffffff / 深 #141419）：状态栏那条缝隙与网页顶栏无缝
    private var shellBackground: Color {
        webTheme == "dark" ? Color(red: 0.078, green: 0.078, blue: 0.098) : .white
    }

    var body: some View {
        ZStack {
            shellBackground.ignoresSafeArea()

            switch store.phase {
            case .probing:
                ProgressView("正在连接…")
                    .foregroundStyle(.secondary)
            case .failed(let message):
                failureView(message)
            case .ready:
                if let endpoint = store.active {
                    WebAppView(url: endpoint.url, theme: $webTheme) {
                        store.handlePageFailure(of: endpoint)
                    }
                    .id(endpoint.url)
                    .ignoresSafeArea(.container, edges: .bottom)
                }
            }
        }
    }

    private func failureView(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
            Text(message)
                .foregroundStyle(.secondary)
            // 自动重连每 5 秒一轮，这里只是不想等时手动催一下
            Button("立即重试") {
                Task { await store.resolve() }
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
