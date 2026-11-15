"""Backwards-compatible CLI/web entrypoint for Backend/fortisoar-sim/app.py."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_APP_PATH = Path(__file__).resolve().parent.parent / "fortisoar-sim" / "app.py"


def main() -> None:
    spec = importlib.util.spec_from_file_location("fortisoar_sim_app", _APP_PATH)
    if spec is None or spec.loader is None:
        sys.exit(f"unable to load simulator entrypoint: {_APP_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.main()


if __name__ == "__main__":
    main()
