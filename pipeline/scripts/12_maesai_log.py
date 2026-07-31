"""Phase B — append-only logger for the Mae Sai water-level chain.

HII's public API only exposes the LATEST reading per station:
  · /waterlevel_graph  → 500s (server-side panic, verified)
  · /waterlevel_load   → ignores station_id, returns all stations' latest

So a lead-time forecast for the Mae Sai Friendship Bridge is impossible
today: we have no history to calibrate travel time against. This script
builds that history ourselves — run it on a schedule and it appends the
four Sai-river stations to a JSONL log. Once a few rainy days are
captured, cross-correlating upstream vs bridge series gives an empirical
lag, and only then should the app show a "น้ำถึงสะพานใน ~X ชม." number.

Station chain (HII oldcodes; installed for Mae Sai flood early warning):
  MYA001 บ้านโจตาดา              ~21 km upstream, ground 511.7 m
  MYA002 บ้านดอยต่อคำ            ~2.5 km upstream, ground 399.4 m
  MYA004 สะพานมิตรภาพแม่น้ำสายฯ  ← the target, ground 392.7 m
  MYA003 สะพานอูทูนอ่อง บ้านสบสาย ~8.5 km downstream

Output: public/data/maesai_log.jsonl — one JSON object per poll:
  {"t": "<poll ISO>", "readings": [{code, name, dt, msl, prev, sp, lat, lon}, ...]}

De-duplicates: if every station's `waterlevel_datetime` is unchanged from
the previous entry, nothing is appended (HII often serves a stale value
between telemetry pushes).

Run:
  uv run python scripts/12_maesai_log.py
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT = REPO_ROOT.parent / "public" / "data" / "maesai_log.jsonl"
WATERLEVEL_URL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel"

# Upstream → downstream. Order matters for the frontend panel.
CHAIN = ["MYA001", "MYA002", "MYA004", "MYA003"]

# Keep the log bounded so the repo doesn't grow without limit.
# 4 readings/entry, ~48 entries/day → ~35k entries ≈ 2 years at 30-min polls.
MAX_ENTRIES = 35_000


def num(v):
    try:
        f = float(v)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def main() -> int:
    # stdlib only — this runs on a bare python3 in CI, no venv/uv sync needed.
    try:
        req = urllib.request.Request(
            WATERLEVEL_URL, headers={"User-Agent": "FlashfloodRiskIntelligence/1.0"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            rows = json.loads(resp.read().decode("utf-8")).get("data", [])
    except Exception as e:  # network/HII outage — exit 0 so cron doesn't alarm
        print(f"[skip] fetch failed: {e}", file=sys.stderr)
        return 0

    by_code: dict[str, dict] = {}
    for row in rows:
        st = row.get("station") or {}
        code = st.get("tele_station_oldcode")
        if code in CHAIN:
            by_code[code] = row

    missing = [c for c in CHAIN if c not in by_code]
    if missing:
        print(f"[warn] stations absent from feed: {missing}", file=sys.stderr)
    if not by_code:
        print("[skip] no chain stations in feed", file=sys.stderr)
        return 0

    readings = []
    for code in CHAIN:
        row = by_code.get(code)
        if not row:
            continue
        st = row["station"]
        readings.append(
            {
                "code": code,
                "name": (st.get("tele_station_name") or {}).get("th"),
                "dt": row.get("waterlevel_datetime"),
                "msl": num(row.get("waterlevel_msl")),
                "prev": num(row.get("waterlevel_msl_previous")),
                "sp": num(row.get("storage_percent")),
                "lat": st.get("tele_station_lat"),
                "lon": st.get("tele_station_long"),
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    existing = OUT.read_text().splitlines() if OUT.exists() else []

    # Skip if every station reports the same telemetry timestamp as last time.
    if existing:
        try:
            last = json.loads(existing[-1])
            prev_dts = {r["code"]: r.get("dt") for r in last.get("readings", [])}
            if all(prev_dts.get(r["code"]) == r["dt"] for r in readings):
                print("[skip] no new telemetry since last poll")
                return 0
        except Exception:
            pass

    entry = {"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "readings": readings}
    existing.append(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
    if len(existing) > MAX_ENTRIES:
        existing = existing[-MAX_ENTRIES:]
    OUT.write_text("\n".join(existing) + "\n")

    print(f"[append] {len(readings)} stations · total entries {len(existing)}")
    for r in readings:
        d = (r["msl"] - r["prev"]) * 100 if r["msl"] is not None and r["prev"] is not None else None
        print(
            f"  {r['code']} {(r['name'] or '')[:26]:28s} sp={r['sp']:>6} "
            f"Δ={f'{d:+.1f}cm' if d is not None else '-':>9s} {r['dt']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
