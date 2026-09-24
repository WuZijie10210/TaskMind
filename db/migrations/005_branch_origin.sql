-- 005: explicit branch origin pointer (UX patch 2026-09-22)
-- origin_main_message_id = the LAST main message included in the frozen
-- parent_context_snapshot when the branch was created.
-- Snapshot semantics unchanged: a branch still only inherits main history up
-- to creation time; this column just makes the origin point queryable.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS origin_main_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_origin_main
  ON conversations (origin_main_message_id)
  WHERE type = 'branch';

-- Backfill existing branches from their (immutable) snapshots: the last
-- message in the frozen array is the origin. The regex guard keeps the uuid
-- cast safe against any legacy non-uuid ids; branches with empty snapshots
-- (main was empty at creation) stay NULL.
UPDATE conversations
SET origin_main_message_id = (parent_context_snapshot -> 'messages' -> -1 ->> 'messageId')::uuid
WHERE type = 'branch'
  AND origin_main_message_id IS NULL
  AND parent_context_snapshot IS NOT NULL
  AND jsonb_array_length(parent_context_snapshot -> 'messages') > 0
  AND (parent_context_snapshot -> 'messages' -> -1 ->> 'messageId') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
