-- Keep old examples intact when an illustrative script is revised.
-- Pristine legacy copies may be hidden from the list after a replacement is
-- installed; direct links and stored references continue to work.
ALTER TABLE guest_example_seeds ADD COLUMN IF NOT EXISTS seed_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_archived_example BOOLEAN NOT NULL DEFAULT FALSE;
