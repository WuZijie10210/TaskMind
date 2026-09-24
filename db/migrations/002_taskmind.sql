-- 002_taskmind.sql — TaskMind core schema
--
-- Designed for future extension (branch conversations, artifacts, deposition):
--   * conversations.type          'main' | 'branch' (branch reserved for phase 2)
--   * conversations.parent_context_snapshot
--                                JSONB snapshot of the main-line context captured
--                                when a branch is created (phase 2); NULL for now.

CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                 UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type                    TEXT NOT NULL DEFAULT 'main' CHECK (type IN ('main', 'branch')),
  title                   TEXT NOT NULL DEFAULT '主线对话',
  parent_context_snapshot JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_task ON conversations (task_id);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);
