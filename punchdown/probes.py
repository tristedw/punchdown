"""Single-host probes. Each one talks to exactly one LAN address (or the
local multicast group) and nothing else.

Everything here works without root. ICMP goes through the system ping binary
because raw sockets need privileges, everything else is plain sockets.
"""
from __future__ import annotations

import errno
import random
import re
import socket
import ssl
import struct
import time
import urllib.request
from typing import Dict, List, Optional, Tuple
from xml.etree import ElementTree

from . import netinfo

# ICMP ------------------------------------------------------------------------

_RTT_RE = re.compile(r"time[=<]\s*([\d.]+)\s*ms", re.I)


def ping(ip: str, timeout: float = 1.0) -> Optional[float]:
    """Round trip in ms, or None if nothing came back."""
    if not netinfo.is_scannable(ip):
        return None
    ms = max(1, int(timeout * 1000))
    if netinfo.SYSTEM == "Windows":
        cmd = ["ping", "-n", "1", "-w", str(ms), ip]
    elif netinfo.SYSTEM == "Darwin":
        # macOS takes -W in milliseconds, Linux takes seconds
        cmd = ["ping", "-c", "1", "-W", str(ms), ip]
    else:
        cmd = ["ping", "-c", "1", "-W", str(max(1, round(timeout))), "-n", ip]
    out = netinfo.run(cmd, timeout=timeout + 1.5)
    m = _RTT_RE.search(out)
    if not m:
        return None
    # Windows prints "time<1ms" for anything under a millisecond
    return float(m.group(1)) if "<" not in m.group(0) else 0.5


def latency(ip: str, ports=(), timeout: float = 1.0) -> Optional[float]:
    """ICMP if it gets an answer, otherwise time a TCP handshake (or the RST)
    on a port we already know the device responds on. Phones in particular
    drop ping while asleep but still RST a connect."""
    rtt = ping(ip, timeout)
    if rtt is not None:
        return rtt
    for port in list(ports)[:3] or (80, 443, 62078):
        state, rtt = tcp(ip, port, timeout=min(timeout, 0.8))
        if state != "filtered":
            return rtt
    return None


# TCP -------------------------------------------------------------------------

