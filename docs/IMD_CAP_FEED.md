# Official CAP Warning Feeds (IMD and NDMA SACHET)

Phase 8 / Epic 4 integrates official Common Alerting Protocol (CAP 1.2) warning feeds into NeerDrishti. CAP warnings are **forecast/official warnings**, not measured rainfall, river telemetry, or NeerDrishti risk alerts. They do not alter risk weights or thresholds.

## Sources

### IMD CAP

- Default endpoint: `https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml`
- This is the verified public IMD feed referenced through the WMO Alert Hub S3 mirror.
- Verified on 2026-11-05: HTTP 200, public-domain copyright, but **0 RSS items**. The channel `lastBuildDate` was `Sun, 27 Sep 2026 07:56:07 +0000`.
- The previously suggested URL `https://mausam.imd.gov.in/imd_latest/contents/cap_rss.xml` returned **HTTP 404** during verification. It is documented but is not the default.
- Because the live IMD RSS index is currently empty, the exact IMD CAP XML document structure could not be observed. The parser is CAP 1.2 namespace-tolerant and is tested with mocked CAP XML; this is not a claim that a live IMD CAP document has been format-verified.

### NDMA SACHET

- Telangana state feed: `https://sachet.ndma.gov.in/cap_public_website/rss/rss_telangana.xml`
- All-India feed: `https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml`
- Both were reachable on 2026-11-05 (HTTP 200). The state feed had 10 items; the all-India feed had 100 items.
- SACHET relays alerts from multiple senders. Observed senders include `Telangana-SDMA`, and feed authors include `IMD Hyderabad`, `TGiCCC`, and other state SDMAs. **Publisher and sender are stored separately.** SACHET content is not automatically IMD-originated.
- The all-India feed is filtered to Telangana-relevant RSS items before CAP documents are fetched. The state and all-India feeds are deduplicated by CAP identifier, sent timestamp, source, and district.
- SACHET `areaDesc` is frequently generic (`16 districts of Telangana`, `MOD TSRA`, `33 districts of Telangana`). District names and abbreviations commonly appear in the headline. Matching therefore uses headline, description, instruction, event, and area text together.

## Storage model

CAP alerts reuse `external_signals`; no database migration is required.

- `signal_type = 'official_alert'`
- `data_mode = 'FORECAST'`
- `unit = 'severity_code'`
- `value` is the CAP severity rank: Extreme 4, Severe 3, Moderate 2, Minor 1, Unknown 0. It is **not** a measurement.
- `source_name` is one of:
  - `IMD CAP Feed (WMO Alert Hub aggregation)`
  - `NDMA SACHET CAP Feed`
- `metadata` retains the CAP identifier, URL, feed key, publisher, sender, sent/onset/effective/expires timestamps, event, severity, urgency, certainty, headline, description, instruction, areas, matched district IDs, and an explicit non-endorsement disclaimer.
- `district_id` is one row per matched district. State-wide or unresolvable-subset warnings use the single synthetic key `STATE_TELANGANA`.

The new `official_alert` signal type and `FORECAST` signal mode are additive and do not change existing rainfall or hydrology ingestion. CAP warnings are not inserted into `hydrological_alert`.

## Lifecycle and parsing

- Only `status = Actual` is operational. `Test`, `Exercise`, `System`, and `Draft` are rejected.
- Operational `msgType` values are `Alert`, `Update`, and `Cancel`.
- `Cancel` is stored and excluded from active-alert responses.
- Expired warnings remain stored for audit but are excluded from active-alert responses.
- Active views group by CAP identifier + district and expose the newest `sent` record, so an `Update` or `Cancel` supersedes earlier versions.
- Duplicate suppression is based on source + CAP identifier + `sent` + district. Re-running a refresh does not add duplicate rows.
- District matching supports canonical names, common aliases, and observed TGiCCC abbreviations (`MLG`, `KHM`, `BDDK`, `MNCL`, `KRM`, `PPL`, `JSKB`, `NLG`, `SRPT`, `MBB`, `WGL`, `HNK`, `JNG`, `SDP`, `YDDB`, `RR`, `NGKR`, `WNP`, `NRPT`, `JGLG`, and related codes).
- Phrases such as `all districts`, `remaining districts`, `entire Telangana`, `statewide`, or `33 districts` map to a state-wide warning. A generic count below 33 (for example `16 districts of Telangana`) is treated as state scope because the exact subset is not stated; no districts are invented.

## Health and freshness

Feed health is reported per source: `UNKNOWN`, `HEALTHY`, `STALE`, `DEGRADED`, or `OFFLINE`.

- An empty feed is `STALE`, never `HEALTHY`.
- A feed whose newest RSS item is older than `CAP_STALE_AFTER_HOURS` is `STALE`.
- Parse/fetch failures on some items produce `DEGRADED`; a total feed failure produces `OFFLINE`.
- The combined service health is the worst enabled feed state.
- The registry entries `IMD_CAP_FEED` and `SACHET_CAP_FEED` are updated after each refresh.

## API

- `GET /api/cap/status` — feed health, URLs, last success/error, counts, and summary.
- `GET /api/cap/summary` — active warning counts by severity and scope.
- `GET /api/cap/alerts?limit=50&active=true&telangana=true` — latest stored warnings, active by default.
- `POST /api/cap/refresh` — admin-only immediate refresh (rate limited). No notifications are sent.

The Alert Center includes an **Official CAP Warnings** panel with severity, sender, publisher, sent/expiry times, area scope, and the source CAP link. The UI states clearly that CAP content is reproduced from official feeds and is not modified or approved by NeerDrishti.

## Configuration

See `.env.example`:

- `IMD_CAP_ENABLED`, `IMD_CAP_RSS_URL`
- `SACHET_CAP_ENABLED`, `SACHET_CAP_RSS_URL`, `SACHET_CAP_INCLUDE_ALL_INDIA`, `SACHET_CAP_ALL_INDIA_RSS_URL`
- `CAP_TELANGANA_ONLY`
- `CAP_REFRESH_MINUTES`
- `CAP_TIMEOUT_MS`
- `CAP_RETRIES`
- `CAP_RETRY_BACKOFF_MS`
- `CAP_MAX_ITEMS`
- `CAP_STALE_AFTER_HOURS`

## Tests and verification

`npm run test:cap` runs mocked tests covering:

- malformed and non-CAP documents
- namespaced CAP parsing and RSS extraction
- district names, abbreviations, and state-wide phrases
- IMD + SACHET ingestion and all-India prefiltering
- duplicate suppression
- Update and Cancel superseding
- expired warning filtering
- Test/Exercise rejection
- empty feed → `STALE`
- outage/retry → `OFFLINE` without fabricated rows

## Limitations and honest caveats

- The IMD feed currently returns zero items, so no live IMD CAP warning has been observed in this environment.
- The user-supplied IMD URL is 404; the verified S3 mirror is used instead.
- SACHET coverage depends on what NDMA publishes and relays; NeerDrishti does not independently verify the underlying meteorological claim.
- District mapping relies on text and an auditable abbreviation/alias table. It is not polygon/geocode-based; CAP polygons and geocodes are parsed where present but are not used for spatial intersection.
- State-wide and generic-count warnings are stored as a single state row. The exact affected subset is not inferred.
- CAP warnings are informational and do not trigger notifications, risk-score changes, or automatic alerts.
- CAP RSS public-domain/copyright metadata is retained in feed documentation; historical rainfall licence status remains separate and `UNVERIFIED`. No GODL/NDSAP claim is made for the historical dataset.
