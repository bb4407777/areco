import SwiftUI

@main
struct ArecoApp: App {
    @StateObject private var store = ServerStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .task { await store.resolve() }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: ServerStore
    @State private var showSettings = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color(red: 0.06, green: 0.06, blue: 0.08).ignoresSafeArea()

            switch store.phase {
            case .probing:
                ProgressView("正在连接…")
                    .tint(.white)
                    .foregroundStyle(.secondary)
            case .failed(let message):
                failureView(message)
            case .ready:
                if let endpoint = store.active {
                    WebAppView(url: endpoint.url) {
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
                    Text("默认就是自动：先连同一 Wi-Fi 下的 Mac（\(ServerStore.lanCandidates[0].host ?? "")），不通再走公网域名。正常情况下不用打开这个页面。")
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
