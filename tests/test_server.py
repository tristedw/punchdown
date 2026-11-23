"""Poke the HTTP layer the way a hostile web page would."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from punchdown.server import serve
from punchdown.store import Store


class ServerSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.httpd, cls.app = serve(0, Store(Path(cls.tmp.name)))
        cls.port = cls.app.port
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def auth(self, **extra):
        return {"X-Punchdown-Token": self.app.token, **extra}

    def test_binds_loopback_only(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")

    def test_api_needs_token(self):
        resp, _ = self.request("GET", "/api/info")
        self.assertEqual(resp.status, 403)
        resp, _ = self.request("GET", "/api/info", {"X-Punchdown-Token": "guess"})
        self.assertEqual(resp.status, 403)

    def test_token_works(self):
        resp, data = self.request("GET", "/api/info", self.auth())
        self.assertEqual(resp.status, 200)
        self.assertIn("version", json.loads(data))

    def test_dns_rebinding_host_rejected(self):
        resp, _ = self.request("GET", "/api/info", self.auth(Host=f"evil.example:{self.port}"))
        self.assertEqual(resp.status, 421)
        resp, _ = self.request("GET", "/", {"Host": "evil.example"})
        self.assertEqual(resp.status, 421)

    def test_foreign_origin_rejected(self):
        resp, _ = self.request("GET", "/api/info", self.auth(Origin="https://evil.example"))
        self.assertEqual(resp.status, 403)
        resp, _ = self.request("GET", "/api/info", self.auth(**{"Sec-Fetch-Site": "cross-site"}))
        self.assertEqual(resp.status, 403)

    def test_post_needs_json(self):
        resp, _ = self.request("POST", "/api/scan", self.auth(**{"Content-Type": "text/plain"}), body=b'{"subnet":"192.168.1.0/24"}')
        self.assertEqual(resp.status, 400)

    def test_public_subnet_refused(self):
        body = json.dumps({"subnet": "8.8.8.0/24"}).encode()
        resp, data = self.request("POST", "/api/scan", self.auth(**{"Content-Type": "application/json"}), body=body)
        self.assertEqual(resp.status, 400)
        self.assertIn("private", json.loads(data)["error"])

    def test_ping_filters_public_ips(self):
        body = json.dumps({"ips": ["8.8.8.8", "1.1.1.1"]}).encode()
        resp, data = self.request("POST", "/api/ping", self.auth(**{"Content-Type": "application/json"}), body=body)
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(data), {})

    def test_no_path_traversal(self):
        for path in ("/../punchdown/server.py", "/%2e%2e/punchdown/server.py", "/..%2fpunchdown%2fserver.py"):
            resp, _ = self.request("GET", path)
            self.assertEqual(resp.status, 404, path)

    def test_security_headers(self):
        resp, _ = self.request("GET", "/")
        self.assertEqual(resp.status, 200)
        csp = resp.getheader("Content-Security-Policy")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")

    def test_oversized_body_refused(self):
        body = b'{"x":"' + b"a" * 70000 + b'"}'
        resp, _ = self.request("POST", "/api/layout", self.auth(**{"Content-Type": "application/json"}), body=body)
        self.assertEqual(resp.status, 400)


if __name__ == "__main__":
    unittest.main()
