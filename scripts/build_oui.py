"""Rebuild punchdown/data/oui.tsv.gz from the oui-data npm package.

Usage: python3 scripts/build_oui.py path/to/oui-data/index.json

Only the first line of each registry entry is kept (the company name) and the
usual corporate suffixes get trimmed so the UI shows "Apple" not
"Apple, Inc.".
"""
import gzip
import json
import re
import sys
from pathlib import Path

SUFFIX = re.compile(
    r"[,.]?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|gmbh|"
    r"ag|sa|s\.a|bv|b\.v|plc|pty|oy|ab|as|srl|spa|kk|technologies|technology|"
    r"electronics|international)\.?$",
    re.I,
)


def tidy(name: str) -> str:
    name = name.split("\n", 1)[0].strip().strip(",")
    for _ in range(3):
        new = SUFFIX.sub("", name).strip().strip(",")
        if new == name or not new:
            break
        name = new
    if name.isupper() and len(name) > 4:
        name = name.title()
    return name


def main() -> None:
    src = Path(sys.argv[1])
    data = json.loads(src.read_text(encoding="utf-8"))
    out = Path(__file__).resolve().parent.parent / "punchdown" / "data" / "oui.tsv.gz"
    lines = [f"{k.upper()}\t{tidy(v)}" for k, v in sorted(data.items()) if len(k) == 6]
    with gzip.open(out, "wt", encoding="utf-8", compresslevel=9) as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {len(lines)} prefixes to {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
