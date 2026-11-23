import os
import struct
import tempfile
import unittest
from pathlib import Path

from punchdown import identify, netinfo, probes
from punchdown.scanner import ScanError, parse_subnet
from punchdown.store import Store


class NetinfoTests(unittest.TestCase):
    def test_normalize_mac(self):
        self.assertEqual(netinfo.normalize_mac("0:1a:2B:3:4:5"), "00:1a:2b:03:04:05")
        self.assertEqual(netinfo.normalize_mac("00-1A-2B-3C-4D-5E"), "00:1a:2b:3c:4d:5e")
        self.assertIsNone(netinfo.normalize_mac("ff:ff:ff:ff:ff:ff"))
        self.assertIsNone(netinfo.normalize_mac("not a mac"))

    def test_only_private_unicast_is_scannable(self):
        for ok in ("192.168.1.10", "10.0.0.5", "172.20.1.1"):
            self.assertTrue(netinfo.is_scannable(ok), ok)
        for bad in ("8.8.8.8", "127.0.0.1", "169.254.1.1", "224.0.0.251", "0.0.0.0", "1.1.1.1", "nope"):
            self.assertFalse(netinfo.is_scannable(bad), bad)


class SubnetTests(unittest.TestCase):
    def test_accepts_home_ranges(self):
        self.assertEqual(str(parse_subnet("192.168.1.0/24")), "192.168.1.0/24")
        self.assertEqual(str(parse_subnet("192.168.1.77/24")), "192.168.1.0/24")
        self.assertEqual(str(parse_subnet("10.0.0.0/22")), "10.0.0.0/22")

    def test_rejects_public_and_huge(self):
        for bad in ("8.8.8.0/24", "10.0.0.0/16", "garbage", "fe80::/64", "100.64.0.0/24"):
            with self.assertRaises(ScanError, msg=bad):
                parse_subnet(bad)


class DnsTests(unittest.TestCase):
    def _answer(self, qname: str, target: str) -> bytes:
        qid, query = probes.build_query(qname)
        header = struct.pack("!HHHHHH", qid, 0x8180, 1, 1, 0, 0)
        question = query[12:]
        rdata = probes._encode_name(target)
        # name as a compression pointer back to the question at offset 12
        answer = b"\xc0\x0c" + struct.pack("!HHIH", 12, 1, 60, len(rdata)) + rdata
        return header + question + answer

    def test_ptr_round_trip(self):
        pkt = self._answer(probes._ptr_name("192.168.1.23"), "printer.lan")
        self.assertEqual(probes.parse_answers(pkt), ["printer.lan"])

    def test_ptr_name(self):
        self.assertEqual(probes._ptr_name("192.168.1.23"), "23.1.168.192.in-addr.arpa")

    def test_garbage_is_harmless(self):
        self.assertEqual(probes.parse_answers(b"\x00" * 5), [])
        self.assertEqual(probes.parse_answers(b"\x00\x01\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00\xc0\x0c"), [])


class IdentifyTests(unittest.TestCase):
    def test_vendor_lookup(self):
        self.assertEqual(identify.vendor("b8:27:eb:00:00:01"), "Raspberry Pi Foundation")
        self.assertIsNone(identify.vendor("02:00:00:00:00:01"))

    def test_randomized_bit(self):
        self.assertTrue(identify.is_randomized("9a:41:c2:7f:0e:13"))
        self.assertFalse(identify.is_randomized("00:11:32:9c:4d:21"))

    def test_gateway_is_router(self):
        kind, _, reasons = identify.classify({"ip": "192.168.1.1"}, "192.168.1.1", "192.168.1.5")
        self.assertEqual(kind, "router")
        self.assertIn("it's the default gateway", reasons)

    def test_printer_by_ports(self):
        host = {"ip": "192.168.1.40", "vendor": "Brother Industries", "ports": [{"port": 9100, "state": "open"}, {"port": 631, "state": "open"}]}
        self.assertEqual(identify.classify(host, "192.168.1.1", None)[0], "printer")

    def test_iphone_by_name_and_port(self):
        host = {"ip": "192.168.1.60", "randomized_mac": True, "mdns": "Tristans-iPhone.local", "ports": [{"port": 62078, "state": "open"}]}
        self.assertEqual(identify.classify(host, "192.168.1.1", None)[0], "phone")

    def test_second_router_becomes_access_point(self):
        host = {"ip": "192.168.1.2", "vendor": "Ubiquiti", "ports": []}
        self.assertEqual(identify.classify(host, "192.168.1.1", None)[0], "access-point")

    def test_nothing_known(self):
        self.assertEqual(identify.classify({"ip": "192.168.1.99"}, "192.168.1.1", None)[0], "unknown")


class StoreTests(unittest.TestCase):
    def test_remember_and_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            rec = store.remember({"ip": "192.168.1.30", "mac": "a8:23:fe:0c:44:9d", "kind": "tv"})
            self.assertTrue(rec["new"])
            self.assertTrue(store.set_label(rec["key"], "Living room", "blue"))
            store.save()
            again = Store(Path(tmp)).remember({"ip": "192.168.1.31", "mac": "a8:23:fe:0c:44:9d"})
            self.assertFalse(again["new"])
            self.assertEqual(again["label"], "Living room")
            self.assertEqual(again["ip"], "192.168.1.31")
            if os.name == "posix":
                mode = (Path(tmp) / "state.json").stat().st_mode & 0o777
                self.assertEqual(mode, 0o600)

    def test_randomized_mac_keys_by_ip(self):
        self.assertEqual(Store.key_for({"ip": "192.168.1.9", "mac": "9a:00:00:00:00:01", "randomized_mac": True}), "ip:192.168.1.9")


if __name__ == "__main__":
    unittest.main()
