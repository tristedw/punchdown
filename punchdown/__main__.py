"""python3 -m punchdown"""
from __future__ import annotations

import argparse
import sys
import webbrowser

from . import __version__
from .server import serve


def main() -> None:
    parser = argparse.ArgumentParser(prog="punchdown", description="Map the devices on your local network.")
    parser.add_argument("-p", "--port", type=int, default=8737, help="port to listen on (default 8737, 0 for any)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--version", action="version", version=f"punchdown {__version__}")
    args = parser.parse_args()

    try:
        httpd, app = serve(args.port)
    except OSError:
        # port taken, let the OS pick one
        httpd, app = serve(0)

    url = f"http://127.0.0.1:{app.port}/#k={app.token}"
    print(f"punchdown {__version__} listening on 127.0.0.1:{app.port} (this machine only)")
    print(f"open: {url}")
    print("ctrl+c to stop")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
    sys.exit(0)


if __name__ == "__main__":
    main()
