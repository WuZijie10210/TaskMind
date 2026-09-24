-- 003_artifacts.sql — deposition (沉淀) & artifacts
--
-- Artifact: a confirmed high-value outcome unit distilled from a stage of a
-- conversation. source_message_ids traces it back to the exact chat messages
-- it came from.
--
-- DepositionJob: one "沉淀" click. The stage SOURCE is frozen at creation
-- (ids + content snapshot); messages produced afterwards never enter an
-- existing job. cursor_message_id records the stage cut-off this job covers;
-- confirmed / discarded jobs advance the cut-off, failed jobs do not.

CREATE TABLE IF NOT EXISTS artifacts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  title                  TEXT NOT NULL,
  type                   TEXT NOT NULL,
  summary                TEXT NOT NULL DEFAULT '',
  content                TEXT NOT NULL,
  source_message_ids     UUID[] NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id, created_at);

CREATE TABLE IF NOT EXISTS deposition_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing','ready','confirmed','discarded','failed')),
  source_message_ids  UUID[] NOT NULL DEFAULT '{}',
  source_snapshot     JSONB NOT NULL DEFAULT '{}',
  candidate_artifacts JSONB,
  cursor_message_id   UUID,
  outcome             TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deposition_jobs_conv ON deposition_jobs (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deposition_jobs_task ON deposition_jobs (task_id, updated_at);

-- At most ONE processing|ready job per conversation at any time (enforced at
-- the storage layer, not just in route code).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_deposition_per_conv
  ON deposition_jobs (conversation_id) WHERE status IN ('processing','ready');
