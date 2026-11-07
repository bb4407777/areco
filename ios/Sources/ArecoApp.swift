import AVFoundation
import SwiftUI

@main
struct ArecoApp: App {
    @StateObject private var store = ServerStore()
    /// 网页当前主题：前端 applyTheme 经 arecoTheme 桥回传。原生外观（状态栏、键盘、设置页、底色）
    /// 一律跟网页走——壳里曾硬编码 .dark，网页浅色时顶部状态栏和键盘却是黑的（2026-11-07 报障）
    @State private var webTheme = "light"

    init() {
        // WKWebView 里的 WebAudio 默认走 ambient，iPhone 侧边静音开关一拨就没声；
        // 改成 playback 类别，播报不受静音键影响。
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            ContentView(webTheme: $webTheme)
                .environmentObject(store)
                .preferredColorScheme(webTheme == "dark" ? .dark : .light)
                .task { await store.resolve() }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: ServerStore
    @Binding var webTheme: String
    @State private var showSettings = false

    /// 与前端 --bar 同色（浅 #ffffff / 深 #141419）：状态栏那条缝隙与网页顶栏无缝
    private var shellBackground: Color {
        webTheme == "dark" ? Color(red: 0.078, green: 0.078, blue: 0.098) : .white
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
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

            settingsButton
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(store)
        }
    }

    private func failureView(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
            Text(message)
                .foregroundStyle(.secondary)
            Button("重试") {
                Task { await store.resolve() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var settingsButton: some View {
        Button {
            showSettings = true
        } label: {
            Image(systemName: "gearshape.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 44, height: 44)
                .background(.black.opacity(0.45), in: Circle())
        }
        .padding(.trailing, 14)
        .padding(.bottom, 20)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: ServerStore
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String = ""
    @State private var errorText: String?

    var body: some View {
        NavigationView {
            Form {
                Section {
                    HStack {
                        Text("当前连接")
                        Spacer()
                        Text(currentText)
                            .foregroundStyle(.secondary)
                            .font(.footnote)
                    }
                }

                Section {
                    Button("自动（局域网优先，不通走公网）") {
                        store.useAuto()
                        Task { await store.resolve() }
                        dismiss()
                    }
                    Button("重连") {
                        Task { await store.resolve() }
                        dismiss()
                    }
                } footer: {
                    Text("默认就是自动：先连同一 Wi-Fi 下的 Mac（\(ServerStore.lanURL.host ?? "")），不通再走公网 \(ServerStore.publicURL.host ?? "")。正常情况下不用打开这个页面。")
                }

                Section {
                    TextField("https://areco.gaochengbin.com", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                    Button("使用这个地址") {
                        guard ServerStore.normalize(draft) != nil else {
                            errorText = "地址格式不对"
                            return
                        }
                        store.saveCustom(draft)
                        Task { await store.resolve() }
                        dismiss()
                    }
                } header: {
                    Text("手动指定（压过自动）")
                } footer: {
                    Text("只在自动连不上、或要连别的机器时填。不写协议头时 IP 按 http、域名按 https。")
                }
            }
            .navigationTitle("设置")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .alert("地址无效", isPresented: Binding(
                get: { errorText != nil },
                set: { if !$0 { errorText = nil } }
            )) {
                Button("好", role: .cancel) { errorText = nil }
            }
            .onAppear { draft = store.customURL }
        }
    }

    private var currentText: String {
        switch store.phase {
        case .probing:
            return "连接中…"
        case .failed:
            return "未连接"
        case .ready:
            guard let active = store.active else { return "未连接" }
            return "\(active.mode.label) · \(active.url.host ?? "")"
        }
    }
}
