"""The sweep. Discovery first (who's there), then enrichment (what are they).

Progress goes out as a list of events that the HTTP layer streams to the
browser, so the patch panel can light up port by port as the sweep runs
instead of sitting on a spinner for 20 seconds.
"""
from __future__ import annotations

import ipaddress
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

from . import identify, netinfo, probes
from .store import Store

QUICK_PORTS = (22, 53, 80, 443, 445, 554, 631, 1400, 5000, 8008, 8080, 9100, 62078)
MAX_HOSTS = 1024


class ScanError(ValueError):
    pass


def parse_subnet(text: str) -> ipaddress.IPv4Network:
    try:
        net = ipaddress.ip_network(text.strip(), strict=False)
    except ValueError:
        raise ScanError("That isn't a subnet. Try something like 192.168.1.0/24.")
    if net.version != 4:
        raise ScanError("Only IPv4 subnets can be swept.")
    if not netinfo.is_scannable(str(net.network_address)) or not net.is_private:
        raise ScanError("Only private ranges (10.x, 172.16-31.x, 192.168.x) can be scanned.")
    if net.num_addresses > MAX_HOSTS:
        raise ScanError(f"{net} is {net.num_addresses} addresses. The limit is a /22.")
    return net


class Scan:
    def __init__(self, subnet: ipaddress.IPv4Network, store: Store, thorough: bool = True):
        self.subnet = subnet
        self.store = store
        self.thorough = thorough
        self.events: List[dict] = []
        self.hosts: Dict[str, dict] = {}
        self.cond = threading.Condition()
        self.done = False
        self.cancelled = False
        self.started = time.time()
        self.info = netinfo.summary()
        self.thread = threading.Thread(target=self._run, name="punchdown-scan", daemon=True)

    # event plumbing -------------------------------------------------------

    def emit(self, event: dict) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    def wait_events(self, cursor: int, timeout: float = 15.0) -> List[dict]:
        with self.cond:
            if cursor >= len(self.events) and not self.done:
                self.cond.wait(timeout)
            return self.events[cursor:]

    def start(self) -> None:
        self.thread.start()

    def cancel(self) -> None:
        self.cancelled = True

    # the sweep ------------------------------------------------------------

    def _alive(self, ip: str) -> Optional[float]:
        rtt = probes.ping(ip, timeout=0.8)
        if rtt is not None:
            return rtt
        for port in identify.DISCOVERY_PORTS:
            if self.cancelled:
                return None
            state, rtt = probes.tcp(ip, port, timeout=0.35)
            if state != "filtered":
                return rtt
        return None

    def _discover(self, ip: str) -> None:
        if self.cancelled:
            return
        rtt = self._alive(ip)
        self.emit({"type": "probe", "ip": ip, "alive": rtt is not None})
        if rtt is not None:
            self._found(ip, rtt, "ping or tcp")

    def _found(self, ip: str, rtt: Optional[float], how: str) -> None:
        host = {
            "ip": ip,
            "rtt": round(rtt, 2) if rtt is not None else None,
            "found_by": how,
            "is_gateway": ip == self.info["gateway"],
            "is_self": ip == self.info["local_ip"],
            "kind": "router" if ip == self.info["gateway"] else "unknown",
            "ports": [],
            "enriched": False,
        }
        with self.cond:
            if ip in self.hosts:
                return
            self.hosts[ip] = host
        self.emit({"type": "host", "host": dict(host)})

    def _enrich(self, ip: str, arp: Dict[str, str], ssdp: Dict[str, dict]) -> None:
        if self.cancelled:
            return
        host = self.hosts[ip]
        gw = self.info["gateway"]

        mac = arp.get(ip) or (netinfo.local_mac(ip) if host["is_self"] else None)
        host["mac"] = mac
        host["randomized_mac"] = identify.is_randomized(mac)
        host["vendor"] = identify.vendor(mac)

        ports = identify.PORTS.keys() if self.thorough else QUICK_PORTS
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda p: (p, probes.tcp(ip, p, timeout=0.5)), ports))
        host["ports"] = [
            {"port": p, "service": identify.PORTS.get(p, ""), "state": st}
            for p, (st, _) in results
            if st == "open"
        ]
        open_ports = {p["port"] for p in host["ports"]}

        host["hostname"] = probes.reverse_dns(ip, gw)
        host["mdns"] = probes.mdns_name(ip)
        if open_ports & {139, 445} or self.thorough:
            host["netbios"] = probes.netbios_name(ip)

        for port in (80, 8080, 443):
            if port in open_ports:
                info = probes.http_info(ip, port)
                if info:
                    host["http"] = {**info, "port": port}
                    break

        if ip in ssdp:
            host["upnp"] = probes.upnp_description(ip, ssdp[ip].get("location", ""))
            if ssdp[ip].get("server"):
                host.setdefault("upnp", {})["server"] = ssdp[ip]["server"]

        kind, confidence, reasons = identify.classify(host, gw, self.info["local_ip"])
        host.update(kind=kind, confidence=confidence, reasons=reasons, enriched=True)
        host["name"] = self._best_name(host)

        record = self.store.remember(host)
        host.update(
            key=record["key"],
            label=record.get("label"),
            color=record.get("color"),
            first_seen=record["first_seen"],
            new=record["new"],
        )
        self.emit({"type": "host", "host": dict(host)})

    @staticmethod
    def _best_name(host: dict) -> Optional[str]:
        upnp = host.get("upnp") or {}
        for candidate in (
            upnp.get("friendlyName"),
            host.get("mdns"),
            host.get("hostname"),
            host.get("netbios"),
            (host.get("http") or {}).get("title"),
        ):
            if candidate:
                name = candidate.removesuffix(".local").removesuffix(".lan").removesuffix(".home")
                return name[:48]
        return None

    def _run(self) -> None:
        addrs = [str(a) for a in self.subnet.hosts()]
        self.emit({
            "type": "start",
            "subnet": str(self.subnet),
            "first": addrs[0] if addrs else None,
            "count": len(addrs),
            "gateway": self.info["gateway"],
            "local_ip": self.info["local_ip"],
            "thorough": self.thorough,
        })

        # SSDP listens for a couple of seconds, so start it alongside the sweep.
        ssdp: Dict[str, dict] = {}
        ssdp_thread = threading.Thread(target=lambda: ssdp.update(probes.ssdp_sweep()), daemon=True)
        ssdp_thread.start()

        # Our own address won't answer ping on some setups. Add it directly.
        me = self.info["local_ip"]
        if me and ipaddress.ip_address(me) in self.subnet:
            self._found(me, 0.0, "this machine")

        # Find the gateway first so the map has a centre to hang things off
        # while the rest of the sweep is still running.
        gw = self.info["gateway"]
        first = [gw] if gw in addrs and gw != me else []
        for ip in first:
            self._discover(ip)

        with ThreadPoolExecutor(max_workers=64) as pool:
            list(pool.map(self._discover, [a for a in addrs if a != me and a not in first]))
        if me in addrs:
            self.emit({"type": "probe", "ip": me, "alive": True})

        # Anything we tried to reach is now in the ARP cache if it exists at
        # all, even if it ignored every probe. Those are the quiet ones.
        arp = netinfo.arp_table()
        for ip in arp:
            if ip not in self.hosts and ipaddress.ip_address(ip) in self.subnet and not self.cancelled:
                self._found(ip, None, "arp only")
                self.emit({"type": "probe", "ip": ip, "alive": True})

        ssdp_thread.join(timeout=4)
        self.emit({"type": "phase", "phase": "identify", "hosts": len(self.hosts)})

        with ThreadPoolExecutor(max_workers=24) as pool:
            list(pool.map(lambda ip: self._enrich(ip, arp, ssdp), list(self.hosts)))

        if not self.cancelled:
            self.store.save()
        self.emit({
            "type": "done",
            "cancelled": self.cancelled,
            "hosts": len(self.hosts),
            "seconds": round(time.time() - self.started, 1),
        })
        with self.cond:
            self.done = True
            self.cond.notify_all()
