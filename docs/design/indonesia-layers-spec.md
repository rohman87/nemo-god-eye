# Indonesia layers: visual encoding spec

Direction: **Tactical Plot** (existing). Dark basemap, thin bright vector marks, no decoration, color only where it carries meaning. Every layer below uses existing primitives only: Cesium entities, the shared overlay label entry (`variant:'label'`, `title`, `accent`, `priority`), row `chips` / `legend` / `info` / `list`, and the weather readout card.

## 0. Global encoding rules (why layers do not collide)

Three channels separate layers that can be on together. A layer must differ from its neighbours in at least two.

| Channel | Earthquakes | Volcanoes | Disaster reports | Forest alerts | Fishing |
|---|---|---|---|---|---|
| Geometry | big ground-clamped discs (km) | screen-size triangle billboards | screen-size round dots | raster pixels | diamonds + lines |
| Hue family | red / orange / yellow (depth) | violet / white (level) + aviation ring | blue, rust, grey, teal, brown, white | pink ladder | steel grey line, mint / white diamonds |
| Outline | same hue as fill | 1 px `#0b0f14` | 1.5 px `#e8eef5` | none | 1 px `#0b0f14` |

- Common neutrals: unknown / quiet `#6b7785` (matches `AIR_QUALITY_UNKNOWN_COLOR`), text-white `#e8eef5`, halo / outline dark `#0b0f14`.
- Labels use the existing overlay entry, `collisionGroup:'ambient-label'`, `placement:'above'`. `priority` = severity rank x 1000 + tie-break (same scheme as air quality). `accent` = the marker color.
- Only reserved hue meaning: **white ring or white dashed = "act now"** (tsunami potential, volcano Level IV body, highest-confidence alert). Do not use pure white anywhere else.
- Every list `accent` equals the marker color; every legend color equals the marker fill.
- Type: reuse the existing panel fonts and sizes. No new tokens. Spacing: reuse panel spacing.

## 1. Earthquakes (extended with BMKG)

Keep depth colors and disc sizes: `Color.RED` (<70 km), `ORANGE` (<300 km), `YELLOW`; radius `2^M x 1000` m; fill alpha 0.3 (0.4 if M>=5), outline 0.8 (1.0 if M>=5).

**Tsunami potential (BMKG "berpotensi tsunami")**
- Add a second, outline-only ground-clamped **dashed white ring** at 1.6x the disc radius: `PolylineDashMaterialProperty` color `#ffffff` alpha 0.95, dashLength 16, width 2, `clampToGround:true`. Depth disc is untouched, so depth reading survives.
- The disc outline widens to 3 px for these events.
- Label: `M7.1 Tsunami potential`. `priority` = normal + 100000 so it always wins the label budget and bypasses the cohort limit. Accent stays the depth color.
- Never use blue / cyan for this (water-hazard colors are reserved for floods and marine bands).

**Felt reports ("dirasakan", may be < M2.5)**
- Same disc rules, but radius floor 8 000 m so a M1.8 felt event is still visible.
- Add a center dot: point 5 px, fill `#7dd3fc`, outline 1 px `#0b0f14`, no ground clamping.
- Label (only if it wins the normal cohort): `M3.2 Felt`. Felt events get priority +500 (above equal-magnitude silent events, below any M5+).

**Provider (USGS / BMKG)**: not in the on-map label (clutter, no decision value). It appears in the list line and entity description only. Events seen by both providers keep one marker; prefer BMKG's text for tsunami / felt flags.

**Legend** (new `legend` on this row, no counts):
| color | label | blurb |
|---|---|---|
| `#ff0000` | Shallow | Depth under 70 km |
| `#ffa500` | Intermediate | Depth 70 to 300 km |
| `#ffff00` | Deep | Depth over 300 km |
| `#ffffff` | Tsunami potential | Dashed ring. Flagged by BMKG |
| `#7dd3fc` | Felt report | Dot. Reported felt by people |

