#!/usr/bin/env node
/**
 * Refuses to deploy data that is obviously partial.
 *
 * A `vercel build` reads the working tree, not git, so a smoke-test run
 * left in place ships as if it were real: the observed-flood layer once
 * went live claiming 83 rai when the true figure was 791,647. These checks
 * are the cheapest thing that would have caught that.
 *
 * Usage: node scripts/preflight.mjs   (exits non-zero and explains)
 */
import { readFileSync, existsSync, statSync } from "node:fs";

const problems = [];
const notes = [];
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

// 1. Observed flood: a full run covers a week and many satellite passes.
const metaPath = "public/data/sar_flood_meta.json";
if (!existsSync(metaPath)) {
  problems.push(`${metaPath} missing — the flood layer would render empty`);
} else {
  const m = read(metaPath);
  const days = Math.round((m.window_hours ?? 0) / 24);
  if (days < 6) problems.push(`flood window is ${days} day(s); a full run covers 7`);
  if ((m.tiles_with_flood ?? 0) < 10)
    problems.push(`only ${m.tiles_with_flood} satellite pass(es) contributed flood — a partial run`);
  if ((m.flood_area_rai ?? 0) < 1000)
    problems.push(`flood area ${m.flood_area_rai} rai is implausibly small for a full run`);

  const t = m.tiles;
  if (!t) {
    problems.push("flood metadata has no tile pyramid — the map has nothing to draw");
  } else {
    if ((t.count ?? 0) < 500)
      problems.push(`tile pyramid holds ${t.count} tiles — a full run builds thousands`);
    // The archive is hosted in R2; only a local copy needs a size check.
    const local = `public/data/${t.file}`;
    if (!t.url && !existsSync(local))
      problems.push(`no tile URL and no local ${t.file} — the map would draw nothing`);
    if (existsSync(local)) {
      const kb = statSync(local).size / 1024;
      if (!t.url && kb < 100)
        problems.push(`${t.file} is only ${kb.toFixed(0)} KB — likely a partial run`);
    }
    notes.push(
      `flood tiles: ${t.count} across z${t.min_zoom}-z${t.max_zoom}` +
        (t.url ? ` (hosted)` : ` (local)`),
    );
  }
  notes.push(`flood: ${(m.flood_area_rai ?? 0).toLocaleString()} rai over ${days} days`);
}

// 1b. Buildings density: after the nationwide build the overlay must span
// the country, not just the northern AOI it started with.
const bmPath = "public/data/buildings_density_meta.json";
if (existsSync(bmPath)) {
  const bm = read(bmPath);
  const [w, s, e, n] = bm.grid_bbox ?? [];
  const spansCountry = w <= 97.5 && e >= 105.5 && s <= 6.0 && n >= 20.3;
  if (!spansCountry)
    problems.push(`buildings overlay bbox ${JSON.stringify(bm.grid_bbox)} does not span Thailand`);
  if ((bm.total_buildings ?? 0) < 20_000_000)
    problems.push(`buildings total ${bm.total_buildings} is below a nationwide count (~20M+)`);
  if (!existsSync("public/data/buildings_density.png"))
    problems.push("buildings_density.png missing");
  notes.push(`buildings: ${(bm.total_buildings ?? 0).toLocaleString()} over bbox ${bm.grid_bbox?.map((v) => v.toFixed(1))}`);
}

// 1c. Building footprints: the meta points the app at an archive on R2.
// From z13 the density blob hides in favour of these tiles, so a meta
// whose URL does not answer would leave the layer blank exactly where the
// user zoomed in to see houses.
const btPath = "public/data/buildings_tiles_meta.json";
if (existsSync(btPath)) {
  const t = read(btPath).tiles ?? {};
  if ((t.count ?? 0) < 20_000_000)
    problems.push(`footprint archive holds ${t.count} buildings — a nationwide build has 40M+`);
  const url = t.url && /^https?:/.test(t.url) ? t.url : null;
  if (url) {
    try {
      const res = await fetch(url, {
        headers: { Range: "bytes=0-127" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!(res.ok || res.status === 206))
        problems.push(`footprint archive ${url} answered ${res.status}`);
      else notes.push(`footprints: ${(t.count ?? 0).toLocaleString()} buildings, z${t.min_zoom}-z${t.max_zoom}, archive reachable`);
    } catch (e) {
      problems.push(`footprint archive ${url} unreachable: ${e.message}`);
    }
  } else if (!existsSync(`public/data/${t.file}`)) {
    problems.push(`footprint meta has no hosted URL and no local ${t.file}`);
  } else {
    notes.push(`footprints: local ${t.file} (dev only — not hosted)`);
  }
}

// 2. Rain grid: nulls are legitimate (not yet fetched) but not everywhere.
const gridPath = "public/data/wetness_grid.json";
if (!existsSync(gridPath)) {
  problems.push(`${gridPath} missing`);
} else {
  const g = read(gridPath);
  const total = (g.rows ?? 0) * (g.cols ?? 0);
  const withRain = (g.rain_7d_mm ?? []).filter((v) => v !== null && v !== undefined).length;
  if (total === 0) problems.push("wetness grid has no cells");
  else if (withRain === 0) problems.push("wetness grid has no rain values at all");
  notes.push(`rain grid: ${withRain}/${total} cells measured`);
}

for (const n of notes) console.log(`  ${n}`);
if (problems.length) {
  console.error("\npreflight FAILED — not fit to deploy:");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("\npreflight OK");
