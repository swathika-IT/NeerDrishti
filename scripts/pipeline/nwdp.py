"""NWDP / NWIC (CKAN datastore) client and field discovery.

Standard CKAN contract: GET {base}/datastore_search?resource_id=...&limit=...&offset=...&filters=...
-> {"success": true, "result": {"fields":[{"id":..,"type":..}], "records":[...], "total": N}}
Field names are DISCOVERED, never assumed.
"""
from __future__ import annotations
import json, re, time
from typing import Iterable, Iterator
from .common import make_session, to_float

BASE = "https://nwdp.nwic.gov.in/api/3/action"
PAGE = 1000

class CkanError(RuntimeError):
    pass

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

class CkanClient:
    def __init__(self, base: str = BASE, session=None, timeout: int = 60, pause: float = 0.3):
        self.base, self.s, self.timeout, self.pause = base.rstrip("/"), session or make_session(), timeout, pause

    def _get(self, action: str, params: dict) -> dict:
        r = self.s.get(f"{self.base}/{action}", params=params, timeout=self.timeout)
        ctype = r.headers.get("Content-Type", "")
        if "json" not in ctype.lower():
            raise CkanError(f"{action}: expected JSON, got {ctype!r} (HTTP {r.status_code}); first bytes: {r.text[:80]!r}")
        body = r.json()
        if not body.get("success"):
            raise CkanError(f"{action}: API reported failure: {json.dumps(body.get('error'))[:300]}")
        return body["result"]

    def describe(self, resource_id: str) -> dict:
        """Schema + size without downloading the data."""
        res = self._get("datastore_search", {"resource_id": resource_id, "limit": 5})
        return {"resource_id": resource_id, "total": res.get("total"),
                "fields": [{"id": f["id"], "type": f.get("type")} for f in res.get("fields", [])],
                "sample": res.get("records", [])[:5]}

    def iter_records(self, resource_id: str, filters: dict | None = None, page: int = PAGE,
                     max_records: int | None = None, sort: str | None = None) -> Iterator[dict]:
        offset, yielded = 0, 0
        while True:
            params = {"resource_id": resource_id, "limit": page, "offset": offset}
            if filters:
                params["filters"] = json.dumps(filters)
            if sort:
                params["sort"] = sort
            res = self._get("datastore_search", params)
            recs = res.get("records", [])
            if not recs:
                return
            for rec in recs:
                yield rec
                yielded += 1
                if max_records and yielded >= max_records:
                    return
            offset += len(recs)
            total = res.get("total")
            if total is not None and offset >= total:
                return
            time.sleep(self.pause)  # polite rate limit

def pick_field(fields: Iterable[str], *needles: str, exclude: Iterable[str] = ()) -> str | None:
    """Find a field by name. Exact (normalised) match on the joined needles wins; otherwise the SHORTEST field
    containing ALL needles (a short name like "River" is a better match than "River Water Level Telemetry (meter)").
    Returns None when nothing matches. Never guesses between unrelated columns."""
    ex = [_norm(e) for e in exclude]
    want = [_norm(x) for x in needles]
    cands = [f for f in fields if all(w in _norm(f) for w in want) and not any(e in _norm(f) for e in ex)]
    if not cands:
        return None
    exact = [f for f in cands if _norm(f) == "".join(want)]
    return exact[0] if exact else min(cands, key=lambda f: len(_norm(f)))

def parse_ts(v) -> str | None:
    """Parse source timestamps to UTC ISO. NWDP timestamps are assumed IST (UTC+5:30) when naive.

    ASSUMPTION (documented in DATA_DICTIONARY): naive 'Data Acquisition Time' values are India Standard Time.
    Verify against the resource description before relying on absolute times.
    """
    from datetime import datetime, timedelta, timezone
    if v is None or str(v).strip() == "":
        return None
    s = str(v).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%d-%m-%Y %H:%M:%S",
                "%d/%m/%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            return (dt - timedelta(hours=5, minutes=30)).replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    try:  # ISO with explicit offset
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo:
            return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        pass
    return None