**List** (optional, top 8 by `priority`): `lead` `M6.1`, `text` `Banda Sea · 18 km · BMKG`, `accent` depth color. Tsunami events append ` · Tsunami potential`.
**Info (only when BMKG fails)**: `BMKG unavailable. Showing USGS only.`

## 2. marine-waves (Weather group, readout card)

**Marker**: billboard direction arrow at each strait (10 points). Arrow points where waves **travel to** (from + 180 deg); all text says "from". Rotation is applied clockwise from north.
- Size by band: 20 px for Calm / Low; 26 px for Moderate / High; 32 px for Very high and above.
- Fill = band color, alpha 0.95, 1 px `#0b0f14` outline. Missing data: `#6b7785`, 20 px, no rotation, alpha 0.6.
- **Threshold ring**: a 2 px `#ffffff` circle behind the arrow when height >= the active vessel threshold (chip). Ring = "unsafe for the selected vessel".

**Bands (BMKG)**, sequential sea ramp, kept away from earthquake hues by shape and by group:
| color | label | blurb |
|---|---|---|
| `#4a90c2` | Calm 0-0.5 m | Tenang |
| `#2ec4b6` | Low 0.5-1.25 m | Rendah |
| `#a3d95b` | Moderate 1.25-2.5 m | Sedang. Small fishing boats at risk |
| `#ffd43b` | High 2.5-4 m | Tinggi. Ferries at risk |
| `#ff8c1a` | Very high 4-6 m | Sangat tinggi. Large ships at risk |
| `#e5383b` | Extreme 6-9 m | Ekstrem |
| `#b5179e` | Very extreme over 9 m | Sangat ekstrem |

**Chips (single-select vessel threshold, default Ferry)**: `Fishing boat` (>1.25 m), `Barge` (>1.5 m), `Ferry` (>2.5 m), `Large ship` (>4 m). Selected chip only moves the white ring and the card status line; band colors never change.

**Labels**: all 10 straits (small, fixed set). Format `Selat Sunda 1.4 m`; no warning glyph in the text, the white ring carries the warning. Accent = band color. `priority` = band rank x 1000 + round(height x 100), so the roughest strait wins when crowded.

**Card summary**
- `label`: `Sea waves`; `coverage`: `Indonesian ferry straits`; `validTime`: forecast issue time (ISO); `detail`: `BMKG marine forecast`; `units`: `m / s / deg`.
- `status`: `{n} of 10 straits above ferry limit (2.5 m)` (threshold text follows the chip); zero case `All straits below ferry limit (2.5 m)`.
- `legend` = the 7 bands, `legendCategorical:true`.
- `list` (all 10, tallest first): `lead` `2.8 m`, `text` `Selat Sunda · from SW · 6 s · High`, `accent` band color. Append ` · Above ferry limit` when over the active threshold. Strait order for ties: Sunda, Bali, Lombok, Madura, Makassar, Karimata, Malaka, Bangka, Sape, Ombai.
- Empty: `status` `No wave data available`. Error: use the shared `translateFeedError` text. No-data strait row: `Selat Bali · No data`.

## 3. disaster-reports (Events group)

**Marker**: point 7 px (9 px if the report has 3+ nearby reports within 5 km, collapsed to one dot), 1.5 px `#e8eef5` outline, alpha 0.9. Clamp to 500 newest. Reports older than 6 h fade to alpha 0.6.
| color | label |
|---|---|
| `#3b82f6` | Flood |
| `#ff7a1a` | Fire |
| `#a8a29e` | Haze |
| `#2dd4bf` | Wind |
| `#e8eef5` | Earthquake report |
| `#9d6b53` | Volcano report |

The white outline plus dot size separates these from earthquake discs (also for the orange fire dot) and from volcano triangles.

