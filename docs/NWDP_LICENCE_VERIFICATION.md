# NWDP "Rainfall DistrictWise Daily IMD" — Licence Verification

**Verdict (2026-11-04): LICENCE UNVERIFIED. GODL / NDSAP-India is NOT explicitly applicable to this resource. The project must not claim confirmed open-licence status for this data.**

## What was checked

| # | Evidence | Result |
|---|---|---|
| 1 | Exact resource page: `https://nwdp.nwic.gov.in/dataset/rainfall-daily-imd/resource/8752174f-1d17-4aaf-8058-2eb396f50157` | Metadata Information block lists **`License: No License Provided`** |
| 2 | Dataset page: `https://nwdp.nwic.gov.in/dataset/rainfall-daily-imd` | Metadata Information lists only `Last Update Date` — **no licence field** |
| 3 | Portal footer on both pages | `© 2025 NWIC All Rights Reserved.` |
| 4 | Portal Copyright Policy: `https://nwdp.nwic.gov.in/footer/copyrightPolicy` | Generic Government-of-India site notice: material may be reproduced with **prominent source acknowledgement**, excluding third-party copyright. **Does not name GODL, NDSAP, or a dataset licence.** |
| 5 | Downloaded file itself (sha256 `05F43A430D4C12EB634976AA984B7A104493FBBF2D03F6F9AC2C9BBB0A2022B3`, 9,096,886 bytes) | No embedded licence, copyright or attribution header; pure CSV data rows |
| 6 | National Water Data Policy (draft, 2026) — `nwic.gov.in` | Policy document that *aspires* to open data and APIs; **not a licence grant for this resource** |
| 7 | data.gov.in OGD/GODL-India | Applies to datasets published on the OGD platform; this resource is published on NWDP, which shows no licence. **No evidence of GODL applicability.** |

Access date for all checks: **2026-11-04**. URLs were fetched live; the exact resource page is the authoritative artefact (quote: *"License — No License Provided"*).

## Consequence

- The data was obtained and imported under the portal's general copyright terms (accurate reproduction + prominent source acknowledgement), with attribution recorded on every imported row (publisher, URL, access date, original names).
- The project **must not** describe this dataset as GODL/NDSAP-licensed or "confirmed open licence". It is **UNVERIFIED**.
- If distribution or production use beyond internal research/demonstration is intended, **written permission from NWIC/IMD is required** (helpdesk: `helpdesk-nwic@gov.in`).

## What would change the verdict

1. A dataset-level licence statement on the NWDP resource page (e.g., GODL-India), or
2. A written licence/permission from NWIC/IMD covering redistribution, or
3. The same dataset published on `data.gov.in` under GODL-India.

Until then, status = **UNVERIFIED**.

## Effect on the imported records (unchanged)

- The 2,508 HISTORICAL rows imported in Epic 3 are **preserved unmodified**.
- Their stored `metadata.licence` (and the earlier report artifact) carry the pre-verification string `"Government Open Data License - India (GODL / NDSAP)"` and `source_name` contains the legacy token `(GODL-India)`. These are **legacy identifiers only**; the token is superseded by this document and must not be quoted as a licence confirmation.
- The `source_name` string is kept stable intentionally to preserve duplicate-detection keys for future imports; it does **not** assert a licence.
- Future imports record `metadata.licence_status = "UNVERIFIED"` and the corrected licence note via `scripts/import_historical_rainfall.ts`.
