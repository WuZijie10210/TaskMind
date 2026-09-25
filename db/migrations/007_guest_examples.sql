-- Record which browser has received its own editable example tasks.
-- A UNIQUE guest id makes the first-visit insert safe under concurrent requests.
CREATE TABLE IF NOT EXISTS guest_example_seeds (
  guest_id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