**Labels**: none on the map (crowd reports are dense and low-trust). Exception: the single newest report per type gets a `Flood Jakarta Timur` style label (type + district) if on screen, priority 500, accent type color.
**Chips (single-select)**: `6 h`, `24 h` (default).
**Legend** (`count` filled, zero-count entries hidden): label as table above, `blurb` `Crowd reports from PetaBencana`.
**List** (newest 8): `lead` `14:20`, `text` `Flood · Kemang, Jakarta Selatan · 25 cm`, `accent` type color. Text falls back to `Flood report` when no place.
**Info line**: `Unverified crowd reports from PetaBencana.id, last 24 h.`
**Empty**: `No reports in the last 24 hours.` **Error**: `PetaBencana is unavailable.`

## 4. volcanoes (Events group)

**Marker**: upward triangle billboard, 1 px `#0b0f14` outline. Violet ramp keeps clear of the earthquake red / orange / yellow.
| Level | color | size | alpha | legend label | blurb |
|---|---|---|---|---|---|
| I | `#6b7785` | 8 px | 0.6 | Level I Normal | Normal activity |
| II | `#c4b5fd` | 12 px | 0.95 | Level II Waspada | Advisory. Above normal |
| III | `#a855f7` | 16 px | 1.0 | Level III Siaga | Watch. Eruption possible |
| IV | `#f5f3ff` fill, 2 px `#a855f7` outline | 22 px | 1.0 | Level IV Awas | Warning. Eruption imminent |

Level IV is the brightest object on the map (white-body reserved meaning). Level I stays quiet: small, grey, low alpha.

**VONA ring (aviation color code, only when a notice is under 24 h old)**: round ring billboard, diameter = triangle size + 12 px, 2 px stroke, no fill, standard colors:
`GREEN #2ecc71`, `YELLOW #ffd43b`, `ORANGE #ff8c1a`, `RED #e5383b`. Ring is a hollow screen-space circle, so it never reads as a quake disc (those are geographic and filled).

**Labels**: level >= II only. Format `Semeru IV`, with ` VONA RED` appended when a ring exists (`Semeru IV VONA RED`). Accent = level color. `priority` = level x 1000 + VONA rank (RED 3 ... GREEN 0) x 100. Level I: no label (name in hover / list only).
**Chips (toggles)**: `Quiet (Level I)` (default on), `Aviation notices` (default on; hides rings).
**Legend** (`count` = volcanoes at that level; 8 entries): four levels above, then ring entries `VONA GREEN` / `VONA YELLOW` / `VONA ORANGE` / `VONA RED` with counts of active notices; blurbs `No ash expected`, `Ash emission, low risk`, `Ash to flight levels, caution`, `Significant ash. Avoid area`.
**List** (level >= II, highest first, then VONA rank, then name): `lead` `IV`, `text` `Semeru · Awas · VONA RED 3 h ago`, `accent` level color. Without a notice: `Merapi · Siaga`.
**Info**: `PVMBG MAGMA alert levels. Aviation notices from VONA.`
**Empty**: `All monitored volcanoes are at Level I.` (list-empty text). **Error**: `MAGMA is unavailable.`

## 5. forest-alerts (Events group, imagery overlay)

**Pixel recolor** (GFW integrated alerts, decoded client-side). Brightness ladder in one pink hue, so certainty reads as luminance on dark forest imagery:
| color | label | blurb |
|---|---|---|
| `#c06a94` | Lower confidence | Single sensor detection |
| `#ff4f9a` | High confidence | Confirmed by two sources |
| `#ffe0ee` | Highest confidence | Strongest evidence |

**Age fade** (by alert date): 0-30 d alpha 0.95; 31-60 d alpha 0.70; 61-90 d alpha 0.45. Older alerts are not drawn. Layer alpha 1.0; no extra global fade.

