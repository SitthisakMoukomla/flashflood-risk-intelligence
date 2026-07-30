"""Phase 1.11 — Inject Thai admin names from GADM into village_risk.geojson.

GADM 4.1 level-3 for Thailand carries NL_NAME_2 (Thai amphoe names,
"อำเภอแม่สรวย") for every row but NO Thai tambon names (NL_NAME_3 is
NA across all 663 northern subdistricts — checked). So this join adds:

  NL_NAME_2 — Thai อำเภอ name with the "อำเภอ"/"เขต" prefix stripped

into the existing public/data/village_risk.geojson **in place** (plain
JSON edit keyed by GID_3 — never a geopandas rewrite, so columns added
by later scripts, e.g. `buildings` from 08, survive untouched).

Run:
  uv run python scripts/11_add_thai_names.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import geopandas as gpd

REPO_ROOT = Path(__file__).resolve().parents[1]
GADM3_ZIP = REPO_ROOT / "data" / "aoi" / "gadm41_THA_3.json.zip"
TARGETS = [
    REPO_ROOT.parent / "public" / "data" / "village_risk.geojson",
    REPO_ROOT / "data" / "output" / "village_risk.geojson",
]

PREFIX_RE = re.compile(r"^(อำเภอ|เขต)\s*")


def main() -> int:
    if not GADM3_ZIP.exists():
        print(f"missing {GADM3_ZIP} — download gadm41_THA_3.json.zip first", file=sys.stderr)
        return 2

    print("[load] GADM level-3 attributes…")
    g = gpd.read_file(f"zip://{GADM3_ZIP}", ignore_geometry=True)
    thai_amphoe: dict[str, str] = {}
    for _, r in g.iterrows():
        nl2 = r.get("NL_NAME_2")
        if isinstance(nl2, str) and nl2 and nl2 != "NA":
            thai_amphoe[str(r["GID_3"])] = PREFIX_RE.sub("", nl2).strip()
    print(f"[map] {len(thai_amphoe):,} GID_3 → Thai amphoe names")

    for target in TARGETS:
        if not target.exists():
            print(f"[skip] {target} (not found)")
            continue
        fc = json.loads(target.read_text())
        hit = 0
        for feat in fc.get("features", []):
            props = feat.get("properties", {})
            nl2 = thai_amphoe.get(str(props.get("GID_3")))
            if nl2:
                props["NL_NAME_2"] = nl2
                hit += 1
        target.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
        print(f"[write] {target} — {hit}/{len(fc.get('features', []))} features got NL_NAME_2")

    return 0


if __name__ == "__main__":
    sys.exit(main())
