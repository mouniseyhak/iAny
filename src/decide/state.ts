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

/** All domains run the same engine; only vocabulary and weights differ. */
export type Domain = 'meal' | 'outfit' | 'exercise' | 'study'

export const DOMAINS: readonly Domain[] = ['meal', 'outfit', 'exercise', 'study']

/** Coarse time of day. Meals and outfits both hang off it. */
export type Slot = 'morning' | 'midday' | 'evening'

/** Work days and rest days have different rhythms (and dress codes). */
export type DayType = 'work' | 'rest'

/** Bucketed so the cache key stays low-cardinality: <26 / 26-32 / >32 °C. */
export type WeatherBucket = 'cool' | 'warm' | 'hot'

export type RainBucket = 'dry' | 'showers' | 'rain'

/** How much is left in the tank. Drives exercise and study, ignored by meals. */
export type EnergyBucket = 'low' | 'normal' | 'high'

/**
 * Situational dimensions, as an open map rather than fixed fields.
 *
 * Weather and rain were hardcoded when meals and outfits were the only
 * domains. Exercise needs "how tired am I" and study ignores the weather
 * entirely, so a fourth literal field would have been the wrong shape: every
 * domain would carry dimensions it has no use for. A map lets each domain
 * supply only what its weights actually read, and `stateKey` stays
 * deterministic because the entries are sorted.
 */
export type ContextDim = 'weather' | 'rain' | 'energy'
export type ContextMap = Partial<Record<ContextDim, string>>

/** Which dimensions a domain actually asks about. */
export const DOMAIN_CONTEXT: Record<Domain, ContextDim[]> = {
  meal: ['weather', 'rain'],
  outfit: ['weather', 'rain'],
  exercise: ['weather', 'rain', 'energy'],
  // Study is indoors and indifferent to the sky; only the tank matters.
  study: ['energy'],
}

/**
 * Controlled tag vocabulary. Closed on purpose — an open vocabulary would
 * leak free text off-device and blow up the cache key space.
 */
export const EXERCISE_TAGS = [
  // Kind
  'walk', 'run', 'cycle', 'swim', 'strength', 'stretch', 'sport',
  // What it works — recovery is per body area, so this is the rotation axis
  'legs', 'arms', 'core', 'full-body',
  // Effort and shape
  'gentle', 'intense', 'short', 'long',
  // Where
  'indoor', 'outdoor',
] as const

export const STUDY_TAGS = [
  // Skill
  'reading', 'writing', 'listening', 'speaking', 'vocabulary', 'grammar', 'math', 'practice',
  // Shape of the session
  'new', 'review', 'short', 'long', 'easy', 'hard',
] as const

export const MEAL_TAGS = [
  // Kind of dish
  'soup', 'porridge', 'rice', 'noodle', 'grill', 'fried', 'steamed', 'curry', 'salad',
  // What's in it — the axis people actually notice repeating
  'fish', 'meat', 'egg', 'veg',
  // Character
  'spicy', 'sour', 'sweet', 'fruit', 'light', 'heavy',
  // Where it comes from (rain makes a stall a worse idea)
  'street',
] as const

export const OUTFIT_TAGS = [
  'long-sleeve', 'short-sleeve', 'shorts',
  'formal', 'casual', 'traditional',
  'rain-proof', 'sun-protective', 'light', 'heavy',
] as const

export type MealTag = (typeof MEAL_TAGS)[number]
export type OutfitTag = (typeof OUTFIT_TAGS)[number]
export type ExerciseTag = (typeof EXERCISE_TAGS)[number]
export type StudyTag = (typeof STUDY_TAGS)[number]
export type Tag = MealTag | OutfitTag | ExerciseTag | StudyTag

export const DOMAIN_TAGS: Record<Domain, readonly Tag[]> = {
  meal: MEAL_TAGS,
  outfit: OUTFIT_TAGS,
  exercise: EXERCISE_TAGS,
  study: STUDY_TAGS,
}

const TAG_SETS: Record<Domain, ReadonlySet<string>> = {
  meal: new Set(MEAL_TAGS),
  outfit: new Set(OUTFIT_TAGS),
  exercise: new Set(EXERCISE_TAGS),
  study: new Set(STUDY_TAGS),
}

/** Drops anything outside the vocabulary — the off-device leak guard. */
export function sanitizeTags(domain: Domain, tags: readonly string[]): Tag[] {
  const allowed = TAG_SETS[domain] ?? TAG_SETS.meal
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
  /** Only the dimensions this domain reads — see `DOMAIN_CONTEXT`. */
  context: ContextMap
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
  | 'energy-fit'     // gentle when you're spent
  | 'energy-clash'   // too hard for what's left in the tank
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
/**
 * What a candidate looks like to a scorer, with its identity removed.
 *
 * The decision depends only on tags, how long ago it was chosen and whether
 * it's available — never on WHICH item it is. Keeping identity out of this
 * string is what makes two different people's situations compare equal.
 */
export function candidateSignature(c: Candidate): string {
  return `${c.tags.join('+')}:${agoBucket(c.daysSinceUsed)}:${c.available ? 1 : 0}`
}

/**
 * Canonical ordering for aliasing. Sorted by signature so that two devices
 * holding structurally identical situations produce the same order, and a
 * cached answer from one applies correctly to the other. The `key` tie-break
 * only ever separates candidates whose signatures are already identical, so
 * the model's answer for them is interchangeable by construction.
 *
 * Unavailable candidates are excluded: they are never sent, so letting them
 * consume an alias slot would leave gaps (`opt_2` with no `opt_1`) and make two
 * devices asking the identical question disagree on numbering.
 */
export function aliasOrder(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((c) => c.available).sort((a, b) => {
    const sa = candidateSignature(a)
    const sb = candidateSignature(b)
    if (sa !== sb) return sa < sb ? -1 : 1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/**
 * Per-request aliases (`opt_1`, `opt_2`, …) used in place of item ids.
 *
 * Two reasons, both load-bearing:
 *  - A device-local UUID is a STABLE identifier. Sending it would let a server
 *    correlate requests over time and learn "this device's item 20baea65 wins
 *    on hot days" — a profile, rebuilt from data we promised not to send.
 *  - It keeps the keys to a plain identifier shape, which is what the docs'
 *    examples use.
 */
export function aliasMap(candidates: readonly Candidate[]): {
  toAlias: Map<string, string>
  toKey: Map<string, string>
} {
  const toAlias = new Map<string, string>()
  const toKey = new Map<string, string>()
  aliasOrder(candidates).forEach((c, i) => {
    const alias = `opt_${i + 1}`
    toAlias.set(c.key, alias)
    toKey.set(alias, c.key)
  })
  return { toAlias, toKey }
}

export function stateKey(state: DecisionState): string {
  // Signatures of the AVAILABLE candidates only. Two reasons: including a
  // device-local UUID meant no two devices ever produced the same key for the
  // same situation, and an unavailable item is not part of the question asked,
  // so letting it change the key would fragment the cache for no benefit.
  const cands = state.candidates
    .filter((c) => c.available)
    .map(candidateSignature)
    .sort()
    .join(',')
  const recent = [...state.recentTags].sort().join('+')
  const depth = state.historyCount < 10 ? 'new' : state.historyCount < 60 ? 'some' : 'deep'
  // Context entries sorted so the key can't vary with insertion order.
  const ctx = Object.entries(state.context)
    .filter(([, v]) => v)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(';')
  return ['v2', state.domain, state.slot, state.dayType, ctx, depth, recent, cands].join('|')
}