**Peatland overlay**: tint `#a1704a`, alpha 0.35, drawn **below** alerts. Legend: `#a1704a` Peatland.
**Chips**: toggles `Alerts` (default on), `Peat` (default off); single-select window `30 d` (default), `90 d`. Window changes the draw cutoff; fade steps stay fixed.
**Legend** (no counts, raster): 3 confidence entries, `Peatland`.
**Info**: `GFW integrated alerts. Fainter pixels are older.` At low zoom: `Zoom in to see individual alerts.`
**Loading**: `Loading alert tiles...` **Error**: `Forest alert tiles are unavailable.` **Empty** (no alerts in view): `No alerts in view for this window.`
No labels, no list.

## 6. fishing-activity (Movement group)

**EEZ lines (always on)**: polylines, ground-clamped, color `#8fb3c9`.
- 200 NM outer limit: solid, width 1.5, alpha 0.85.
- Median line / treaty line (with neighbours): dashed, `dashLength 12`, width 1.5, alpha 0.6.
- No fill.

**Event markers** (only with a configured GFW token), billboard diamonds (rotated square), 1 px `#0b0f14` outline:
- Fishing event: `#5eead4` filled, 9 px, alpha 0.9.
- AIS gap (dark vessel): hollow diamond, 2 px `#e8eef5` stroke, fill `#e8eef5` alpha 0.12, 12 px. Hollow = signal absent. Never red, so it does not read as an alarm without proof.

**Labels**: none for fishing events. AIS gaps: the 5 longest in view, format `AIS gap 14 h`, accent `#e8eef5`, priority = hours x 100.
**Chips (toggles, all default on)**: `EEZ`, `Fishing`, `AIS gaps`.
**Legend** (counts for events only):
| color | label | blurb |
|---|---|---|
| `#8fb3c9` | EEZ 200 NM | Outer limit of the exclusive economic zone |
| `#8fb3c9` | Median or treaty line | Dashed. Boundary with a neighbour |
| `#5eead4` | Fishing event | Vessel fishing behaviour detected |
| `#e8eef5` | AIS gap | Transponder off 6 h or longer |

**List** (gaps first, longest first, then newest fishing): `lead` `14 h`, `text` `AIS gap · KM Sinar Laut · Natuna Sea`; fishing: `lead` `Fishing`, `text` `KM Bahari 07 · 3 h ago`. Unknown name: `Unnamed vessel`.
**Info (no token)**: `Add a Global Fishing Watch API token to show fishing and AIS-gap events. EEZ lines are always shown.`
**Info (token set, nothing)**: `No fishing or AIS-gap events in this window.` **Error**: `Global Fishing Watch is unavailable. EEZ lines are still shown.` **Invalid token**: `Global Fishing Watch rejected the token.`

## Cross-layer check
- Earthquakes + volcanoes + disaster reports on at once: discs (km) vs triangles vs outlined dots; only fire orange `#ff7a1a` is near ORANGE, resolved by size, white outline and shape. White dashed ring (tsunami) and white-body triangle (Level IV) are the only "act now" whites and never share a shape.
- Violet volcano vs pink forest alert: raster pixels vs triangles, and ramps differ (violet `#a855f7` vs pink `#ff4f9a`).
- Marine arrows vs fishing diamonds: both billboards but different groups, shapes (arrow vs diamond) and sizes.

## Implementation notes
- Billboard sprites (triangle, ring, arrow, diamond) as small white-on-transparent canvases tinted by `Billboard.color`; cache one canvas per shape. Use `NearFarScalar` to shrink Level I and fishing marks at high altitude; keep Level IV and tsunami rings unscaled.
- Tsunami dashed ring is a separate entity `earthquake:${stableId}:tsunami`, removed with the parent.
- Legend counts refresh on each fetch; `legendCategorical:true` only for the marine card.
- All user-visible strings are English and go through `t()`; Indonesian terms (Waspada, Siaga, Awas, Tenang...) stay as proper names.
- Pick radius for dots, diamonds and arrows is padded to 12 px so small marks stay tappable; chips and list rows use existing row sizes.
