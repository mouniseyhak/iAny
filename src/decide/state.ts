/**
 * Decide — the typed contract for everyday decisions ("what should I eat?",
 * "what should I wear?").
 *
 * The whole design rests on one rule: EVERYTHING THAT LEAVES THE DEVICE IS A
 * BUCKETED ENUM. Khmer labels, photos, GPS and ratings stay in PGlite. What
 * travels is an opaque candidate key plus a controlled tag vocabulary, so:
 *
 *   - no personal data leaves, only situation shape;
 *   - a remote scorer needs zero Khmer ability, because it never sees Khmer;
 *   - the state space is small and enumerable, so `stateKey()` is a high-hit
 *     cache key AND the lookup key of a precomputed offline decision pack.
 *
 * Scoring is deliberately NOT a generative task. A `Scorer` returns a number
 * with the reasons that produced it — the same "score you can argue with"
 * pattern as trace/core `complianceReport()`. The UI renders reason CODES into
 * Khmer locally, so the language never round-trips.
 */

/** Both domains run the same engine; only the tag vocabulary differs. */
export type Domain = 'meal' | 'outfit'

/** Coarse time of day. Meals and outfits both hang off it. */
export type Slot = 'morning' | 'midday' | 'evening'

/** Work days and rest days have different rhythms (and dress codes). */
export type DayType = 'work' | 'rest'

/** Bucketed so the cache key stays low-cardinality: <26 / 26-32 / >32 °C. */
export type WeatherBucket = 'cool' | 'warm' | 'hot'

export type RainBucket = 'dry' | 'showers' | 'rain'

/**
 * Controlled tag vocabulary. Closed on purpose — an open vocabulary would
 * leak free text off-device and blow up the cache key space.
 */
export const MEAL_TAGS = [
  'soup', 'grill', 'fried', 'rice', 'noodle', 'salad', 'sweet', 'spicy', 'light', 'heavy',
] as const

export const OUTFIT_TAGS = [
  'long-sleeve', 'short-sleeve', 'rain-proof', 'formal', 'casual', 'light', 'heavy',
] as const

export type MealTag = (typeof MEAL_TAGS)[number]
export type OutfitTag = (typeof OUTFIT_TAGS)[number]
export type Tag = MealTag | OutfitTag

const MEAL_TAG_SET: ReadonlySet<string> = new Set(MEAL_TAGS)
const OUTFIT_TAG_SET: ReadonlySet<string> = new Set(OUTFIT_TAGS)

/** Drops anything outside the vocabulary — the off-device leak guard. */
export function sanitizeTags(domain: Domain, tags: readonly string[]): Tag[] {
  const allowed = domain === 'meal' ? MEAL_TAG_SET : OUTFIT_TAG_SET
  const out: Tag[] = []
  for (const t of tags) if (allowed.has(t) && !out.includes(t as Tag)) out.push(t as Tag)
  return out.sort()
}

/**
 * One thing the user could eat / wear. `key` is an opaque local id — never the
 * Khmer name, which stays in `habit_items.label` on the device.
 */
export interface Candidate {
  key: string
  tags: Tag[]
  /** Days since last used; null = never used (cold start / new item). */
  daysSinceUsed: number | null
  /** How many times it appears in the log (the habit signal). */
  timesUsed: number
  /**
   * Typical days between uses, when the user told us directly at setup
   * ("I eat this most days"). Lets rotation work from minute one instead of
   * waiting two weeks for the log to reveal the same cadence. Null means
   * "derive it from the log", which is what real history does.
   */
  expectedGapDays?: number | null
  /** User feedback, -1..1; null = never rated. */
  rating: number | null
  /** Outfit: is it clean? Meal: is it obtainable right now? */
  available: boolean
}

/** The complete, identity-free situation handed to any scorer. */
export interface DecisionState {
  domain: Domain
  slot: Slot
  dayType: DayType
  weather: WeatherBucket
  rain: RainBucket
  /** Total log entries for this domain — drives local-scorer confidence. */
  historyCount: number
  /** Tags dominating the last few entries, for the variety penalty. */
  recentTags: Tag[]
  candidates: Candidate[]
}

/** Why a candidate scored what it did. The UI maps these to Khmer strings. */
export type ReasonCode =
  | 'overdue'        // not eaten/worn in a while
  | 'too-recent'     // had it yesterday
  | 'tag-fatigue'    // four fried days in a row
  | 'weather-fit'
  | 'weather-clash'
  | 'slot-fit'
  | 'slot-clash'
  | 'liked'
  | 'disliked'
  | 'favourite'      // high use count
  | 'untried'        // never used — a nudge toward variety
  | 'unavailable'    // in the wash / out of season

