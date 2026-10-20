"""Local browser fixture: python tests/serve_swing_fixture.py (127.0.0.1:9017).

Uses an isolated temporary database and test-only auth overrides, never the app
lifespan, broker credentials or production database. Stop server to discard it.
"""
import sys
import tempfile
from pathlib import Path
from dataclasses import replace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd
import uvicorn
from fastapi import FastAPI
from app.config import settings
from app.dependencies import get_current_user, require_premium, get_optional_kite
from app.routes.swing_research import router
from app.services import swing_repository as repo
from app.services import swing_research as research


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="alpha-swing-browser-fixture-") as directory:
        repo.settings = replace(settings, DATA_DIR=Path(directory))
        bars = [{"date": d.strftime("%Y-%m-%d"), "open": 100 + i / 10, "high": 102 + i / 10,
                 "low": 98 + i / 10, "close": 101 + i / 10, "volume": 10000}
                for i, d in enumerate(pd.bdate_range(end="2026-10-16", periods=300))]
        package = research.build_package("nifty50", ["TESTFIXTURE"], {"TESTFIXTURE": bars}, bars)
        package["membership_basis"] = "BROWSER TEST FIXTURE ONLY — synthetic data, not market research"
        package["setups"] = [{"symbol": "TESTFIXTURE", "strategy": "VOL_SQUEEZE", "signal": "BULL",
            "setup_id": repo.identity("test-setup"), "setup_version": repo.identity("test-version"),
            "source_snapshot_id": package["source_snapshot_id"], "session": package["session"],
            "entry_price": 132, "breakout_level": 132, "stop_loss": 126, "target": 145.2,
            "strength": 75, "lifecycle_state": "READY", "notes": "TEST FIXTURE: save and revise a plan",
            "reasons": ["Synthetic fixture bars"], "research_warnings": ["Browser test fixture, not a trade idea"],
            "benchmark_rs_20": 0, "benchmark_rs_60": 0, "target_policy": "Test policy objective"}]
        repo.publish(package)
        app = FastAPI()
        app.include_router(router, prefix="/api/scanner")
        app.dependency_overrides[require_premium] = lambda: {"id": "browser-fixture-user"}
        app.dependency_overrides[get_current_user] = lambda: {"id": "browser-fixture-user"}
        app.dependency_overrides[get_optional_kite] = lambda: None
        uvicorn.run(app, host="127.0.0.1", port=9017)
