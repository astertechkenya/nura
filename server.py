"""Local preview server for NURA.

    python server.py            (from C:\\dev\\nura)

Serves the storefront from ./frontend on http://localhost:8000 and forwards /api/... to the
API on http://localhost:3000 (start it with `npm run dev` in api/). This mirrors what
Netlify does in production, so the pages behave the same locally: same origin, same paths.

Caching is switched off so edits show up on a normal refresh.
"""
import http.client
import http.server
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent / "frontend"
API_HOST, API_PORT = "localhost", 3000
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "host"}
        try:
            conn = http.client.HTTPConnection(API_HOST, API_PORT, timeout=30)
            conn.request(self.command, self.path, body=body, headers=headers)
            res = conn.getresponse()
            data = res.read()
        except OSError:
            # Same answer Netlify gives when the API is unreachable, so the retry logic is exercised locally too.
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"API not running. Start it with: cd api; npm run dev"}')
            return
        self.send_response(res.status)
        for k, v in res.getheaders():
            if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        return self._proxy() if self.path.startswith("/api/") else super().do_GET()

    def do_POST(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_PATCH(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_DELETE(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)


if __name__ == "__main__":
    print("NURA storefront: http://localhost:8000   (API expected on http://localhost:3000)")
    http.server.ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
