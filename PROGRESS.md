# Progress
Last updated: 2026-10-30

## Current goal
Indonesian-focused fork of God's Eye View (upstream: bilawalsidhu/gods-eye-view):
Indonesia as default region for every feature; working Jakarta/Depok CCTV; free fire + AQ sources.

## Done (recent)
- (uncommitted) Indonesia AQ (ISPU) in the Air quality layer: server proxy
  server/providers/airQualityIndonesia.js (/api/air-quality/indonesia -> SiPongi /api/aqms, 10 min cache,
  3 h stale, 60 s backoff, rate-limited); src/layers/airQuality/ispu.js (province -> WIB/WITA/WIT, lon
  fallback, explicit zone wins; dup cities get address suffix); composite source keeps each provider's last
  good readings (<6 h) on failure; cross-scale ranking by position inside band (model.js bandPosition).
  Credits, voice aliases (ispu, kualitas udara, polusi udara), DATA_SOURCES.md, 4 strings x 10 locales.
  Live smoke: 109 stations. Proxy only exists in dev/preview/standalone servers (static deploy = Canada only).
  Tests: ispu.test (29), airQualityIndonesia.test (17), source.test +20, model.test +6.
  Full suite 9181/9193 run, 2 fails = known Windows flakes; build, i18n, boundaries OK.
- (uncommitted) Keyless FIRMS fallback: without FIRMS_MAP_KEY, /api/firms serves NASA public
  SouthEast_Asia_24h CSVs (NOAA-20/21, SNPP, MODIS; 16 MB cap), payload/status carry
  coverage 'southeast-asia' vs 'world'; caches tagged by coverage; failure backoff 30 s doubling to 30 min,
  scoped per coverage. UI label 'LIVE · SE Asia', getActiveFires note, voice prompt, key-setup text, .env.example,
  QA B7 updated. Tests: server/providers/firms.test.mjs (new, 8), hazards.test +3, environmentProviders updated.
  Live smoke: ~7.6k fires, ~4.9k in Indonesia. Full suite 9111/9114 (remaining fails = Windows flakes).
- (uncommitted) Indonesia defaults + CCTV repair:
  - Jakarta CCTV json 514 -> 251 rows: dropped jmlive.jasamarga (empty body, session-gated; not bypassed),
    stream.bsdtol (404), cctvdesari (DNS), cijagolive (expired cert), 20 dead 404s, 2 unfixable coords;
    repaired 34 corrupt coords (missing decimals / swapped). Origins removed from allowlist.
    Loader west bound 106.5 -> 106.2 (Tangerang toll cams). Loader now serves 250 (was 210).
  - Depok: +10 Dishub cams (dishub.depok.go.id/cctv list), -2 dead; Depok/Bogor rows without
    heading are no longer marked 'curated'.
  - HLS puller (server/providers/cctv/stream.js): finite `#EXT-X-ENDLIST` clips (Depok VOD,
    static playlist) are re-ingested once their media time has played out -> feed no longer freezes.
  - Catalog cap: Indonesian packs `priority: true`, filled before round-robin (cap.js/catalog.js).
  - Viewer DEFAULT_VIEW_RECTANGLE = Indonesia; cyclones auto-select storm nearest Indonesia, labels
    JTWC/NHC; regional news Google News `gl=ID`; voice: Indonesia radio center + inferCountry box;
    scene demos (flights-radar, city-overload, omniscience-pullback, thermal-threats) retargeted.
  - Full suite 9098/9110 before last small fixes (2 known Windows flakes, pass alone); build OK.
- 4f259ba Harden Indonesian CCTV, RainViewer and cyclone providers.
- e2bb334 Merged upstream v0.3.0.

## In progress
- Nothing half-finished. Finite-clip replay tests added (cctvHlsStream.test.mjs 13/13); touched suites 51/51,
  i18n complete, boundaries clean, Prettier clean. All work is uncommitted.

## Next steps
1. User decides: commit/push the uncommitted work.
2. Optional integrations (researched 2026-10-30, not built):
   - Fire backup: SiPongi opsroom.sipongidata.my.id/api/opsroom/indoHotspot (undocumented).
   - AQ fallback: Open-Meteo air-quality-api (keyless, CORS, modelled not measured; CC BY).
3. Run the app and spot-check Depok feeds keep moving after ~70 s, and the AQ layer over Indonesia.

## Decisions and notes
- Stack: Vite + CesiumJS (`src/`), Node provider server (`server/`), Node >=24.14 <25 or 26.x.
- Checks: `npm test` (~9.1k tests, ~2.5 min), `npm run i18n`, `npm run check:boundaries`, `npm run build`.
- New UI strings: `t()`/`msg()` + all 10 locale JSONs.
- Jasa Marga jmlive feeds are deliberately not used: they need a browser session (bot gate).
- HLS always goes through the server puller; client never sees ENDLIST, so clip-replay lives server-side.
- Share-link lat/lon defaults stay 0/0 (wire format). Lightning still NOAA nowCOAST data.
- `.env` holds real keys and is gitignored.

## Known issues
- inferCountry Indonesia box is coarse: Singapore/Malaysia/Brunei/Timor-Leste points resolve to Indonesia.
- Depok Dishub clips rotate slowly or not at all (same bytes 90 s apart); 2 cams intermittently empty.
- src/data/dataCredits.js still describes NHC/CPHC as Atlantic/E. Pacific only (accurate for NHC).
- Windows-only test flakes: KML isolated-process timeout, changelogFragments under load (ENOTEMPTY).
- FIRMS open Lows: partial-source failure cached for full 30 min TTL; no redirect:'error' hardening;
  key/keyless share one cache slot (mode switch refetches); key flip mid-flight can 502 once;
  getStats SE Asia label not unit-tested.
- AQ: SiPongi feed is unofficial/undocumented; some upstream addresses are junk ("Jakarta · 4").
  A partial provider failure is only console.warn'd (card does not say one network is down).
