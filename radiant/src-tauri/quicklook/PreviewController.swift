import AppKit
import Quartz
import SQLite3
import WebKit

private enum PreviewError: Error { case invalidDocument, unavailable }

// Keep a single read transaction across the document and artwork reads so a concurrent
// save cannot mix two revisions. The preview only opens its file on this serial queue.
private final class MapFile {
    private let url: URL
    private var db: OpaquePointer?
    private var remainingArtworkBytes = 48 * 1024 * 1024

    init(_ url: URL) { self.url = url }
    deinit { if let db { sqlite3_close(db) } }

    private func statement(_ sql: String) throws -> OpaquePointer {
        var result: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &result, nil) == SQLITE_OK, let result else {
            throw PreviewError.invalidDocument
        }
        return result
    }

    private func scalar(_ sql: String) throws -> Int32 {
        let stmt = try statement(sql)
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw PreviewError.invalidDocument }
        return sqlite3_column_int(stmt, 0)
    }

    func document() throws -> String {
        guard db == nil, url.isFileURL,
              sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_PRIVATECACHE, nil) == SQLITE_OK
        else { throw PreviewError.unavailable }
        sqlite3_busy_timeout(db, 750)
        sqlite3_limit(db, SQLITE_LIMIT_LENGTH, 128 * 1024 * 1024)
        guard sqlite3_exec(db, "PRAGMA trusted_schema=OFF; BEGIN", nil, nil, nil) == SQLITE_OK,
              try scalar("PRAGMA application_id") == 0x52444E54,
              (1...2).contains(try scalar("PRAGMA user_version")),
              try scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('doc','assets')") == 2
        else { throw PreviewError.invalidDocument }
        let stmt = try statement("SELECT json FROM doc WHERE id=1")
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW, let text = sqlite3_column_text(stmt, 0),
              let json = String(bytes: UnsafeBufferPointer(start: text, count: Int(sqlite3_column_bytes(stmt, 0))), encoding: .utf8)
        else { throw PreviewError.invalidDocument }
        return json
    }

    func asset(_ hash: String) throws -> String {
        guard db != nil, hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              remainingArtworkBytes > 0 else { return "" }
        let stmt = try statement("SELECT mime, bytes FROM assets WHERE hash=? AND length(bytes) BETWEEN 1 AND ?")
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(stmt, 1, hash, -1, transient) == SQLITE_OK,
              sqlite3_bind_int(stmt, 2, Int32(remainingArtworkBytes)) == SQLITE_OK,
              sqlite3_step(stmt) == SQLITE_ROW, let type = sqlite3_column_text(stmt, 0),
              let bytes = sqlite3_column_blob(stmt, 1) else { return "" }
        let mime = String(cString: type)
        guard ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif"].contains(mime) else { return "" }
        let count = Int(sqlite3_column_bytes(stmt, 1))
        remainingArtworkBytes -= count
        return "data:" + mime + ";base64," + Data(bytes: bytes, count: count).base64EncodedString()
    }
}

@available(macOS 11.0, *)
private final class PreviewRequest: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    private let queue = DispatchQueue(label: "app.radiant.quicklook.read")
    private var file: MapFile?
    private var completion: ((Error?) -> Void)?

    init(url: URL, completion: @escaping (Error?) -> Void) {
        self.file = MapFile(url)
        self.completion = completion
    }

    func finish(_ error: Error?) {
        let callback = completion
        completion = nil
        queue.async { self.file = nil }
        callback?(error)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: String], let kind = body["kind"],
              completion != nil else { replyHandler(nil, "Preview closed"); return }
        switch kind {
        case "document", "asset":
            queue.async {
                do {
                    guard let file = self.file else { throw PreviewError.unavailable }
                    let value = try kind == "document" ? file.document() : file.asset(body["hash"] ?? "")
                    DispatchQueue.main.async { replyHandler(value, nil) }
                } catch {
                    DispatchQueue.main.async { replyHandler(nil, "Cannot read map") }
                }
            }
        case "ready": replyHandler("", nil); finish(nil)
        default: replyHandler("", nil); finish(PreviewError.invalidDocument)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(PreviewError.unavailable) }
}

@available(macOS 11.0, *)
@objc(RadiantPreviewController)
final class PreviewController: NSViewController, QLPreviewingController {
    private var request: PreviewRequest?

    override func loadView() {
        view = NSView()
        preferredContentSize = NSSize(width: 900, height: 600)
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        guard let page = Bundle(for: Self.self).url(forResource: "index", withExtension: "html") else {
            handler(PreviewError.unavailable); return
        }
        request?.finish(CocoaError(.userCancelled))
        let active = PreviewRequest(url: url, completion: handler)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addScriptMessageHandler(active, contentWorld: .page, name: "preview")
        let browser = WKWebView(frame: view.bounds, configuration: config)
        browser.autoresizingMask = [.width, .height]
        browser.navigationDelegate = active
        view.subviews = [browser]
        request = active
        browser.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }
}
