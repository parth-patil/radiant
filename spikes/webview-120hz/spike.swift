// Single-file WKWebView frame-rate spike. Usage: ./spike <html-path> <mode> [prefs]
// modes: raf | c2d | gl | scale | gpu.  "prefs" tries the PRIVATE WKPreferences flag (see notes).
import Cocoa
import WebKit

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
let htmlPath = args.count > 1 ? args[1] : "spike.html"
let mode = args.count > 2 ? args[2] : "raf"
let tryPrefs = args.contains("prefs")

final class Handler: NSObject, WKScriptMessageHandler, NSWindowDelegate {
    var swiftInfo: [String: Any] = [:]
    var win: NSWindow!
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let s = m.body as? String,
              let d = s.data(using: .utf8),
              var obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        obj["swift"] = swiftInfo
        if let out = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
           let str = String(data: out, encoding: .utf8) { print(str) }
        if (obj["final"] as? Bool) == true {
            win.orderOut(nil); win.close()
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let handler = Handler()
let cfg = WKWebViewConfiguration()
cfg.userContentController.add(handler, name: "res")
var privInfo = "not requested"
if tryPrefs {
    // PRIVATE API (same route as tauri-plugin-macos-fps): WKPreferences._features / _setEnabled:forFeature:
    let p = cfg.preferences
    let fsel = NSSelectorFromString("_features"), setSel = NSSelectorFromString("_setEnabled:forFeature:"), getSel = NSSelectorFromString("_isEnabledForFeature:")
    let cls: AnyObject = WKPreferences.self
    if cls.responds(to: fsel), let arr = cls.perform(fsel)?.takeUnretainedValue() as? [NSObject] {
        var related: [String] = []
        privInfo = "feature key not found among \(arr.count) features"
        for f in arr {
            let key = (f.value(forKey: "key") as? String) ?? "?"
            if key.contains("60") || key.lowercased().contains("fps") || key.lowercased().contains("framerate") || key.lowercased().contains("renderingupdate") { related.append(key) }
            if key == "PreferPageRenderingUpdatesNear60FPSEnabled", p.responds(to: setSel) {
                typealias GetF = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
                typealias SetF = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
                let before = p.responds(to: getSel) ? unsafeBitCast(p.method(for: getSel), to: GetF.self)(p, getSel, f) : false
                unsafeBitCast(p.method(for: setSel), to: SetF.self)(p, setSel, false, f)
                let after = p.responds(to: getSel) ? unsafeBitCast(p.method(for: getSel), to: GetF.self)(p, getSel, f) : false
                privInfo = "PRIVATE _WKFeature PreferPageRenderingUpdatesNear60FPSEnabled before=\(before) after=\(after)"
            }
        }
        privInfo += " | related keys: \(related)"
    } else { privInfo = "private _features not available" }
}
let script = WKUserScript(source: "window.SPIKE_MODE='\(mode)';", injectionTime: .atDocumentStart, forMainFrameOnly: true)
cfg.userContentController.addUserScript(script)

let win = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 1400, height: 900),
                   styleMask: [.titled, .closable], backing: .buffered, defer: false)
win.title = "webview-spike (auto-closes)"
handler.win = win
let wv = WKWebView(frame: win.contentView!.bounds, configuration: cfg)
wv.autoresizingMask = [.width, .height]
if #available(macOS 13.3, *) { wv.isInspectable = false }
win.contentView!.addSubview(wv)
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

func screenDict(_ s: NSScreen) -> [String: Any] {
    return ["name": s.localizedName, "maxFPS": s.maximumFramesPerSecond,
            "scale": s.backingScaleFactor, "frame": "\(s.frame)"]
}
handler.swiftInfo = [
    "mode": mode, "privatePrefs": privInfo,
    "NSScreen.main.maximumFramesPerSecond": NSScreen.main?.maximumFramesPerSecond ?? -1,
    "mainScreen": NSScreen.main.map(screenDict) ?? [:],
    "windowScreen": win.screen.map(screenDict) ?? [:],
    "allScreens": NSScreen.screens.map(screenDict),
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
]
let html = (try? String(contentsOfFile: htmlPath, encoding: .utf8)) ?? "<h1>missing html</h1>"
wv.loadHTMLString(html, baseURL: URL(string: args.contains("big") ? "http://localhost/?big=1" : "http://localhost/"))

DispatchQueue.main.asyncAfter(deadline: .now() + 26) {
    print("{\"error\":\"watchdog timeout\",\"mode\":\"\(mode)\"}")
    win.orderOut(nil); win.close(); NSApp.terminate(nil)
}
app.run()
