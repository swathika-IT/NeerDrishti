"""
NeerDrishti SQLite Database Architecture (Phase C)
Persistent local storage for Districts, Citizen Reports, and AI Classifications.
"""

import sqlite3
import os
import json
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple
from src.config import DATABASE_PATH, load_telangana_districts


def get_db_connection() -> sqlite3.Connection:
    """Creates or connects to the local SQLite database with foreign key support."""
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_database() -> None:
    """
    FROZEN (2026-11-04): SQLite schema ownership moved to the TypeScript versioned
    migrator (`migrations/*.sql`, applied with `npm run migrate` via `src/db/migrate.ts`).
    This module must NOT create or alter tables â€” the TS migrator is the single
    source of truth for the SQLite schema.

    This function verifies that the target database has been migrated and raises
    RuntimeError otherwise, so a missing migration is loud, not silent.
    """
    if not os.path.exists(DATABASE_PATH):
        raise RuntimeError(
            f"NeerDrishti database not found at {DATABASE_PATH}. "
            "Create/migrate it with the TS migrator: `npm run migrate`."
        )
    conn = get_db_connection()
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).fetchone()
    conn.close()
    if row is None:
        raise RuntimeError(
            "NeerDrishti database is not migrated (schema_migrations table is missing). "
            "Run `npm run migrate` to apply pending migrations."
        )

