-- 004_references.sql — @Artifact / @Task explicit references.
--
-- A message_reference records "this chat turn explicitly pulled in these
-- historical outcomes". It is the OPPOSITE direction of artifacts.
-- source_message_ids (artifact provenance: which messages BUILT the artifact).
--
-- reference_id is polymorphic (artifact id or task id) — validated at the
-- application layer, no FK.
--
-- artifact_snapshots freezes the EXACT content that entered the AI context at
-- send time: later artifact edits must never rewrite historical context
-- (same freezing principle as branch parent_context_snapshot).

CREATE TABLE IF NOT EXISTS message_references (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id           UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reference_type       TEXT NOT NULL CHECK (reference_type IN ('artifact','task')),
  reference_id         UUID NOT NULL,
  display_title        TEXT NOT NULL,
  resolved_artifact_ids UUID[] NOT NULL DEFAULT '{}',
  artifact_snapshots   JSONB NOT NULL DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_references_message ON message_references (message_id);
