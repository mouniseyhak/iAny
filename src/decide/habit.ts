/**
 * The habit log — the device-local store behind every suggestion.
 *
 * Two tables. `habit_items` is the user's personal vocabulary (the Khmer dish
 * or garment name plus a learned visual centroid); `habit_log` is what they
 * actually ate or wore, and when. Everything sensitive lives here and only
 * here: names, photos, ratings. What ever leaves the device is built by
 * `buildState()`, which emits opaque keys and controlled tags only.
 */
import { toVectorLiteral } from '../lib/base64'
import { getDB } from '../db/client'
import { updateCentroid, VISION_DIMS, type MatchRow } from './match'
import {
  type Candidate,
  type DecisionState,
  type Domain,
  type ContextMap,
  type EnergyBucket,
  type OccasionBucket,
  type RainBucket,
  type Slot,
  type Tag,
  type WeatherBucket,
  type SeedFrequency,
  CANDIDATE_LIMIT,
  DOMAIN_CONTEXT,
  calendarDaysBetween,
  sanitizeTags,
  seedGapDays,
  slotFor,
} from './state'

/** The `habit_items` / `habit_log` DDL lives in ../db/schema.ts (importing it
 *  from here would make schema → habit → client → schema a cycle). */

interface ItemRow {
  id: string
  label: string
  tags: string[]
  samples: number
  rating: number | null
  available: boolean
  seed_gap_days: number | null
  times_used: number
  last_at: string | null
}

/** Observations supersede the stated cadence once there are enough of them. */
const SEED_HANDOVER_USES = 3

/** Nearest stored items for a fresh photo embedding. */
export async function findMatches(
  domain: Domain,
  embedding: Float32Array,
  k = 5,
): Promise<MatchRow[]> {
  const db = await getDB()
  const res = await db.query<{ id: string; distance: number }>(
    `SELECT id, (embedding <=> $1::vector)::float8 AS distance
     FROM habit_items
     WHERE domain = $2 AND deleted_at IS NULL AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [toVectorLiteral(embedding), domain, k],
  )
  return res.rows.map((r) => ({ itemId: r.id, distance: r.distance }))
}

/**
 * Adds a favourite the user typed at setup, with no photo.
 *
 * This is the cold-start path: rather than waiting two weeks for a log to
 * build, the user lists what they already eat or wear and how often. The item
 * gets a NULL embedding — it simply isn't photo-matchable until the first
 * photo is confirmed against it, which `reinforceItem` handles.
 */
export async function seedItem(
  domain: Domain,
  label: string,
  tags: readonly string[],
  freq: SeedFrequency,
): Promise<string> {
  const db = await getDB()
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO habit_items (id, domain, label, tags, seed_gap_days, samples)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [id, domain, label, sanitizeTags(domain, tags), seedGapDays(freq)],
  )
  return id
}

/** First sighting of something new — the user supplies the Khmer name. */
export async function createItem(
  domain: Domain,
  label: string,
  tags: readonly string[],
  embedding: Float32Array,
): Promise<string> {
  const db = await getDB()
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO habit_items (id, domain, label, tags, embedding, samples)
     VALUES ($1, $2, $3, $4, $5::vector, 1)`,
    [id, domain, label, sanitizeTags(domain, tags), toVectorLiteral(embedding)],
  )
  return id
}

/**
 * Folds a confirmed photo into an item's visual signature. Called on every
 * confirmation, including corrections — a correction is the most valuable
 * signal there is, because it fixes the case the matcher got wrong.
 */
