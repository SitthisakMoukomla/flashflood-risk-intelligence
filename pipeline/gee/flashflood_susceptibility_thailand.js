// =====================================================
// Flash Flood Susceptibility — THAILAND (nationwide)
// Static-only hazard: no rain term (rain is the live
// trigger on the frontend, not baked into the raster).
// Weights follow the corrected North run whose output
// is bands SUSCEPTIBILITY + CLASS (float32).
//
// Run in the GEE Code Editor, then Tasks → Run.
// A country-scale export is sharded by GEE into several
// GeoTIFFs in Drive — download ALL of them into
// pipeline/data/gee_exports/ and run
//   uv run python scripts/13_merge_gee_exports.py
// =====================================================

// ---------- 1. AOI: whole Thailand ----------
var aoi = ee.FeatureCollection('FAO/GAUL/2015/level0')
  .filter(ee.Filter.eq('ADM0_NAME', 'Thailand'))
  .geometry();
Map.centerObject(aoi, 6);

var today     = ee.Date(Date.now());
var burnStart = today.advance(-12, 'month');

// ---------- 2. Layers ----------
var dem   = ee.Image('USGS/SRTMGL1_003');
var slope = ee.Terrain.slope(dem);

var merit = ee.Image('MERIT/Hydro/v1_0_1');
var upaM2 = merit.select('upa').multiply(1e6);
var twi   = upaM2.divide(slope.multiply(Math.PI / 180).tan().max(0.001)).log();
var distStream = upaM2.gt(1e6).fastDistanceTransform(128).sqrt().multiply(90);

var evi = ee.ImageCollection('MODIS/061/MOD13Q1')
  .filterDate(today.advance(-90, 'day'), today)
  .select('EVI').mean().multiply(0.0001);

var burned = ee.ImageCollection('MODIS/061/MCD64A1')
  .filterDate(burnStart, today).select('BurnDate').max().gt(0).unmask(0);

var built = ee.ImageCollection('ESA/WorldCover/v200').first().eq(50);

// ---------- 3. Normalize with fixed thresholds (low-memory) ----------
function n(img, lo, hi, invert) {
  var x = img.subtract(lo).divide(hi - lo).clamp(0, 1);
  return invert ? ee.Image(1).subtract(x) : x;
}
var nDEM   = n(dem,        0, 2500, true);   // lowlands → higher risk
var nSLOPE = n(slope,      0,   45, false);
var nTWI   = n(twi,        5,   20, false);
var nDIST  = n(distStream, 0, 3000, true);
var nEVI   = n(evi,        0,  0.6, true);   // sparse vegetation → higher risk

// ---------- 4. Static weighted hazard (sum = 1.00, NO rain) ----------
var hazard = nTWI  .multiply(0.24)
  .add(nSLOPE.multiply(0.18))
  .add(nDIST .multiply(0.18))
  .add(nEVI  .multiply(0.13))
  .add(nDEM  .multiply(0.12))
  .add(burned.multiply(0.10))
  .add(built .multiply(0.05))
  .rename('SUSCEPTIBILITY');

// ---------- 5. Classify with fixed breaks ----------
var cls = ee.Image(1)
  .where(hazard.gte(0.30), 2)
  .where(hazard.gte(0.45), 3)
  .where(hazard.gte(0.60), 4)
  .where(hazard.gte(0.75), 5)
  .toByte().rename('CLASS').updateMask(hazard.mask());

// ---------- 6. Visualize ----------
var pal = ['#1a9850', '#a6d96a', '#fee08b', '#fdae61', '#d73027'];
Map.addLayer(cls.clip(aoi), {min: 1, max: 5, palette: pal}, 'Susceptibility class');
Map.addLayer(hazard.clip(aoi), {min: 0, max: 1, palette: ['white', 'red']},
  'Susceptibility continuous', false);

// ---------- 7. Export (GEE shards big exports automatically) ----------
Export.image.toDrive({
  image: hazard.addBands(cls).toFloat().clip(aoi),
  description: 'FlashFlood_Susceptibility_Thailand',
  folder: 'GEE_Exports',
  fileNamePrefix: 'flashflood_susceptibility_thailand',
  region: aoi,
  scale: 100,
  crs: 'EPSG:4326',
  maxPixels: 1e11,
  fileFormat: 'GeoTIFF',
  formatOptions: {cloudOptimized: true}
});
