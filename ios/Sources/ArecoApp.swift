import SwiftUI

@main
struct ArecoApp: App {
    @StateObject private var store = ServerStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: ServerStore
    @State private var showSettings = false
    @State private var reloadToken = 0
    @State private var webKey = UUID()

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color(red: 0.06, green: 0.06, blue: 0.08).ignoresSafeArea()

            if let url = store.url {
                WebAppView(url: url, reloadToken: reloadToken)
                    .id(webKey)
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                Text("服务器地址无效，点右下角设置")
                    .foregroundStyle(.secondary)
            }

            settingsButton
        }
        .sheet(isPresented: $showSettings) {
            SettingsView { applied in
                if applied {
                    reloadToken += 1
                    webKey = UUID()
                }
                showSettings = false
            }
            .environmentObject(store)
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

    let onApply: (Bool) -> Void

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("https://areco.gaochengbin.com", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("同一 Wi-Fi 填局域网地址（如 http://192.168.5.152:8790），外网填公网域名。不写协议头时，IP 地址按 http、域名按 https。")
                }

                Section {
                    Button("保存并重载") {
                        guard ServerStore.normalize(draft) != nil else {
                            errorText = "地址格式不对"
                            return
                        }
                        store.baseURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        onApply(true)
                    }
                    Button("恢复默认（公网域名）") {
                        store.baseURL = ServerStore.fallback
                        draft = ServerStore.fallback
                        onApply(true)
                    }
                    Button("仅重载当前页面") {
                        onApply(true)
                    }
                }

                Section {
                    Text("当前生效：\(store.baseURL)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
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
        }
        .onAppear { draft = store.baseURL }
    }
}
