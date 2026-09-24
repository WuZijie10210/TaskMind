-- Each anonymous browser owns its tasks. Existing private tasks remain unowned
-- and are not exposed through public endpoints.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS guest_id UUID;
CREATE INDEX IF NOT EXISTS idx_tasks_guest ON tasks (guest_id, updated_at DESC);

-- Atomic daily counters, shared across app replicas.
CREATE TABLE IF NOT EXISTS demo_quotas (
  subject TEXT NOT NULL,
  day DATE NOT NULL,
  kind TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day, kind)
);
