"""Rolling 7-day log of the gauges around Krathum Lom municipality.

HII's public API only serves each station's latest reading, so a trend
line on the municipal dashboard needs history we record ourselves. This
runs inside the Mae Sai logging job (same 30-minute schedule, same billed
minute — the repo's free Actions budget has no room for a second cron).

Stations are picked by distance from the municipal office each run, so a
gauge that comes online nearby is picked up without a code change:
  rain  — within 10 km (rain_1h, rain_24h)
  water — within 15 km (waterlevel_msl; % of bank is derived in the app
          from the station's survey levels, which do not change)

Output: public/data/krathumlom_log.jsonl — one JSON object per poll:
  {"t": "<poll ISO>", "rain": [[id, dt, r1, r24], ...], "water": [[id, dt, msl], ...]}
Compact arrays keep 7 days (~336 polls) around 300 KB for the browser.

Skips the append when no station reports a newer telemetry time.

Run:
  python3 pipeline/scripts/19_krathumlom_log.py
"""

from __future__ import annotations

import json
import math
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT = REPO_ROOT.parent / "public" / "data" / "krathumlom_log.jsonl"
RAIN_URL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h"
WATER_URL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel"
UA = {"User-Agent": "FlashfloodRiskIntelligence/1.0"}

OFFICE = (13.7422545, 100.3293329)  # เทศบาลเมืองกระทุ่มล้ม (OSM node 7359270019)
RAIN_KM = 10
WATER_KM = 15
KEEP = timedelta(days=7)


def km(lat: float, lon: float) -> float:
    dlat = math.radians(lat - OFFICE[0])
    dlon = math.radians(lon - OFFICE[1])
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(OFFICE[0])) * math.cos(math.radians(lat)) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))


def num(v):
    try:
        f = float(v)
        return round(f, 3) if f == f else None
    except (TypeError, ValueError):
        return None


def fetch(url: str) -> list[dict]:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.loads(r.read().decode("utf-8")).get("data", [])


def near(rows: list[dict], radius: float) -> list[dict]:
    out = []
    for row in rows:
        st = row.get("station") or {}
        lat, lon = st.get("tele_station_lat"), st.get("tele_station_long")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and km(lat, lon) <= radius:
            out.append(row)
    return sorted(out, key=lambda r: r["id"])


def main() -> int:
    try:
        rain = near(fetch(RAIN_URL), RAIN_KM)
        water = near(fetch(WATER_URL), WATER_KM)
    except Exception as e:  # HII outage — exit 0 so the shared job stays green
        print(f"[skip] fetch failed: {e}", file=sys.stderr)
        return 0
    if not rain and not water:
        print("[skip] no stations near Krathum Lom in the feed", file=sys.stderr)
        return 0

    entry = {
        "t": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rain": [[r["id"], r.get("rainfall_datetime"), num(r.get("rain_1h")), num(r.get("rain_24h"))] for r in rain],
        "water": [[r["id"], r.get("waterlevel_datetime"), num(r.get("waterlevel_msl"))] for r in water],
    }

    lines = OUT.read_text().splitlines() if OUT.exists() else []
    if lines:
        try:
            last = json.loads(lines[-1])
            seen = {("r", x[0]): x[1] for x in last.get("rain", [])} | {("w", x[0]): x[1] for x in last.get("water", [])}
            now = {("r", x[0]): x[1] for x in entry["rain"]} | {("w", x[0]): x[1] for x in entry["water"]}
            if now == seen:
                print("[skip] no new telemetry since last poll")
                return 0
        except Exception:
            pass

    lines.append(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
    cutoff = datetime.now(timezone.utc) - KEEP
    kept = [l for l in lines if datetime.fromisoformat(json.loads(l)["t"]) >= cutoff]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(kept) + "\n")
    print(f"[ok] {len(entry['rain'])} rain + {len(entry['water'])} water gauges · {len(kept)} polls kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
