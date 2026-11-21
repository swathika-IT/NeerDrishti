-- NeerDrishti migration 002: canonicalise citizen_reports (SQLite dialect)
-- Additive columns + deterministic, verified-value rewrites only.
-- NO rows are deleted. Rewrites use an explicit mapping table built from
-- the districts table (verified 2026-11-04); unmatched values are left untouched
-- and must be reported by the post-migration check, never guessed.

ALTER TABLE citizen_reports ADD COLUMN reporter_user_id INTEGER REFERENCES users(id);
ALTER TABLE citizen_reports ADD COLUMN locality TEXT;
ALTER TABLE citizen_reports ADD COLUMN lat REAL;
ALTER TABLE citizen_reports ADD COLUMN lng REAL;
ALTER TABLE citizen_reports ADD COLUMN updated_at TEXT;

-- Verified mapping (exact, case-insensitive name match against districts.district_name):
--   'Hyderabad'             -> 'hyderabad'
--   'Warangal'              -> 'warangal'
--   'Bhadradri Kothagudem'  -> 'bhadradri_kothagudem'
--   'Nirmal'                -> 'nirmal'
CREATE TEMP TABLE report_district_map (old TEXT PRIMARY KEY, new TEXT NOT NULL);
INSERT INTO report_district_map (old, new) VALUES
  ('Hyderabad', 'hyderabad'),
  ('Warangal', 'warangal'),
  ('Bhadradri Kothagudem', 'bhadradri_kothagudem'),
  ('Nirmal', 'nirmal');

UPDATE citizen_reports
SET district_id = (SELECT new FROM report_district_map m WHERE m.old = citizen_reports.district_id)
WHERE district_id IN (SELECT old FROM report_district_map)
  AND EXISTS (SELECT 1 FROM districts d WHERE d.district_id = (SELECT new FROM report_district_map m WHERE m.old = citizen_reports.district_id));

DROP TABLE report_district_map;

-- Unified status vocabulary (known legacy values only; others untouched):
UPDATE citizen_reports SET status = CASE status
  WHEN 'New' THEN 'PENDING'
  WHEN 'Reviewed' THEN 'UNDER_REVIEW'
  WHEN 'Validated' THEN 'VERIFIED'
  WHEN 'Resolved' THEN 'RESOLVED'
  WHEN 'Rejected' THEN 'REJECTED'
  ELSE status
END;

-- Backfill moderation history for pre-existing reports (system legacy entry).
INSERT INTO report_moderation_history (report_id, from_status, to_status, actor_user_id, actor_role, reason, created_at)
SELECT id, 'LEGACY', status, NULL, 'SYSTEM', 'Backfilled during status vocabulary migration', '2026-11-04T00:00:00.000Z'
FROM citizen_reports
WHERE NOT EXISTS (SELECT 1 FROM report_moderation_history h WHERE h.report_id = citizen_reports.id);

-- FIX REFUSED without explicit approval: hydrological_stations.district_id 'rangareddy'
-- has no counterpart in districts (canonical id is 'ranga_reddy'). Unambiguous, but it is
-- a silent-row edit, so it is intentionally NOT included here. Run only with approval:
--   UPDATE hydrological_stations SET district_id = 'ranga_reddy' WHERE district_id = 'rangareddy';
