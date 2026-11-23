"""Turn raw probe results into a best guess at what a device is.

The guess is a scored vote, not a lookup. Every rule that fires adds weight
to a kind and leaves a plain English reason behind, and the UI shows those
reasons so you can see why a box got called a printer.
"""
from __future__ import annotations

import gzip
import re
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

DATA = Path(__file__).resolve().parent / "data"

KINDS = (
    "router", "access-point", "computer", "phone", "tablet", "tv", "speaker",
    "printer", "nas", "console", "camera", "iot", "server", "unknown",
)

# Common ports and what usually sits behind them. Deliberately short: this
# runs against every live host, so each extra port is another round trip.
PORTS: Dict[int, str] = {
    21: "ftp", 22: "ssh", 23: "telnet", 53: "dns", 80: "http", 139: "netbios",
    443: "https", 445: "smb", 515: "lpd", 548: "afp", 554: "rtsp", 631: "ipp",
    1400: "sonos", 1883: "mqtt", 1900: "upnp", 3000: "dev-http", 3389: "rdp",
    3689: "daap", 5000: "upnp/synology", 5001: "synology", 5353: "mdns",
    5900: "vnc", 6466: "android-tv", 7000: "airplay", 7100: "airplay",
    8000: "http-alt", 8008: "cast", 8009: "cast", 8080: "http-alt",
    8123: "home-assistant", 8443: "https-alt", 8888: "http-alt", 9100: "jetdirect",
    32400: "plex", 49152: "upnp", 62078: "iphone-sync",
}

# Ports tried during discovery when ping gets nothing. A refused connection
# counts as alive, so these just need to be ports that something will
# answer on, open or not.
DISCOVERY_PORTS = (80, 443, 22, 445, 62078, 8008, 7000)

_oui: Optional[Dict[str, str]] = None
_oui_lock = threading.Lock()


def _load_oui() -> Dict[str, str]:
    global _oui
    with _oui_lock:
        if _oui is None:
            table = {}
            path = DATA / "oui.tsv.gz"
            if path.exists():
                with gzip.open(path, "rt", encoding="utf-8") as fh:
                    for line in fh:
                        prefix, _, name = line.rstrip("\n").partition("\t")
                        table[prefix] = name
            _oui = table
        return _oui


def is_randomized(mac: Optional[str]) -> bool:
    """Locally administered bit set. iOS, Android and Windows all hand out
    per-network random MACs now, so this is usually a phone or laptop."""
    if not mac:
        return False
    return int(mac[1], 16) & 0x2 == 0x2


def vendor(mac: Optional[str]) -> Optional[str]:
    if not mac or is_randomized(mac):
        return None
    return _load_oui().get(mac.replace(":", "")[:6].upper())


# rules ----------------------------------------------------------------------

# (regex against vendor, kind, weight)
VENDOR_RULES: List[Tuple[str, str, int]] = [
    (r"sonos|bose|harman|denon|marantz|yamaha|bang & olufsen", "speaker", 5),
    (r"roku|vizio|tcl|hisense|lg electronics|samsung electronics|sony visual|philips tv|tivo", "tv", 3),
    (r"nintendo|sony interactive|microsoft.*xbox|valve", "console", 5),
    (r"synology|qnap|western digital|seagate|buffalo|asustor|terramaster", "nas", 6),
    (r"hewlett|hp inc|brother|epson|canon|lexmark|xerox|kyocera|ricoh|zebra", "printer", 4),
    (r"espressif|tuya|shelly|sonoff|itead|signify|philips lighting|lifx|wyze|ecobee|lg innotek|"
     r"nest labs|google.*nest|tp-link.*kasa|belkin|wemo|chamberlain|myq|ring|amazon|"
     r"texas instruments|silicon labs|murata|azurewave|universal global|hui zhou gaoshengda|"
     r"particle|arduino|tado|netatmo|irobot|ecovacs", "iot", 3),
    (r"hikvision|dahua|axis communications|reolink|amcrest|arlo|eufy|anker", "camera", 5),
    (r"raspberry pi", "server", 3),
    (r"ubiquiti|aruba|ruckus|meraki|cambium|eero|plume|tp-link|netgear|asustek|linksys|"
     r"d-link|mikrotik|zyxel|technicolor|sagemcom|arris|commscope|calix|actiontec|"
     r"huawei|zte|nokia|fritz|avm|vantiva|arcadyan|sercomm|askey|hitron|ubee", "router", 2),
    (r"apple", "computer", 1),
    (r"intel|dell|lenovo|micro-star|msi|gigabyte|asrock|realtek|liteon|hon hai|foxconn|"
     r"framework|microsoft|vmware|parallels|qemu|xensource|super micro", "computer", 2),
    (r"oneplus|xiaomi|oppo|vivo|motorola|huawei device|google|fairphone|nothing tech", "phone", 2),
]

