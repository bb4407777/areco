import SwiftUI
import WebKit

/// areco 座舱的 WebView 壳：前端本身就是完整 PWA（会话/终端/微信/进程），
/// 原生端只负责装它、自动选服务器、处理登录 cookie 与弹窗，不重写业务 UI。
struct WebAppView: UIViewRepresentable {
    let url: URL
    /// 网页当前主题（前端 applyTheme 经 arecoTheme 桥上送），原生外观据此跟随
    @Binding var theme: String
    /// 首次加载失败（局域网不通 / 服务没起）时回调，由 ServerStore 决定退公网还是报错
    let onLoadFailure: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(theme: $theme, onLoadFailure: onLoadFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "arecoTheme")
        // 默认 websiteDataStore = .default()，登录 cookie 落盘，杀掉 App 再开仍是登录态
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // 键盘外观跟网页主题走，不跟系统（系统深色 + 网页浅色时键盘不会突兀变黑）
        webView.overrideUserInterfaceStyle = theme == "dark" ? .dark : .light
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.theme = $theme
        webView.overrideUserInterfaceStyle = theme == "dark" ? .dark : .light
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "arecoTheme")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        /// 网页主题回传，更新 App 级 colorScheme（状态栏文字、弹窗、设置页一起跟）
        var theme: Binding<String>
        private let onLoadFailure: () -> Void
        /// 同一次加载只回调一次：didFailProvisional 之后还会来 didFail，避免连退两次
        private var reportedFailure = false

        init(theme: Binding<String>, onLoadFailure: @escaping () -> Void) {
            self.theme = theme
            self.onLoadFailure = onLoadFailure
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "arecoTheme", let raw = message.body as? String else { return }
            let next = raw == "dark" ? "dark" : "light"
            if theme.wrappedValue != next { theme.wrappedValue = next }
        }

        /// 首屏主题由前端 applyTheme 报上来前先把原生对齐（冷启动/刷新时同样不发黑）
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.documentElement.dataset.theme || 'light'") { [weak self] value, _ in
                guard let self, let raw = value as? String else { return }
                let next = raw == "dark" ? "dark" : "light"
                if self.theme.wrappedValue != next { self.theme.wrappedValue = next }
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            reportedFailure = false
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            reportFailure()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            reportFailure()
        }

        private func reportFailure() {
            guard !reportedFailure else { return }
            reportedFailure = true
            onLoadFailure()
        }

        /// target=_blank / window.open：笼统地在当前 WebView 打开，避免点了没反应
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
        }

        /// JS alert/confirm/prompt：不实现会导致前端报错卡住
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
            present(alert)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
            present(alert)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            present(alert)
        }

        private func present(_ alert: UIAlertController) {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            top?.present(alert, animated: true)
        }
    }
}
