"""Local preview server for NURA.

    python server.py            (from C:\\dev\\nura)
    python server.py --lan      (also reachable from your phone on the same Wi-Fi)

Serves the storefront from ./frontend on http://localhost:8000 and forwards /api/... to the
API on http://localhost:3000 (start it with `npm run dev` in api/), along with /p/<slug> and
/sitemap.xml, which the API renders. This mirrors what
Netlify does in production, so the pages behave the same locally: same origin, same paths.

Caching is switched off so edits show up on a normal refresh.
"""
import http.client
import http.server
import socket
import sys
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent / "frontend"
API_HOST, API_PORT = "localhost", 3000
LAN = "--lan" in sys.argv   # listen on the Wi-Fi too, not just this computer
SITE_ORIGIN = "http://localhost:8000"   # the API's SITE_URL in development
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
        # --lan: a phone opens http://192.168.x.x:8000, so its writes carry that Origin, and the
        # API's cross-site check (which only knows http://localhost:8000) would refuse them.
        # Translate it, but ONLY when the Origin is this very server (the address the request
        # came in on): that is same-origin by definition. Any other Origin passes through
        # untouched, so a cross-site write is still refused, exactly as in production.
        if LAN and headers.get("Origin") == "http://" + (self.headers.get("Host") or ""):
            headers["Origin"] = SITE_ORIGIN
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
        # /p/<slug> (product pages) and /sitemap.xml are rendered by the API, as on Netlify.
        dynamic = self.path.startswith(("/api/", "/p/")) or self.path.split("?")[0] == "/sitemap.xml"
        return self._proxy() if dynamic else super().do_GET()

    def do_POST(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_PATCH(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_PUT(self):   # the admin's "change photo" (PUT /api/admin/products/:id/image)
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_DELETE(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)


def lan_address():
    """This computer's address on the Wi-Fi (the one a phone can reach). Nothing is sent: a UDP
    "connect" only asks the OS which network interface it would use."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return None


if __name__ == "__main__":
    print("NURA storefront: http://localhost:8000   (API expected on http://localhost:3000)")
    if LAN:
        ip = lan_address()
        print(f"On your phone (same Wi-Fi): http://{ip}:8000" if ip else "On your phone: http://<this computer's IPv4 address>:8000")
        print("Anyone on this Wi-Fi can open it while it runs. Use it at home, not on public Wi-Fi.")
    # Default: this computer only. --lan: every network interface, so the phone can connect.
    http.server.ThreadingHTTPServer(("0.0.0.0" if LAN else "127.0.0.1", 8000), Handler).serve_forever()