def tcp(ip: str, port: int, timeout: float = 0.6) -> Tuple[str, Optional[float]]:
    """('open' | 'closed' | 'filtered', rtt_ms).

    'closed' means we got a RST back, which still proves the host is there.
    That's the trick that finds phones that ignore ping.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    start = time.perf_counter()
    try:
        code = s.connect_ex((ip, port))
        rtt = (time.perf_counter() - start) * 1000
        if code == 0:
            return "open", rtt
        if code in (errno.ECONNREFUSED, getattr(errno, "WSAECONNREFUSED", -1), 10061):
            return "closed", rtt
        return "filtered", None
    except OSError:
        return "filtered", None
    finally:
        s.close()


# DNS (PTR) -------------------------------------------------------------------

def _ptr_name(ip: str) -> str:
    return ".".join(reversed(ip.split("."))) + ".in-addr.arpa"


def _encode_name(name: str) -> bytes:
    out = b""
    for part in name.rstrip(".").split("."):
        raw = part.encode("idna") if part else b""
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def _read_name(buf: bytes, off: int, depth: int = 0) -> Tuple[str, int]:
    labels = []
    jumped_to = None
    while True:
        if off >= len(buf) or depth > 20:
            raise ValueError("bad name")
        n = buf[off]
        if n == 0:
            off += 1
            break
        if n & 0xC0 == 0xC0:
            ptr = struct.unpack("!H", buf[off:off + 2])[0] & 0x3FFF
            if jumped_to is None:
                jumped_to = off + 2
            off = ptr
            depth += 1
            continue
        labels.append(buf[off + 1:off + 1 + n].decode("utf-8", "replace"))
        off += 1 + n
    return ".".join(labels), (jumped_to if jumped_to is not None else off)


def build_query(name: str, qtype: int = 12, unicast_response: bool = False) -> Tuple[int, bytes]:
    qid = random.randint(0, 0xFFFF)
    header = struct.pack("!HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    qclass = 0x8001 if unicast_response else 1
    return qid, header + _encode_name(name) + struct.pack("!HH", qtype, qclass)


def parse_answers(buf: bytes, want_type: int = 12) -> List[str]:
    """Pull every answer of want_type out of a DNS packet. PTR targets come
    back as names, A records as dotted quads."""
    if len(buf) < 12:
        return []
    _, _, qd, an, ns, ar = struct.unpack("!HHHHHH", buf[:12])
    off = 12
    try:
        for _ in range(qd):
            _, off = _read_name(buf, off)
            off += 4
        found = []
        for _ in range(an + ns + ar):
            _, off = _read_name(buf, off)
            rtype, _, _, rdlen = struct.unpack("!HHIH", buf[off:off + 10])
            off += 10
            if rtype == want_type:
                if rtype == 12:
                    found.append(_read_name(buf, off)[0])
                elif rtype == 1 and rdlen == 4:
                    found.append(socket.inet_ntoa(buf[off:off + 4]))
            off += rdlen
        return found
    except (ValueError, struct.error):
        return []


def _udp_query(server: str, port: int, payload: bytes, timeout: float) -> Optional[bytes]:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(payload, (server, port))
        data, _ = s.recvfrom(4096)
        return data
    except OSError:
        return None
    finally:
        s.close()


def reverse_dns(ip: str, resolver: Optional[str], timeout: float = 0.8) -> Optional[str]:
    """Ask the router (not the OS resolver) for the PTR record.

    The OS resolver might be 8.8.8.8 or a DoH upstream, and then a lookup for
    192.168.1.23 would leave the house. Most home routers run dnsmasq and
    answer PTR for their DHCP leases, so we ask them directly.
    """
    if not resolver or not netinfo.is_scannable(resolver):
        return None
    _, q = build_query(_ptr_name(ip))
    data = _udp_query(resolver, 53, q, timeout)
    names = parse_answers(data or b"")
    return names[0].rstrip(".") if names else None


def mdns_name(ip: str, timeout: float = 0.8) -> Optional[str]:
    """Unicast mDNS PTR straight to the device. Apple gear, Chromecasts,
    printers and most Linux boxes with avahi will answer with their .local
    name."""
    _, q = build_query(_ptr_name(ip), unicast_response=True)
    data = _udp_query(ip, 5353, q, timeout)
    names = parse_answers(data or b"")
    return names[0].rstrip(".") if names else None


# NetBIOS ---------------------------------------------------------------------

def netbios_name(ip: str, timeout: float = 0.8) -> Optional[str]:
    """NBSTAT query on udp/137. Windows machines and Samba shares answer."""
    qid = random.randint(0, 0xFFFF)
    # '*' padded to 16 bytes, then first-level encoded into 32 chars
    raw = b"*" + b"\x00" * 15
    encoded = b"".join(bytes([0x41 + (c >> 4), 0x41 + (c & 0x0F)]) for c in raw)
    packet = struct.pack("!HHHHHH", qid, 0, 1, 0, 0, 0) + b"\x20" + encoded + b"\x00" + struct.pack("!HH", 0x21, 1)
    data = _udp_query(ip, 137, packet, timeout)
    if not data or len(data) < 57:
        return None
    try:
        count = data[56]
        off = 57
        for _ in range(count):
            name = data[off:off + 15].decode("ascii", "replace").strip()
            suffix, flags = data[off + 15], struct.unpack("!H", data[off + 16:off + 18])[0]
            off += 18
            is_group = bool(flags & 0x8000)
            if suffix == 0x00 and not is_group and name:
                return name
    except (IndexError, struct.error):
        return None
    return None


# HTTP ------------------------------------------------------------------------

# An opener with no proxy handler. urllib honours HTTP_PROXY by default, which
# would quietly route a LAN request through someone's proxy server.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_TITLE_RE = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)


def _fetch(url: str, timeout: float, limit: int = 65536) -> Tuple[Optional[bytes], Dict[str, str]]:
    req = urllib.request.Request(url, headers={"User-Agent": "punchdown"})
    ctx = ssl.create_default_context()
    # self-signed router certs are the norm, and we only read the page title
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        if url.startswith("https"):
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx)
            )
        else:
            opener = _OPENER
        with opener.open(req, timeout=timeout) as resp:
            return resp.read(limit), {k.lower(): v for k, v in resp.headers.items()}
    except Exception:
        return None, {}


def http_info(ip: str, port: int, timeout: float = 1.2) -> Dict[str, str]:
    scheme = "https" if port in (443, 8443) else "http"
    body, headers = _fetch(f"{scheme}://{ip}:{port}/", timeout)
    info = {}
    if headers.get("server"):
        info["server"] = headers["server"][:80]
    if body:
        m = _TITLE_RE.search(body)
        if m:
            title = re.sub(rb"\s+", b" ", m.group(1)).strip().decode("utf-8", "replace")
            if title:
                info["title"] = title[:80]
    return info


# SSDP / UPnP -----------------------------------------------------------------

SSDP_ADDR = ("239.255.255.250", 1900)
_MSEARCH = (
    "M-SEARCH * HTTP/1.1\r\n"
    "HOST: 239.255.255.250:1900\r\n"
    'MAN: "ssdp:discover"\r\n'
    "MX: 2\r\n"
    "ST: ssdp:all\r\n\r\n"
).encode()


def ssdp_sweep(timeout: float = 2.5) -> Dict[str, Dict[str, str]]:
    """Shout once on the local multicast group, collect who answers.

    Multicast to 239.255.255.250 has TTL 1 here so it can't leave the
    subnet. Returns ip -> {location, server, st}.
    """
    found: Dict[str, Dict[str, str]] = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    s.settimeout(0.3)
    try:
        s.sendto(_MSEARCH, SSDP_ADDR)
        s.sendto(_MSEARCH, SSDP_ADDR)
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(4096)
            except socket.timeout:
                continue
            if not netinfo.is_scannable(ip):
                continue
            headers = {}
            for line in data.decode("utf-8", "replace").split("\r\n")[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            entry = found.setdefault(ip, {})
            for key in ("location", "server"):
                if headers.get(key) and key not in entry:
                    entry[key] = headers[key][:200]
    except OSError:
        pass
    finally:
        s.close()
    return found


def upnp_description(ip: str, location: str, timeout: float = 1.5) -> Dict[str, str]:
    """Read the device description XML that SSDP pointed us at. Only if it
    lives on the same box that answered, so a spoofed LOCATION can't make
    us fetch something off the internet."""
    m = re.match(r"https?://([^/:]+)", location or "")
    if not m or m.group(1) != ip:
        return {}
    body, _ = _fetch(location, timeout, limit=131072)
    if not body:
        return {}
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError:
        return {}
    out = {}
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag in ("friendlyName", "manufacturer", "modelName", "modelNumber", "deviceType") and el.text:
            out.setdefault(tag, el.text.strip()[:80])
    return out


# Wake on LAN -----------------------------------------------------------------

def wake(mac: str, broadcast: str) -> bool:
    mac = netinfo.normalize_mac(mac or "")
    if not mac or not netinfo.is_scannable(broadcast):
        return False
    payload = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "")) * 16
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for port in (9, 7):
            s.sendto(payload, (broadcast, port))
        return True
    except OSError:
        return False
    finally:
        s.close()
