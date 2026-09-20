import { EMBEDDING_DIMS } from '../types'
import { VISION_DIMS } from '../decide/match'

/**
 * Schema notes:
 * - UUIDs, updated_at and soft deletes everywhere: the schema is designed to
 *   be ElectricSQL-syncable later without a migration.
 * - chunks.tokens holds Intl.Segmenter word-segmented text (space-joined).
 *   Khmer is written without spaces between words, so Postgres FTS cannot
 *   tokenize it natively; we pre-segment in JS and index with the 'simple'
 *   config, which works uniformly for Khmer and English.
 * - packs groups content by provenance so imported knowledge packs can be
 *   listed, updated and removed cleanly.
 */
export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS packs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  origin text NOT NULL DEFAULT 'imported',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  lang text NOT NULL DEFAULT 'auto',
  source_type text NOT NULL DEFAULT 'text',
  pack_id uuid REFERENCES packs(id) ON DELETE SET NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq int NOT NULL,
  text text NOT NULL,
  tokens text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', tokens)) STORED,
  embedding vector(${EMBEDDING_DIMS}),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Decide (see ../decide/): the personal habit log behind "what should I eat /
-- wear today?". habit_items is the user's own vocabulary — the Khmer name and
-- a visual centroid learned from their confirmed photos; habit_log is what
-- they actually chose, and when. Both stay on the device: only opaque ids and
-- controlled tags are ever built into a remote request (see decide/state.ts).
-- The vector width is VISION_DIMS, NOT EMBEDDING_DIMS — image embeddings are a
-- different model and a different width from the text ones in chunks.
CREATE TABLE IF NOT EXISTS habit_items (
  id uuid PRIMARY KEY,
  domain text NOT NULL,
  label text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  embedding vector(${VISION_DIMS}),
  samples int NOT NULL DEFAULT 0,
  rating real,
  available boolean NOT NULL DEFAULT true,
  -- Cadence the user stated at setup ("I eat this most days"), in days. Lets
  -- rotation work immediately instead of waiting for the log to reveal it;
  -- superseded by observations once enough real entries exist. embedding stays
  -- NULL for items typed rather than photographed.
  seed_gap_days int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS habit_log (
  id uuid PRIMARY KEY,
  item_id uuid REFERENCES habit_items(id) ON DELETE CASCADE,
  domain text NOT NULL,
  slot text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  confirmed boolean NOT NULL DEFAULT false,
  thumb text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS habit_items_domain_idx ON habit_items (domain);
CREATE INDEX IF NOT EXISTS habit_log_item_idx ON habit_log (item_id);
CREATE INDEX IF NOT EXISTS habit_log_at_idx ON habit_log (at DESC);
CREATE INDEX IF NOT EXISTS habit_items_embedding_idx
  ON habit_items USING hnsw (embedding vector_cosine_ops);
`