export async function reinforceItem(itemId: string, embedding: Float32Array): Promise<void> {
  const db = await getDB()
  const cur = await db.query<{ embedding: string | null; samples: number }>(
    `SELECT embedding::text AS embedding, samples FROM habit_items WHERE id = $1`,
    [itemId],
  )
  const row = cur.rows[0]
  if (!row) return
  const prev = row.embedding
    ? Float32Array.from(JSON.parse(row.embedding.replace(/^\[/, '[')) as number[])
    : new Float32Array(VISION_DIMS)
  const next = updateCentroid(prev, row.samples, embedding)
  await db.query(
    `UPDATE habit_items
     SET embedding = $2::vector, samples = samples + 1, updated_at = now()
     WHERE id = $1`,
    [itemId, toVectorLiteral(next)],
  )
}

/** Records that the user actually ate / wore this. */
export async function recordEntry(
  domain: Domain,
  itemId: string,
  at: Date = new Date(),
  thumb?: string,
): Promise<string> {
  const db = await getDB()
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO habit_log (id, item_id, domain, slot, at, confirmed, thumb)
     VALUES ($1, $2, $3, $4, $5, true, $6)`,
    [id, itemId, domain, slotFor(at.getHours()), at.toISOString(), thumb ?? null],
  )
  return id
}

/** Rename an item. The label is device-local only, so this touches nothing
 *  else — no cache key, no remote request, no log history. */
export async function renameItem(itemId: string, label: string): Promise<void> {
  const trimmed = label.trim()
  if (!trimmed) return
  const db = await getDB()
  await db.query(
    `UPDATE habit_items SET label = $2, updated_at = now() WHERE id = $1`,
    [itemId, trimmed],
  )
}

/** Thumbs up / down on an item, -1..1. */
export async function rateItem(itemId: string, rating: number): Promise<void> {
  const db = await getDB()
  await db.query(
    `UPDATE habit_items SET rating = $2, updated_at = now() WHERE id = $1`,
    [itemId, Math.max(-1, Math.min(1, rating))],
  )
}

/** Outfits go unavailable when worn (in the wash) and come back on laundry day. */
export async function setAvailable(itemId: string, available: boolean): Promise<void> {
  const db = await getDB()
  await db.query(
    `UPDATE habit_items SET available = $2, updated_at = now() WHERE id = $1`,
    [itemId, available],
  )
}

export interface ItemSummary {
  id: string
  label: string
  tags: Tag[]
  rating: number | null
  available: boolean
  seedGapDays: number | null
  timesUsed: number
}

/** Everything the user has added in a domain, for the manage screen. */
export async function listItems(domain: Domain): Promise<ItemSummary[]> {
  const db = await getDB()
  const res = await db.query<ItemRow>(
    `SELECT i.id, i.label, i.tags, i.samples, i.rating, i.available, i.seed_gap_days,
            count(l.id)::int AS times_used,
            max(l.at)::text  AS last_at
     FROM habit_items i
     LEFT JOIN habit_log l ON l.item_id = i.id AND l.deleted_at IS NULL
     WHERE i.domain = $1 AND i.deleted_at IS NULL
     GROUP BY i.id
     ORDER BY i.created_at`,
    [domain],
  )
  return res.rows.map((r) => ({
    id: r.id,
    label: r.label,
    tags: sanitizeTags(domain, r.tags ?? []),
    rating: r.rating,
    available: r.available,
    seedGapDays: r.seed_gap_days,
    timesUsed: r.times_used,
  }))
}

/** Soft delete, so a mistaken removal doesn't destroy the log behind it. */
export async function removeItem(itemId: string): Promise<void> {
  const db = await getDB()
  await db.query(`UPDATE habit_items SET deleted_at = now() WHERE id = $1`, [itemId])
}

/** How many entries have been logged in a domain — drives the setup prompt. */
export async function logCount(domain: Domain): Promise<number> {
  const db = await getDB()
  const res = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM habit_log WHERE domain = $1 AND deleted_at IS NULL`,
    [domain],
  )
  return res.rows[0]?.n ?? 0
}

/** Resolves opaque candidate keys back to Khmer labels, for rendering. */
export async function labelsFor(keys: readonly string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map()
  const db = await getDB()
  const res = await db.query<{ id: string; label: string }>(
    `SELECT id, label FROM habit_items WHERE id = ANY($1)`,
    [keys],
  )
  return new Map(res.rows.map((r) => [r.id, r.label]))
}

