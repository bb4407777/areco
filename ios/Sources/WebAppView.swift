import SwiftUI
import WebKit

/// areco 座舱的 WebView 壳：前端本身就是完整 PWA（会话/终端/微信/进程），
/// 原生端只负责装它、自动选服务器、处理登录 cookie 与弹窗，不重写业务 UI。
struct WebAppView: UIViewRepresentable {
    let url: URL
    /// 首次加载失败（局域网不通 / 服务没起）时回调，由 ServerStore 决定退公网还是报错
    let onLoadFailure: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoadFailure: onLoadFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // 默认 websiteDataStore = .default()，登录 cookie 落盘，杀掉 App 再开仍是登录态
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let onLoadFailure: () -> Void
        /// 同一次加载只回调一次：didFailProvisional 之后还会来 didFail，避免连退两次
        private var reportedFailure = false

        init(onLoadFailure: @escaping () -> Void) {
            self.onLoadFailure = onLoadFailure
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
