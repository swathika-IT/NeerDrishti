-- NeerDrishti migration 003: signal/notification/alert integrity flags and indexes (SQLite dialect)
-- Additive columns and indexes only. No values are rewritten or deleted.

-- Flag known unverified-source LIVE rows for honest handling (values unchanged).
ALTER TABLE external_signals ADD COLUMN flagged_unverified INTEGER NOT NULL DEFAULT 0;
UPDATE external_signals SET flagged_unverified = 1 WHERE source_name = 'IMD AWS Test';

ALTER TABLE notification_history ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE notification_history ADD COLUMN subscription_id INTEGER;
ALTER TABLE notification_history ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'DRY_RUN';
ALTER TABLE notification_history ADD COLUMN provider_message_id TEXT;
ALTER TABLE notification_history ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_history ADD COLUMN last_attempt_at TEXT;

ALTER TABLE alerts_history ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_idempotency
  ON alerts_history(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_citizen_reports_district_status ON citizen_reports(district_id, status, reported_at);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_reported ON citizen_reports(reported_at);
CREATE INDEX IF NOT EXISTS idx_ext_signals_district_recorded ON external_signals(district_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_ext_signals_mode ON external_signals(data_mode);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notification_history(user_id);
