-- Preserve the messages that supported each confirmed result, including when
-- its originating branch is later deleted. Existing results with surviving
-- messages are backfilled in their recorded order.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source_conversation_title TEXT;

UPDATE artifacts a
SET source_conversation_title = c.title
FROM conversations c
WHERE a.source_conversation_id = c.id AND a.source_conversation_title IS NULL;

UPDATE artifacts a
SET source_snapshot = COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object('id', m.id, 'role', m.role, 'content', m.content)
    ORDER BY src.position
  )
  FROM unnest(a.source_message_ids) WITH ORDINALITY AS src(id, position)
  JOIN messages m ON m.id = src.id
), '[]'::jsonb)
WHERE a.source_snapshot = '[]'::jsonb AND cardinality(a.source_message_ids) > 0;
