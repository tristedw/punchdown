"""Figure out which network we're sitting on.

No third party packages, so this shells out to whatever the OS ships with
(ip, ifconfig, ipconfig, route, arp) and parses the text. Every parser is
written to fail soft: if the output looks wrong we return less, not crash.
"""
from __future__ import annotations

import ipaddress
import platform
import re
import socket
import subprocess
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional

SYSTEM = platform.system()  # "Linux", "Darwin", "Windows"

MAC_RE = re.compile(r"([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}")
IPV4_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")


@dataclass
class Interface:
    name: str
    ip: str
    prefix: int

    @property
    def network(self) -> ipaddress.IPv4Network:
        return ipaddress.ip_network(f"{self.ip}/{self.prefix}", strict=False)

    def as_dict(self) -> dict:
        d = asdict(self)
        d["network"] = str(self.network)
        return d


def run(cmd: List[str], timeout: float = 4.0) -> str:
    """Run a command, return stdout or "" if anything goes wrong."""
    try:
        out = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
            # keep Windows from flashing a console window per ping
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return out.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return ""


def normalize_mac(raw: str) -> Optional[str]:
    """'0:1a:2B:3:4:5' or '00-1A-...' -> '00:1a:2b:03:04:05'."""
    parts = re.split(r"[:-]", raw.strip())
    if len(parts) != 6:
        return None
    try:
        mac = ":".join(f"{int(p, 16):02x}" for p in parts)
    except ValueError:
        return None
    if mac in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
        return None
    return mac


