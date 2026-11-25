import AppKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count == 6, let url = URL(string: arguments[1]) else {
    fputs("Expected URL, script, output directory, fault and timeout\n", stderr)
    exit(2)
}
let fixtureScript = try String(contentsOfFile: arguments[2], encoding: .utf8)
let script = "window.__radiantVisualCapture = (async () => {\n" + fixtureScript
    + "\n})(); return await window.__radiantVisualCapture;"
let output = URL(fileURLWithPath: arguments[3], isDirectory: true)
let timeout = Double(arguments[5]) ?? 30

final class Fixture: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let webView: WKWebView

    override init() {
        let bounds = NSRect(x: 0, y: 0, width: 1100, height: 720)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: bounds, configuration: config)
        window = NSWindow(contentRect: bounds, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        window.setFrameOrigin(NSPoint(x: -3000, y: -3000))
        super.init()
        webView.navigationDelegate = self
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        view.callAsyncJavaScript(script, arguments: ["fault": arguments[4]], in: nil, in: .page) { result in
            do {
                let object = try result.get()
                guard var info = object as? [String: Any],
                      let captures = info.removeValue(forKey: "captures") as? [String: String] else {
                    throw NSError(domain: "Radiant visual fixture payload", code: 1)
                }
                for (name, bytes) in captures {
                    guard let png = Data(base64Encoded: bytes) else {
                        throw NSError(domain: "Radiant visual fixture PNG", code: 2)
                    }
                    try png.write(to: output.appendingPathComponent(name).appendingPathExtension("png"))
                }
                info["macOS"] = ProcessInfo.processInfo.operatingSystemVersionString
                let json = try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys])
                try json.write(to: output.appendingPathComponent("environment.json"))
                exit(0)
            } catch {
                fputs("\(error)\n", stderr)
                exit(1)
            }
        }
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("\(error)\n", stderr)
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let fixture = Fixture()
fixture.window.orderBack(nil)
fixture.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
    fputs("WKWebView fixture did not complete\n", stderr)
    exit(1)
}
app.run()
