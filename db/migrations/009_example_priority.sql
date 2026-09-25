-- Curated examples have a stable position in the task list. User tasks keep
-- their regular recency order and appear ahead of examples.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS demo_rank SMALLINT;