def is_scannable(ip: str) -> bool:
    """Private, unicast IPv4 only. This is the line that keeps punchdown
    from being pointed at someone else's network."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return (
        addr.version == 4
        and addr.is_private
        and not addr.is_loopback
        and not addr.is_link_local
        and not addr.is_multicast
        and not addr.is_unspecified
    )


def primary_ip() -> Optional[str]:
    """IP of the interface the OS would route LAN traffic out of.

    connect() on a UDP socket picks a source address without sending a
    single packet, so this never touches the wire.
    """
    for probe in ("10.255.255.255", "192.168.255.255", "172.31.255.255"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((probe, 9))
            ip = s.getsockname()[0]
            if is_scannable(ip):
                return ip
        except OSError:
            pass
        finally:
            s.close()
    return None


# interfaces -----------------------------------------------------------------

def _linux_interfaces() -> List[Interface]:
    out = run(["ip", "-o", "-4", "addr", "show"])
    found = []
    for line in out.splitlines():
        m = re.search(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)", line)
        if m:
            found.append(Interface(m.group(1), m.group(2), int(m.group(3))))
    return found


def _mac_interfaces() -> List[Interface]:
    out = run(["ifconfig"])
    found, current = [], None
    for line in out.splitlines():
        head = re.match(r"^(\S+?):\s", line)
        if head:
            current = head.group(1)
            continue
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-fA-F]+)", line)
        if m and current:
            prefix = bin(int(m.group(2), 16)).count("1")
            found.append(Interface(current, m.group(1), prefix))
    return found


def _windows_interfaces() -> List[Interface]:
    out = run(["ipconfig"])
    found, current, ip = [], "adapter", None
    for line in out.splitlines():
        if line and not line.startswith(" ") and line.rstrip().endswith(":"):
            current = line.strip().rstrip(":").replace("adapter ", "")
            ip = None
            continue
        if "IPv4" in line:
            m = IPV4_RE.search(line.split(":", 1)[-1])
            ip = m.group(1) if m else None
        elif "Subnet Mask" in line and ip:
            m = IPV4_RE.search(line.split(":", 1)[-1])
            if m:
                prefix = ipaddress.ip_network(f"0.0.0.0/{m.group(1)}").prefixlen
                found.append(Interface(current, ip, prefix))
            ip = None
    return found


def interfaces() -> List[Interface]:
    if SYSTEM == "Linux":
        found = _linux_interfaces()
    elif SYSTEM == "Darwin":
        found = _mac_interfaces()
    elif SYSTEM == "Windows":
        found = _windows_interfaces()
    else:
        found = []
    found = [i for i in found if is_scannable(i.ip)]

    # Docker bridges and VPN tunnels are private too. Push the interface that
    # actually carries the default route to the front.
    main = primary_ip()
    if main and not any(i.ip == main for i in found):
        found.append(Interface("default", main, 24))
    found.sort(key=lambda i: (i.ip != main, i.name.startswith(("docker", "br-", "veth", "utun"))))
    return found


# gateway --------------------------------------------------------------------

def default_gateway() -> Optional[str]:
    gw = None
    if SYSTEM == "Linux":
        try:
            with open("/proc/net/route") as fh:
                for line in fh.readlines()[1:]:
                    cols = line.split()
                    if len(cols) > 2 and cols[1] == "00000000":
                        raw = bytes.fromhex(cols[2])[::-1]
                        gw = socket.inet_ntoa(raw)
                        break
        except OSError:
            pass
        if not gw:
            m = re.search(r"default via (\d+\.\d+\.\d+\.\d+)", run(["ip", "route"]))
            gw = m.group(1) if m else None
    elif SYSTEM == "Darwin":
        m = re.search(r"gateway:\s*(\d+\.\d+\.\d+\.\d+)", run(["route", "-n", "get", "default"]))
        gw = m.group(1) if m else None
    elif SYSTEM == "Windows":
        for line in run(["ipconfig"]).splitlines():
            if "Default Gateway" in line:
                m = IPV4_RE.search(line)
                if m:
                    gw = m.group(1)
                    break
    return gw if gw and is_scannable(gw) else None


# arp / neighbour table ------------------------------------------------------

def arp_table() -> Dict[str, str]:
    """ip -> mac for everything the OS has resolved recently."""
    table: Dict[str, str] = {}
    if SYSTEM == "Linux":
        try:
            with open("/proc/net/arp") as fh:
                for line in fh.readlines()[1:]:
                    cols = line.split()
                    # flags 0x0 means incomplete, skip those
                    if len(cols) >= 4 and cols[2] != "0x0":
                        mac = normalize_mac(cols[3])
                        if mac:
                            table[cols[0]] = mac
        except OSError:
            pass
        if table:
            return table
        out = run(["ip", "neigh"])
    else:
        out = run(["arp", "-a"] if SYSTEM == "Windows" else ["arp", "-an"])

    for line in out.splitlines():
        ip_m, mac_m = IPV4_RE.search(line), MAC_RE.search(line)
        if ip_m and mac_m and "incomplete" not in line.lower():
            mac = normalize_mac(mac_m.group(0))
            if mac:
                table[ip_m.group(1)] = mac
    return table


def local_mac(ip: str) -> Optional[str]:
    """MAC of our own interface. The ARP table never lists ourselves."""
    if SYSTEM == "Linux":
        out = run(["ip", "-o", "addr", "show"])
        for line in out.splitlines():
            if f"inet {ip}/" in line:
                name = line.split()[1]
                try:
                    with open(f"/sys/class/net/{name}/address") as fh:
                        return normalize_mac(fh.read())
                except OSError:
                    return None
    elif SYSTEM == "Darwin":
        block = None
        for line in run(["ifconfig"]).splitlines():
            if re.match(r"^\S+?:\s", line):
                block = {"mac": None}
            if block is None:
                continue
            m = re.search(r"ether ([0-9a-f:]{17})", line)
            if m:
                block["mac"] = m.group(1)
            if f"inet {ip} " in line and block.get("mac"):
                return normalize_mac(block["mac"])
    elif SYSTEM == "Windows":
        # getmac lists by adapter, ipconfig /all is easier to pair with an ip
        mac = None
        for line in run(["ipconfig", "/all"]).splitlines():
            if "Physical Address" in line:
                m = MAC_RE.search(line)
                mac = m.group(0) if m else None
            if "IPv4" in line and ip in line and mac:
                return normalize_mac(mac)
    return None


def summary() -> dict:
    ifaces = interfaces()
    gw = default_gateway()
    me = primary_ip()
    subnet = None
    for i in ifaces:
        if gw and ipaddress.ip_address(gw) in i.network:
            subnet = i.network
            break
    if subnet is None and ifaces:
        subnet = ifaces[0].network
    # Anything bigger than a /22 is a corporate network, not a house. Clamp
    # to the /24 around us so the default scan stays polite.
    if subnet is not None and subnet.prefixlen < 22 and me:
        subnet = ipaddress.ip_network(f"{me}/24", strict=False)
    return {
        "hostname": socket.gethostname(),
        "os": SYSTEM,
        "local_ip": me,
        "gateway": gw,
        "interfaces": [i.as_dict() for i in ifaces],
        "default_subnet": str(subnet) if subnet else None,
    }
