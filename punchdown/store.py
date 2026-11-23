"""Everything punchdown remembers lives in one JSON file in your home folder.

~/.punchdown/state.json, mode 600. Nothing is synced anywhere. Delete the
folder and punchdown forgets your network.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict

DEFAULT_DIR = Path(os.environ.get("PUNCHDOWN_HOME", Path.home() / ".punchdown"))


class Store:
    def __init__(self, folder: Path = DEFAULT_DIR):
        self.folder = Path(folder)
        self.path = self.folder / "state.json"
        self.lock = threading.Lock()
        self.data: Dict[str, Any] = {"devices": {}, "layout": {}, "extras": [], "links": {}}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for key in self.data:
                    if isinstance(raw.get(key), type(self.data[key])):
                        self.data[key] = raw[key]
        except (OSError, ValueError):
            pass

    def save(self) -> None:
        with self.lock:
            self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.folder, prefix=".state-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self.data, fh, indent=1)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            except OSError:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    @staticmethod
    def key_for(host: dict) -> str:
        # Randomized MACs rotate, so for those the IP is the steadier key.
        mac = host.get("mac")
        if mac and not host.get("randomized_mac"):
            return mac
        return "ip:" + host["ip"]

    def remember(self, host: dict) -> dict:
        """Merge a fresh scan result with what we knew before. Returns the
        stored record (label, colour, first_seen)."""
        key = self.key_for(host)
        now = int(time.time())
        with self.lock:
            rec = self.data["devices"].setdefault(key, {"first_seen": now})
            is_new = rec.get("last_seen") is None
            rec["last_seen"] = now
            for field in ("ip", "mac", "vendor", "kind", "hostname"):
                if host.get(field):
                    rec[field] = host[field]
            return {**rec, "key": key, "new": is_new}

    def set_label(self, key: str, label: str, color: str) -> bool:
        with self.lock:
            rec = self.data["devices"].get(key)
            if rec is None:
                return False
            if label:
                rec["label"] = label[:40]
            else:
                rec.pop("label", None)
            rec["color"] = color
        self.save()
        return True

    def forget(self, key: str) -> None:
        with self.lock:
            self.data["devices"].pop(key, None)
            self.data["layout"].pop(key, None)
            self.data["links"].pop(key, None)
        self.save()
