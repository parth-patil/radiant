# Static server with optional COOP/COEP headers (for SharedArrayBuffer tests) and an optional CSP.
import http.server, sys, functools
port = int(sys.argv[1]); root = sys.argv[2]; isolate = len(sys.argv) > 3 and sys.argv[3] == 'isolate'
csp = sys.argv[4] if len(sys.argv) > 4 else None
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        if isolate:
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        if csp and self.path.split('?')[0].endswith('.html'):
            self.send_header('Content-Security-Policy', csp)
        super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(H, directory=root)).serve_forever()