/**
 * Builds the identity-free state for a scorer.
 *
 * This is the privacy boundary in one function: labels and photos are read
 * from the DB but never copied into the result. Only ids, vocabulary tags and
 * bucketed counts come out.
 */
export async function buildState(
  domain: Domain,
  env: {
    tempC?: number
    rain?: RainBucket
    now?: Date
    weather?: WeatherBucket
    energy?: EnergyBucket
    /** Which meal is being planned — lets "what's for dinner?" be asked at
     *  3pm instead of letting the clock decide. Defaults to the clock. */
    slot?: Slot
    occasion?: OccasionBucket
  },
): Promise<DecisionState> {
  const db = await getDB()
  const now = env.now ?? new Date()

  const items = await db.query<ItemRow>(
    `SELECT i.id, i.label, i.tags, i.samples, i.rating, i.available, i.seed_gap_days,
            count(l.id)::int AS times_used,
            max(l.at)::text  AS last_at
     FROM habit_items i
     LEFT JOIN habit_log l ON l.item_id = i.id AND l.deleted_at IS NULL
     WHERE i.domain = $1 AND i.deleted_at IS NULL
     GROUP BY i.id
     -- Seeded items all have zero log entries, so without the cadence
     -- tie-break a user's daily staples could be truncated away arbitrarily
     -- by CANDIDATE_LIMIT before they have logged anything.
     ORDER BY count(l.id) DESC, i.seed_gap_days ASC NULLS LAST, i.created_at
     LIMIT $2`,
    [domain, CANDIDATE_LIMIT],
  )

  const total = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM habit_log WHERE domain = $1 AND deleted_at IS NULL`,
    [domain],
  )

  const recent = await db.query<{ tags: string[] }>(
    `SELECT i.tags
     FROM habit_log l JOIN habit_items i ON i.id = l.item_id
     WHERE l.domain = $1 AND l.deleted_at IS NULL
     ORDER BY l.at DESC
     LIMIT 6`,
    [domain],
  )

  const candidates: Candidate[] = items.rows.map((r) => ({
    key: r.id,
    tags: sanitizeTags(domain, r.tags ?? []),
    daysSinceUsed: r.last_at ? calendarDaysBetween(new Date(r.last_at), now) : null,
    timesUsed: r.times_used,
    // Hand over from what they said to what they did, once we've seen enough.
    expectedGapDays: r.times_used >= SEED_HANDOVER_USES ? null : r.seed_gap_days,
    rating: r.rating,
    available: r.available,
  }))

  const recentTags: Tag[] = []
  for (const row of recent.rows) for (const t of sanitizeTags(domain, row.tags ?? [])) recentTags.push(t)

  // Only the dimensions this domain reads, so a study session never carries a
  // weather bucket into its cache key and fragments it for nothing.
  const wanted = DOMAIN_CONTEXT[domain] ?? []
  const context: ContextMap = {}
  if (wanted.includes('weather')) {
    context.weather = env.weather ?? (env.tempC !== undefined ? bucketOf(env.tempC) : 'warm')
  }
  if (wanted.includes('rain')) context.rain = env.rain ?? 'dry'
  if (wanted.includes('energy')) context.energy = env.energy ?? 'normal'
  if (wanted.includes('occasion')) {
    // Default follows the calendar: weekdays dress for work, weekends casual.
    const rest = now.getDay() === 0 || now.getDay() === 6
    context.occasion = env.occasion ?? (rest ? 'casual' : 'work')
  }

  return {
    domain,
    slot: env.slot ?? slotFor(now.getHours()),
    dayType: now.getDay() === 0 || now.getDay() === 6 ? 'rest' : 'work',
    context,
    historyCount: total.rows[0]?.n ?? 0,
    recentTags,
    candidates,
  }
}

function bucketOf(tempC: number): WeatherBucket {
  return tempC > 32 ? 'hot' : tempC < 26 ? 'cool' : 'warm'
}