export interface Reason {
  code: ReasonCode
  /** Signed contribution to the score, already applied. */
  delta: number
}

export interface Scored {
  key: string
  /** 0..1. */
  score: number
  /** 0..1. Below `MIN_CONFIDENCE` the caller should fall back. */
  confidence: number
  reasons: Reason[]
}

/**
 * One interface, three implementations: local arithmetic (always available),
 * a precomputed pack lookup, and a live remote call. The UI never knows which
 * answered.
 */
export interface Scorer {
  rank(state: DecisionState): Promise<Scored[]>
}

/** Below this, prefer a fallback scorer over showing a shaky answer. */
export const MIN_CONFIDENCE = 0.6

/**
 * Token budget for a remote call. The remote model tolerates far more choices,
 * but a short list keeps the offline and online paths scoring the SAME
 * candidates, so switching between them can't reshuffle the answer.
 */
export const CANDIDATE_LIMIT = 16

/** °C → bucket. */
export function weatherBucket(tempC: number): WeatherBucket {
  return tempC > 32 ? 'hot' : tempC < 26 ? 'cool' : 'warm'
}

/** Local hour → slot. */
export function slotFor(hour: number): Slot {
  return hour < 10 ? 'morning' : hour < 16 ? 'midday' : 'evening'
}

/**
 * Buckets "days since used" so the cache key doesn't get a fresh value every
 * single day. Same bucket = same decision, which is what makes caching work.
 */
export function agoBucket(days: number | null): string {
  if (days === null) return 'never'
  if (days <= 0) return '0'
  if (days === 1) return '1'
  if (days === 2) return '2'
  if (days < 7) return '3-6'
  if (days < 14) return '7-13'
  return '14+'
}

/**
 * How often the user says they eat / wear something, asked once at setup.
 *
 * This is the cold-start fix: a favourites list alone gives the engine items
 * but no rhythm, so rotation and variety stay dark until the log fills up.
 * One extra tap per item ("most days / most weeks / now and then / rarely")
 * supplies that rhythm immediately — no fabricated history required.
 */
export type SeedFrequency = 'daily' | 'weekly' | 'sometimes' | 'rare'

const SEED_GAP_DAYS: Record<SeedFrequency, number> = {
  daily: 2,
  weekly: 7,
  sometimes: 14,
  rare: 30,
}

export function seedGapDays(freq: SeedFrequency): number {
  return SEED_GAP_DAYS[freq]
}

/**
 * Builds a candidate from what the user typed at setup.
 *
 * `timesUsed` stays 0 and `historyCount` is untouched on purpose: these are
 * stated preferences, not observations, and inflating the log would make
 * `localConfidence()` lie about how well-grounded the answer is.
 *
 * `daysSinceUsed` stays null because nothing has been observed yet — at setup
 * no item is more overdue than any other, so there is nothing to differentiate.
 * The stated gap earns its keep from the FIRST real log entry onward, when it
 * says whether that gap was long or short for THIS item.
 */
export function seedCandidate(
  key: string,
  domain: Domain,
  tags: readonly string[],
  freq: SeedFrequency,
  rating: number | null = null,
): Candidate {
  return {
    key,
    tags: sanitizeTags(domain, tags),
    daysSinceUsed: null,
    timesUsed: 0,
    expectedGapDays: SEED_GAP_DAYS[freq],
    rating,
    available: true,
  }
}

/**
 * Whole calendar days between two instants, in LOCAL time.
 *
 * Calendar days, not 24-hour spans: breakfast at 07:00 today and dinner at
 * 20:00 yesterday are "1 day apart" to a human even though only 11 hours
 * passed, and the recency rule has to agree with the user or it feels broken.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/**
 * Deterministic, canonical key for a situation. Doubles as the KV cache key
 * online and the decision-pack lookup key offline — one mechanism, both jobs.
 * Candidates are sorted so member order can never produce two keys for one
 * situation.
 */
export function stateKey(state: DecisionState): string {
  const cands = state.candidates
    .map((c) => `${c.key}:${c.tags.join('+')}:${agoBucket(c.daysSinceUsed)}:${c.available ? 1 : 0}`)
    .sort()
    .join(',')
  const recent = [...state.recentTags].sort().join('+')
  const depth = state.historyCount < 10 ? 'new' : state.historyCount < 60 ? 'some' : 'deep'
  return [
    'v1', state.domain, state.slot, state.dayType,
    state.weather, state.rain, depth, recent, cands,
  ].join('|')
}
