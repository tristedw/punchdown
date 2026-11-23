"""Tiny HTTP server for the UI and the JSON API.

Security model, short version:

* Binds to 127.0.0.1 only. There is no flag to change that.
* Every /api call needs a random token minted at startup. The browser gets
  it in the URL fragment, which never goes over the wire, and keeps it in
  sessionStorage. A random website you have open can't read it, so it can't
  drive the scanner through your browser.
* Host header must be 127.0.0.1 or localhost. That kills DNS rebinding,
  where evil.example resolves to 127.0.0.1 and tries to talk to us.
* Origin, when the browser sends one, has to be us.
* Strict CSP, no external anything. Fonts, scripts and styles are all served
  from this folder.
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import mimetypes
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

from . import __version__, identify, netinfo, probes
from .scanner import Scan, ScanError, parse_subnet
from .store import Store

WEB = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = 64 * 1024
LABEL_COLORS = {"black", "orange", "green", "blue", "brown"}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")


class App:
    def __init__(self, port: int, store: Optional[Store] = None):
        self.port = port
        self.token = secrets.token_urlsafe(24)
        self.store = store or Store()
        self.scan: Optional[Scan] = None
        self.lock = threading.Lock()
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.allowed_origins = {f"http://{h}" for h in self.allowed_hosts}

    def start_scan(self, subnet: str, thorough: bool) -> Scan:
        net = parse_subnet(subnet)
        with self.lock:
            if self.scan and not self.scan.done:
                raise ScanError("A scan is already running.")
            self.scan = Scan(net, self.store, thorough=thorough)
            self.scan.start()
            return self.scan

    def broadcast(self) -> Optional[str]:
        if self.scan:
            return str(self.scan.subnet.broadcast_address)
        sub = netinfo.summary().get("default_subnet")
        return str(ipaddress.ip_network(sub).broadcast_address) if sub else None


def _ip_list(raw, limit: int = 64):
    if not isinstance(raw, list):
        return []
    return [ip for ip in raw[:limit] if isinstance(ip, str) and netinfo.is_scannable(ip)]


class Handler(BaseHTTPRequestHandler):
    server_version = "punchdown"
    sys_version = ""
    app: App  # set by serve()

    # quiet: don't write every request to the terminal
    def log_message(self, *args) -> None:
        pass

    # helpers ---------------------------------------------------------------

    def _security_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in self.app.allowed_hosts

    def _api_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if origin and origin not in self.app.allowed_origins:
            return False
        if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            return False
        token = self.headers.get("X-Punchdown-Token", "")
        return hmac.compare_digest(token.encode(), self.app.token.encode())

    def _body(self) -> Optional[dict]:
        if "application/json" not in self.headers.get("Content-Type", ""):
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    # routing ---------------------------------------------------------------

    def do_GET(self) -> None:
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Unexpected Host header.")
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            if not self._api_ok():
                return self._error(HTTPStatus.FORBIDDEN, "Missing or wrong session token.")
            route = {
                "/api/info": self.api_info,
                "/api/scan/state": self.api_scan_state,
                "/api/scan/events": self.api_scan_events,
            }.get(url.path)
            if not route:
                return self._error(HTTPStatus.NOT_FOUND, "No such endpoint.")
            return route(parse_qs(url.query))
        self.serve_static(url.path)

    def do_POST(self) -> None:
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Unexpected Host header.")
        if not self._api_ok():
            return self._error(HTTPStatus.FORBIDDEN, "Missing or wrong session token.")
        route = {
            "/api/scan": self.api_scan,
            "/api/scan/cancel": self.api_scan_cancel,
            "/api/ping": self.api_ping,
            "/api/ports": self.api_ports,
            "/api/label": self.api_label,
            "/api/layout": self.api_layout,
            "/api/forget": self.api_forget,
            "/api/wake": self.api_wake,
        }.get(urlparse(self.path).path)
        if not route:
            return self._error(HTTPStatus.NOT_FOUND, "No such endpoint.")
        body = self._body()
        if body is None:
            return self._error(HTTPStatus.BAD_REQUEST, "Expected a JSON object body.")
        route(body)

    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        target = (WEB / path.lstrip("/")).resolve()
        if WEB.resolve() not in target.parents or not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, "Not found.")
        data = target.read_bytes()
        self.send_response(200)
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    # endpoints -------------------------------------------------------------

    def api_info(self, _q) -> None:
        info = netinfo.summary()
        data = self.app.store.data
        info.update(
            version=__version__,
            known=[{"key": k, **v} for k, v in data["devices"].items()],
            layout=data["layout"],
            extras=data["extras"],
            links=data["links"],
            scanning=bool(self.app.scan and not self.app.scan.done),
        )
        self._json(info)

    def api_scan(self, body: dict) -> None:
        try:
            scan = self.app.start_scan(str(body.get("subnet", "")), bool(body.get("thorough", True)))
        except ScanError as exc:
            return self._error(HTTPStatus.BAD_REQUEST, str(exc))
        self._json({"subnet": str(scan.subnet), "count": scan.subnet.num_addresses - 2})

    def api_scan_cancel(self, _body: dict) -> None:
        if self.app.scan:
            self.app.scan.cancel()
        self._json({"ok": True})

    def api_scan_state(self, _q) -> None:
        scan = self.app.scan
        if not scan:
            return self._json({"running": False, "hosts": []})
        self._json({
            "running": not scan.done,
            "subnet": str(scan.subnet),
            "hosts": list(scan.hosts.values()),
            "events": len(scan.events),
        })

    def api_scan_events(self, query) -> None:
        """Newline delimited JSON, one event per line, held open until the
        scan finishes. fetch() can read this as a stream and, unlike
        EventSource, it lets us send the token as a header."""
        scan = self.app.scan
        if not scan:
            return self._error(HTTPStatus.NOT_FOUND, "No scan has been started.")
        try:
            cursor = max(0, int(query.get("from", ["0"])[0]))
        except ValueError:
            cursor = 0
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._security_headers()
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                batch = scan.wait_events(cursor)
                if batch:
                    cursor += len(batch)
                    self.wfile.write(b"".join(json.dumps(e).encode() + b"\n" for e in batch))
                    self.wfile.flush()
                elif not scan.done:
                    self.wfile.write(b"\n")  # keepalive
                    self.wfile.flush()
                if scan.done and cursor >= len(scan.events):
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass

    def api_ping(self, body: dict) -> None:
        ips = _ip_list(body.get("ips"))
        known = self.app.scan.hosts if self.app.scan else {}

        def one(ip):
            ports = [p["port"] for p in known.get(ip, {}).get("ports", [])]
            return probes.latency(ip, ports, timeout=1.0)

        with ThreadPoolExecutor(max_workers=32) as pool:
            rtts = list(pool.map(one, ips))
        self._json({ip: (round(r, 2) if r is not None else None) for ip, r in zip(ips, rtts)})

    def api_ports(self, body: dict) -> None:
        ips = _ip_list([body.get("ip")], 1)
        if not ips:
            return self._error(HTTPStatus.BAD_REQUEST, "Pick a device on your local network first.")
        ip = ips[0]
        ports = sorted(set(range(1, 1025)) | set(identify.PORTS))
        with ThreadPoolExecutor(max_workers=96) as pool:
            results = list(pool.map(lambda p: (p, probes.tcp(ip, p, timeout=0.5)[0]), ports))
        open_ports = [
            {"port": p, "service": identify.PORTS.get(p, ""), "state": "open"}
            for p, state in results if state == "open"
        ]
        if self.app.scan and ip in self.app.scan.hosts:
            self.app.scan.hosts[ip]["ports"] = open_ports
        self._json({"ip": ip, "checked": len(ports), "ports": open_ports})

    def api_label(self, body: dict) -> None:
        key, label = str(body.get("key", "")), str(body.get("label", "")).strip()
        color = body.get("color") if body.get("color") in LABEL_COLORS else "black"
        if not self.app.store.set_label(key, label, color):
            return self._error(HTTPStatus.NOT_FOUND, "Scan once before labelling this device.")
        self._json({"key": key, "label": label or None, "color": color})

    def api_layout(self, body: dict) -> None:
        store = self.app.store
        layout, extras, links = body.get("layout"), body.get("extras"), body.get("links")
        with store.lock:
            if isinstance(layout, dict):
                store.data["layout"] = {
                    str(k)[:64]: [round(float(v[0]), 1), round(float(v[1]), 1)]
                    for k, v in list(layout.items())[:2048]
                    if isinstance(v, list) and len(v) == 2 and all(isinstance(n, (int, float)) for n in v)
                }
            if isinstance(extras, list):
                store.data["extras"] = [
                    {"id": str(e.get("id"))[:32], "kind": e.get("kind") if e.get("kind") in ("switch", "access-point") else "switch",
                     "name": str(e.get("name", ""))[:40]}
                    for e in extras[:64] if isinstance(e, dict) and e.get("id")
                ]
            if isinstance(links, dict):
                store.data["links"] = {str(k)[:64]: str(v)[:64] for k, v in list(links.items())[:2048]}
        store.save()
        self._json({"ok": True})

    def api_forget(self, body: dict) -> None:
        self.app.store.forget(str(body.get("key", "")))
        self._json({"ok": True})

    def api_wake(self, body: dict) -> None:
        mac = netinfo.normalize_mac(str(body.get("mac", "")))
        bcast = self.app.broadcast()
        if not mac or not bcast:
            return self._error(HTTPStatus.BAD_REQUEST, "Wake on LAN needs the device's MAC address.")
        if not probes.wake(mac, bcast):
            return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "Couldn't send the wake packet.")
        self._json({"sent": True, "mac": mac, "broadcast": bcast})


def serve(port: int, store: Optional[Store] = None):
    app = App(port, store)
    handler = type("BoundHandler", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    app.port = httpd.server_address[1]
    app.allowed_hosts = {f"127.0.0.1:{app.port}", f"localhost:{app.port}"}
    app.allowed_origins = {f"http://{h}" for h in app.allowed_hosts}
    return httpd, app