def insert_report_with_classification(
    district_name: str,
    location_description: Optional[str],
    incident_type: str,
    severity: str,
    description: str,
    classification: Dict[str, Any],
    classification_source: str = "Meta Llama",
    classification_confidence: float = 1.0,
    image_reference: Optional[str] = None,
    status: str = "New",
) -> Dict[str, Any]:
    """
    Inserts a citizen report and its structured AI/rule classification in a single atomic transaction.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        cursor.execute("BEGIN TRANSACTION;")

        cursor.execute("""
        INSERT INTO citizen_reports (
            district_id, location_description, incident_type, severity,
            description, image_reference, reported_at, created_at,
            classification_source, classification_confidence, ai_processed, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            district_name,
            (location_description or "")[:200],
            incident_type,
            severity,
            description[:1000],
            image_reference,
            now_str,
            now_str,
            classification_source,
            classification_confidence,
            1,
            status,
        ))
        report_id = cursor.lastrowid

        cursor.execute("""
        INSERT INTO report_classification (
            report_id, incident_type, severity, impact, priority,
            summary, recommended_action, model_provider, model_name, processing_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            report_id,
            classification.get("incident_type", incident_type),
            classification.get("severity", severity),
            classification.get("impact", "Localized area"),
            classification.get("priority", "Review"),
            classification.get("summary", description[:150]),
            classification.get("recommended_action", "Avoid low-lying inundated paths."),
            classification.get("model_provider", "Meta Llama" if "Llama" in classification_source else "Rule Engine"),
            classification.get("model_name", "llama3.2:3b" if "Llama" in classification_source else "Rule-Based Fallback"),
            now_str,
        ))

        conn.commit()

        # Fetch joined inserted object
        cursor.execute("""
        SELECT r.*,
               c.impact, c.priority, c.summary as ai_summary,
               c.recommended_action, c.model_provider, c.model_name
        FROM citizen_reports r
        LEFT JOIN report_classification c ON r.id = c.report_id
        WHERE r.id = ?
        """, (report_id,))
        row = cursor.fetchone()
        return dict(row) if row else {}

    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def get_reports_paginated(
    district: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    page: int = 1,
    limit: int = 50,
) -> Tuple[List[Dict[str, Any]], int]:
    """Retrieves filtered citizen reports with pagination and full classification metadata."""
    conn = get_db_connection()
    cursor = conn.cursor()

    conditions = []
    params: List[Any] = []

    if district and district.lower() != "all":
        conditions.append("LOWER(r.district_id) = LOWER(?)")
        params.append(district)

    if severity and severity.lower() != "all":
        conditions.append("LOWER(r.severity) = LOWER(?)")
        params.append(severity)

    if status and status.lower() != "all":
        conditions.append("LOWER(r.status) = LOWER(?)")
        params.append(status)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # Count total
    cursor.execute(f"SELECT COUNT(*) as count FROM citizen_reports r {where_clause}", params)
    total_count = cursor.fetchone()["count"]

    # Select paginated
    offset = max(0, (page - 1) * limit)
    query = f"""
    SELECT r.*,
           c.impact, c.priority, c.summary as ai_summary,
           c.recommended_action, c.model_provider, c.model_name, c.processing_timestamp
    FROM citizen_reports r
    LEFT JOIN report_classification c ON r.id = c.report_id
    {where_clause}
    ORDER BY r.id DESC
    LIMIT ? OFFSET ?
    """
    cursor.execute(query, params + [limit, offset])
    rows = cursor.fetchall()
    results = [dict(row) for row in rows]
    conn.close()
    return results, total_count


def update_report_status(report_id: int, new_status: str) -> Optional[Dict[str, Any]]:
    """Updates report status ('New', 'Reviewed', 'Validated', 'Resolved', 'Rejected')."""
    valid_statuses = {"New", "Reviewed", "Validated", "Resolved", "Rejected"}
    if new_status not in valid_statuses:
        raise ValueError(f"Invalid status '{new_status}'. Allowed: {valid_statuses}")

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE citizen_reports
    SET status = ?
    WHERE id = ?
    """, (new_status, report_id))
    conn.commit()

    cursor.execute("""
    SELECT r.*,
           c.impact, c.priority, c.summary as ai_summary,
           c.recommended_action, c.model_provider, c.model_name
    FROM citizen_reports r
    LEFT JOIN report_classification c ON r.id = c.report_id
    WHERE r.id = ?
    """, (report_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_district_report_aggregation(district_name: str) -> Dict[str, Any]:
    """
    Computes real-time deterministic report metrics from SQLite for a given district.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    # Active reports for district (exclude Rejected)
    cursor.execute("""
    SELECT r.*, c.priority, c.severity as ai_severity
    FROM citizen_reports r
    LEFT JOIN report_classification c ON r.id = c.report_id
    WHERE LOWER(r.district_id) = LOWER(?) AND r.status != 'Rejected'
    ORDER BY r.id DESC
    """, (district_name,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()

    total_count = len(rows)
    if total_count == 0:
        return {
            "district": district_name,
            "total_reports": 0,
            "reports_24h": 0,
            "high_severity_reports": 0,
            "critical_reports": 0,
            "citizen_report_score": 0.0,
            "citizen_points_contribution": 0.0,
            "recent_trend": "Stable",
            "explainability": f"No active citizen hazard reports registered in {district_name}.",
        }

    now = datetime.now()
    twenty_four_hours_ago = now - timedelta(hours=24)

    reports_24h = 0
    high_count = 0
    critical_count = 0
    raw_points = 0.0

    for r in rows:
        # Determine effective severity
        sev = (r.get("ai_severity") or r.get("severity") or "Moderate").capitalize()
        
        # Parse timestamp
        try:
            rep_time = datetime.strptime(r["created_at"], "%Y-%m-%d %H:%M:%S")
        except Exception:
            rep_time = now

        is_recent = rep_time >= twenty_four_hours_ago
        recency_weight = 1.0 if is_recent else 0.40

        if is_recent:
            reports_24h += 1

        if sev == "Critical":
            critical_count += 1
            high_count += 1
            severity_pts = 30.0
        elif sev == "High":
            high_count += 1
            severity_pts = 18.0
        elif sev == "Moderate":
            severity_pts = 8.0
        else:
            severity_pts = 3.0

        raw_points += (severity_pts * recency_weight)

    # Multi-report density bonus if multiple high/critical reports in 24h
    if high_count >= 2:
        raw_points += min(20.0, high_count * 5.0)

    citizen_report_score = min(100.0, round(raw_points, 2))
    citizen_points_contribution = round(citizen_report_score * 0.15, 2)

    # Determine trend
    if reports_24h >= 3:
        trend = "Increasing"
    elif reports_24h >= 1:
        trend = "Stable"
    else:
        trend = "Decreasing"

    # Natural Language Explainability
    if high_count > 0 or critical_count > 0:
        explain_str = (
            f"{total_count} reports registered ({reports_24h} in last 24h), including {high_count} High/Critical incidents. "
            f"Ground field hazard telemetry contributes {citizen_points_contribution} pts to composite flood risk index."
        )
    else:
        explain_str = (
            f"{total_count} reports registered ({reports_24h} in last 24h) with minor/moderate waterlogging. "
            f"Ground telemetry contributes {citizen_points_contribution} pts."
        )

    return {
        "district": district_name,
        "total_reports": total_count,
        "reports_24h": reports_24h,
        "high_severity_reports": high_count,
        "critical_reports": critical_count,
        "citizen_report_score": citizen_report_score,
        "citizen_points_contribution": citizen_points_contribution,
        "recent_trend": trend,
        "explainability": explain_str,
    }


def get_all_districts_report_aggregations() -> Dict[str, Dict[str, Any]]:
    """Returns aggregation metrics for all 33 districts."""
    all_districts = load_telangana_districts()
    return {
        d["district_name"]: get_district_report_aggregation(d["district_name"])
        for d in all_districts
        if d.get("district_name")
    }


def get_report_counts_by_district() -> Dict[str, Dict[str, int]]:
    """Returns total and high severity report counts grouped by district name."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Check column names in citizen_reports
    cursor.execute("PRAGMA table_info(citizen_reports)")
    cols = [col[1] for col in cursor.fetchall()]
    dist_col = "district_id" if "district_id" in cols else "district"

    cursor.execute(f"""
    SELECT r.{dist_col} as district,
           COUNT(r.id) as total,
           SUM(CASE WHEN LOWER(COALESCE(c.severity, r.severity, '')) IN ('high', 'critical') THEN 1 ELSE 0 END) as high
    FROM citizen_reports r
    LEFT JOIN report_classification c ON r.id = c.report_id
    WHERE r.status NOT IN ('Rejected', 'dismissed')
    GROUP BY r.{dist_col}
    """)
    rows = cursor.fetchall()
    conn.close()
    return {
        row["district"]: {
            "total": row["total"] or 0,
            "high": row["high"] or 0,
        }
        for row in rows
    }


def insert_external_signal(
    district_id: str,
    source_name: str,
    source_type: str,
    signal_type: str,
    value: float,
    unit: str,
    data_mode: str = "LIVE",
    freshness: str = "FRESH",
    confidence: float = 1.0,
    is_valid: int = 1,
    recorded_at: Optional[str] = None,
    ingested_at: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> int:
    """Inserts a validated external signal into the external_signals ledger."""
    conn = get_db_connection()
    cursor = conn.cursor()
    now_iso = datetime.utcnow().isoformat() + "Z"
    rec_time = recorded_at or now_iso
    ing_time = ingested_at or now_iso
    meta_str = json.dumps(metadata) if metadata else None

    cursor.execute("""
    INSERT INTO external_signals (
        district_id, source_name, source_type, signal_type,
        value, unit, data_mode, freshness, confidence,
        is_valid, recorded_at, ingested_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        district_id, source_name, source_type, signal_type,
        value, unit, data_mode, freshness, confidence,
        is_valid, rec_time, ing_time, meta_str
    ))
    conn.commit()
    last_id = cursor.lastrowid
    conn.close()
    return last_id


def detect_duplicate_signal(district_id: str, source_name: str, signal_type: str, recorded_at: str) -> bool:
    """Checks if a signal with identical signature already exists."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id FROM external_signals
    WHERE district_id = ? AND source_name = ? AND signal_type = ? AND recorded_at = ?
    LIMIT 1
    """, (district_id, source_name, signal_type, recorded_at))
    row = cursor.fetchone()
    conn.close()
    return bool(row)


def get_all_hydrological_stations(district_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Retrieves all or district-specific hydrological monitoring stations."""
    conn = get_db_connection()
    cursor = conn.cursor()
    if district_id:
        cursor.execute("SELECT * FROM hydrological_stations WHERE district_id = ? ORDER BY station_name ASC", (district_id,))
    else:
        cursor.execute("SELECT * FROM hydrological_stations ORDER BY district_id, station_name ASC")
    rows = cursor.fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        if d.get("metadata") and isinstance(d["metadata"], str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except Exception:
                pass
        result.append(d)
    return result


def get_hydrological_station_by_id(station_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a single station by its ID."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM hydrological_stations WHERE station_id = ? LIMIT 1", (station_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    if d.get("metadata") and isinstance(d["metadata"], str):
        try:
            d["metadata"] = json.loads(d["metadata"])
        except Exception:
            pass
    return d


def get_latest_hydrological_signals(district_id: Optional[str] = None, signal_type: Optional[str] = None) -> List[Dict[str, Any]]:
    """Retrieves latest hydrological observations."""
    conn = get_db_connection()
    cursor = conn.cursor()
    hydro_types = (
        'river_level', 'river_flow', 'reservoir_level',
        'reservoir_storage', 'reservoir_release', 'dam_discharge', 'hydrological_alert'
    )
    if district_id and signal_type:
        cursor.execute("""
        SELECT * FROM external_signals
        WHERE district_id = ? AND signal_type = ? AND is_valid = 1
        ORDER BY recorded_at DESC
        """, (district_id, signal_type))
    elif district_id:
        placeholders = ",".join("?" * len(hydro_types))
        cursor.execute(f"""
        SELECT * FROM external_signals
        WHERE district_id = ? AND signal_type IN ({placeholders}) AND is_valid = 1
        ORDER BY recorded_at DESC
        """, (district_id, *hydro_types))
    elif signal_type:
        cursor.execute("""
        SELECT * FROM external_signals
        WHERE signal_type = ? AND is_valid = 1
        ORDER BY recorded_at DESC
        """, (signal_type,))
    else:
        placeholders = ",".join("?" * len(hydro_types))
        cursor.execute(f"""
        SELECT * FROM external_signals
        WHERE signal_type IN ({placeholders}) AND is_valid = 1
        ORDER BY recorded_at DESC
        """, hydro_types)
    rows = cursor.fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        if d.get("metadata") and isinstance(d["metadata"], str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except Exception:
                pass
        result.append(d)
    return result


def insert_forecast_snapshot(
    district_id: str,
    forecast_generated_at: str,
    forecast_horizon_hours: int,
    projected_risk_score: float,
    current_risk_score: float,
    projected_risk_change: float,
    risk_trend: str,
    outlook_category: str,
    confidence: str,
    confidence_score: float,
    data_mode: str,
    primary_drivers: Optional[List[Any]] = None,
    supporting_signals: Optional[List[Any]] = None,
    forecast_sources: Optional[List[str]] = None,
    limitations: Optional[List[str]] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> int:
    """Inserts a forecast projection snapshot into the database."""
    conn = get_db_connection()
    cursor = conn.cursor()
    now_str = datetime.utcnow().isoformat()
    cursor.execute("""
    INSERT INTO forecast_snapshots (
        district_id, forecast_generated_at, forecast_horizon_hours,
        projected_risk_score, current_risk_score, projected_risk_change,
        risk_trend, outlook_category, confidence, confidence_score, data_mode,
        primary_drivers, supporting_signals, forecast_sources, limitations,
        metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        district_id,
        forecast_generated_at,
        forecast_horizon_hours,
        projected_risk_score,
        current_risk_score,
        projected_risk_change,
        risk_trend,
        outlook_category,
        confidence,
        confidence_score,
        data_mode,
        json.dumps(primary_drivers) if primary_drivers else None,
        json.dumps(supporting_signals) if supporting_signals else None,
        json.dumps(forecast_sources) if forecast_sources else None,
        json.dumps(limitations) if limitations else None,
        json.dumps(metadata) if metadata else None,
        now_str
    ))
    conn.commit()
    inserted_id = cursor.lastrowid
    conn.close()
    return inserted_id


def get_latest_district_forecast_snapshots(district_id: str) -> List[Dict[str, Any]]:
    """Retrieves the latest forecast snapshots for a given district across horizons."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT * FROM forecast_snapshots
    WHERE district_id = ?
    ORDER BY forecast_generated_at DESC, forecast_horizon_hours ASC
    LIMIT 4
    """, (district_id,))
    rows = cursor.fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        for key in ["primary_drivers", "supporting_signals", "forecast_sources", "limitations", "metadata"]:
            if d.get(key) and isinstance(d[key], str):
                try:
                    d[key] = json.loads(d[key])
                except Exception:
                    pass
        result.append(d)
    return result