NAME_RULES: List[Tuple[str, str, int]] = [
    (r"iphone|android|galaxy|pixel|oneplus|redmi|moto[ -]?g", "phone", 6),
    (r"ipad|tab-|kindle|fire-?hd|surface-go", "tablet", 6),
    (r"macbook|imac|mac-?mini|mac-?studio|desktop-|laptop|thinkpad|-pc\b|^pc-|workstation", "computer", 6),
    (r"roku|chromecast|appletv|apple-tv|firetv|fire-tv|bravia|webos|lgwebostv|samsung.*tv|shield", "tv", 6),
    (r"sonos|homepod|echo|alexa|google-home|nest-?(mini|audio|hub)|bose|soundtouch|denon|heos", "speaker", 6),
    (r"lg_smart|smart_?(dryer|oven|laundry|washer|fridge|ac)|dryer|washer|dishwasher|fridge|oven", "iot", 6),
    (r"boost|extender|repeater|satellite|-ap\b", "access-point", 6),
    (r"watch", "phone", 5),
    (r"printer|laserjet|officejet|deskjet|envy|epson|brn[0-9a-f]{6}|canon", "printer", 6),
    (r"synology|diskstation|qnap|nas\b|truenas|unraid|freenas", "nas", 6),
    (r"xbox|playstation|ps[45]|nintendo|switch|steamdeck|steam-deck", "console", 6),
    (r"cam\b|camera|doorbell|ring-|arlo|reolink|wyze", "camera", 5),
    (r"esp[-_]?[0-9a-f]{4,}|esp32|esp8266|tasmota|shelly|hue|bridge|thermostat|ecobee|plug|bulb|"
     r"homeassistant|home-assistant", "iot", 5),
    (r"raspberrypi|pihole|pi-hole|ubuntu|debian|server|proxmox|docker", "server", 4),
    (r"router|gateway|unifi|eero|orbi|deco|mesh|ap-|access-?point", "access-point", 4),
]

PORT_RULES: List[Tuple[Tuple[int, ...], str, int, str]] = [
    ((9100, 631, 515), "printer", 6, "print service open"),
    ((62078,), "phone", 6, "iPhone sync port open"),
    ((8008, 8009), "tv", 4, "Google Cast ports open"),
    ((6466,), "tv", 5, "Android TV remote port open"),
    ((7100,), "tv", 2, "AirPlay screen mirroring"),
    ((1400,), "speaker", 7, "Sonos control port open"),
    ((5001,), "nas", 4, "Synology DSM port open"),
    ((7000,), "computer", 1, "AirPlay receiver"),
    ((548,), "nas", 3, "AFP file sharing"),
    ((32400,), "server", 4, "Plex server"),
    ((8123,), "server", 5, "Home Assistant"),
    ((3389,), "computer", 5, "Remote Desktop open"),
    ((445, 139), "computer", 2, "SMB file sharing"),
    ((554,), "camera", 5, "RTSP video stream"),
    ((1883,), "iot", 4, "MQTT broker"),
    ((22,), "server", 1, "SSH open"),
    ((53,), "router", 3, "answers DNS"),
]

UPNP_RULES: List[Tuple[str, str, int]] = [
    (r"mediarenderer", "tv", 3),
    (r"internetgatewaydevice|wanconnection", "router", 6),
    (r"zoneplayer|sonos", "speaker", 6),
    (r"printer", "printer", 5),
    (r"tv|television|dial", "tv", 4),
    (r"hue|bridge", "iot", 4),
    (r"nas|storage|diskstation", "nas", 4),
]


def classify(host: dict, gateway: Optional[str], local_ip: Optional[str]) -> Tuple[str, int, List[str]]:
    """Returns (kind, confidence 0-100, reasons)."""
    scores: Dict[str, int] = {}
    reasons: List[str] = []

    def vote(kind: str, weight: int, why: str) -> None:
        scores[kind] = scores.get(kind, 0) + weight
        reasons.append(why)

    ip = host.get("ip")
    if ip and ip == gateway:
        vote("router", 20, "it's the default gateway")
    if ip and ip == local_ip:
        vote("computer", 20, "this is the machine running punchdown")

    v = (host.get("vendor") or "").lower()
    for pattern, kind, weight in VENDOR_RULES:
        if v and re.search(pattern, v):
            vote(kind, weight, f"made by {host['vendor']}")
            break

    if host.get("randomized_mac") and ip not in (gateway, local_ip):
        vote("phone", 3, "uses a private (randomized) MAC")

    names = " ".join(filter(None, [host.get("hostname"), host.get("mdns"), host.get("netbios")])).lower()
    for pattern, kind, weight in NAME_RULES:
        if names and re.search(pattern, names):
            vote(kind, weight, f"name looks like a {kind.replace('-', ' ')}")
            break

    open_ports = {p["port"] for p in host.get("ports", []) if p.get("state") == "open"}
    for ports, kind, weight, why in PORT_RULES:
        if open_ports.intersection(ports):
            vote(kind, weight, why)

    upnp = " ".join((host.get("upnp") or {}).values()).lower()
    for pattern, kind, weight in UPNP_RULES:
        if upnp and re.search(pattern, upnp):
            vote(kind, weight, "UPnP description says so")
            break

    title = (host.get("http") or {}).get("title", "").lower()
    if re.search(r"router|gateway|wireless|unifi|openwrt|dd-wrt|tomato|asuswrt|xfinity|fritz", title):
        vote("router", 4, "admin page title looks like a router")
    elif re.search(r"printer|laserjet|officejet|epson|brother", title):
        vote("printer", 4, "admin page title mentions a printer")
    elif re.search(r"synology|qnap|truenas|unraid", title):
        vote("nas", 5, "admin page title mentions a NAS")

    # A router that isn't the gateway is almost always a mesh node or AP.
    if "router" in scores and ip != gateway:
        scores["access-point"] = scores.get("access-point", 0) + scores.pop("router")

    if not scores:
        return "unknown", 0, ["nothing distinctive answered"]
    kind, best = max(scores.items(), key=lambda kv: kv[1])
    total = sum(scores.values())
    confidence = min(99, int(100 * best / max(total, 1) * min(1.0, best / 8)))
    return kind, max(confidence, 10), reasons
