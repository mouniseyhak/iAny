/**
 * The local scorer — plain arithmetic over typed state, no model, no network.
 *
 * This is the baseline that must always work: on a moto with no signal, on a
 * cheap Android, on day one. A remote scorer can only ever be an improvement
 * layered on top, never a dependency.
 *
 * Deliberately NOT machine learning. With ~90 logged meals a neural net
 * overfits and explains nothing; a frequency-and-rotation model is right on
 * day ten, runs in under a millisecond, and every number it produces can be
 * shown to the user and argued with.
 */
import {
  type Candidate,
  type DecisionState,
  type Reason,
  type Scored,
  type Scorer,
  type Tag,
} from './state'

/** Neutral starting point; reasons push up or down from here. */
const BASE = 0.5

/**
 * All situational weights in one table, keyed `dimension:value`.
 *
 * These were four separate maps (weather / rain / slot / day) back when the
 * dimensions were fixed. Collapsing them means adding a dimension costs a few
 * rows here and nothing anywhere else — which is what made exercise's "energy"
 * cheap to add.
 *
 * Empty or missing entries are neutral, and a domain simply never supplies the
 * dimensions it doesn't care about: study reads energy and ignores the sky.
 *
 * Every number is a judgement call, not a measurement. The ones encoding local
 * knowledge are commented, because they are the ones a generic table gets
 * backwards.
 */
const AFFINITY: Record<string, Partial<Record<Tag, number>>> = {
  'weather:hot': {
    soup: -0.14, curry: -0.10, fried: -0.10, heavy: -0.16, grill: -0.05, meat: -0.05,
    light: +0.15, fruit: +0.14, salad: +0.12, sour: +0.12, steamed: +0.08, veg: +0.08,
    fish: +0.03, porridge: -0.02,
    // Cambodian riders cover up IN the heat: sun cover partly cancels the
    // long-sleeve penalty rather than compounding it.
    'short-sleeve': +0.12, shorts: +0.12, 'sun-protective': +0.10, 'long-sleeve': -0.10,
    // Midday heat is the real reason not to train outside here.
    swim: +0.20, indoor: +0.15, gentle: +0.08, stretch: +0.06,
    outdoor: -0.15, run: -0.12, intense: -0.12, cycle: -0.06,
  },
  'weather:warm': {},
  'weather:cool': {
    soup: +0.15, curry: +0.12, heavy: +0.10, porridge: +0.10, fried: +0.04,
    light: -0.06, salad: -0.05, fruit: -0.04, sour: -0.03, veg: -0.03,
    'long-sleeve': +0.12, 'short-sleeve': -0.08, shorts: -0.10,
    outdoor: +0.12, run: +0.10, cycle: +0.08, intense: +0.05, indoor: -0.05, swim: -0.15,
  },

  'rain:dry': { 'rain-proof': -0.06, 'sun-protective': +0.04, street: +0.04 },
  'rain:showers': { 'rain-proof': +0.10, soup: +0.04, street: -0.08, outdoor: -0.10, indoor: +0.08 },
  // A stall is a bad idea in real rain, whatever it is selling.
  'rain:rain': {
    'rain-proof': +0.22, soup: +0.10, porridge: +0.08, curry: +0.06,
    light: -0.06, grill: -0.08, street: -0.18, 'sun-protective': -0.04,
    indoor: +0.20, stretch: +0.10, strength: +0.08, outdoor: -0.25, run: -0.15, cycle: -0.15,
  },

  // Energy: exercise and study only. Nothing here touches food or clothes.
  'energy:low': {
    gentle: +0.20, stretch: +0.15, walk: +0.12,
    intense: -0.25, long: -0.15, strength: -0.08,
    easy: +0.20, review: +0.15, vocabulary: +0.10, listening: +0.08,
    hard: -0.25, new: -0.15,
  },
  'energy:normal': {},
  'energy:high': {
    intense: +0.15, strength: +0.10, sport: +0.10, long: +0.08, gentle: -0.08,
    hard: +0.15, new: +0.12, writing: +0.08, speaking: +0.08,
  },

  // Borbor is the breakfast, so porridge outranks even noodles in the morning.
  'slot:morning': {
    porridge: +0.18, noodle: +0.12, soup: +0.10, egg: +0.10, fruit: +0.06, rice: +0.05,
    sweet: +0.04, curry: -0.08, grill: -0.10, heavy: -0.16,
    run: +0.10, stretch: +0.10, walk: +0.08, gentle: +0.05, intense: -0.05,
    // A fresh mind takes new and hard material; tired evenings take review.
    new: +0.12, hard: +0.10, math: +0.08,
  },
  'slot:midday': {
    rice: +0.10, heavy: +0.05, curry: +0.05, salad: +0.04, fish: +0.03, meat: +0.03,
    indoor: +0.08, outdoor: -0.10,
    practice: +0.05,
  },
  'slot:evening': {
    grill: +0.08, fruit: +0.06, sweet: +0.05, street: +0.05, porridge: +0.04, heavy: -0.04,
    sport: +0.10, walk: +0.08, cycle: +0.06, intense: -0.04,
    review: +0.12, easy: +0.08, vocabulary: +0.08, hard: -0.10, new: -0.08,
  },

  // Outfit style lives on the OCCASION, not the day type — otherwise a
  // work-day wedding would double-count and the pagoda would lose to the
  // office. Day type keeps only what is genuinely about the day's rhythm.
  'day:work': {
    street: +0.06,
    short: +0.14, long: -0.16, intense: -0.05,
  },
  'day:rest': {
    street: -0.04,
    long: +0.12, sport: +0.10, short: -0.05, new: +0.06,
  },

  'occasion:work': { formal: +0.15, casual: -0.08, shorts: -0.12, traditional: -0.10 },
  'occasion:casual': { casual: +0.12, shorts: +0.08, formal: -0.15, traditional: -0.05 },
  // Pagoda and ceremony: covered and respectful. Shorts are simply wrong.
  'occasion:ceremony': {
    traditional: +0.25, formal: +0.10, 'long-sleeve': +0.05,
    casual: -0.10, shorts: -0.30,
  },
  'occasion:wedding': {
    traditional: +0.30, formal: +0.20,
    casual: -0.20, shorts: -0.35, 'rain-proof': -0.05,
  },
}

function affinity(table: Partial<Record<Tag, number>>, tags: readonly Tag[]): number {
  let sum = 0
  for (const t of tags) sum += table[t] ?? 0
  return sum
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Rotation: how overdue is this candidate relative to its OWN usual gap?
 * Someone who eats rice daily and fish weekly should not have both judged
 * against one global interval, so the expected gap is derived per candidate.
 */
function rotationDelta(c: Candidate, historyCount: number): number {
  if (c.daysSinceUsed === null) return 0
  // A cadence the user stated at setup wins over one inferred from the log:
  // it is available immediately, and it is what they believe their own rhythm
  // to be. Observations take over once `expectedGapDays` is cleared.
  const stated = c.expectedGapDays ?? null
  if (stated === null && c.timesUsed < 1) return 0
  // Expected gap = how often this shows up in the log, floored so a brand-new
  // item with one use isn't treated as "due" forever.
  const expected = stated ?? Math.max(2, historyCount > 0 ? historyCount / c.timesUsed : 7)
  const ratio = c.daysSinceUsed / Math.max(1, expected)
  if (ratio >= 1) return Math.min(0.22, 0.10 * ratio)
  return 0
}

/** Had it yesterday? Strong push down. This is the single most useful rule. */
function recencyDelta(c: Candidate): number {
  if (c.daysSinceUsed === null) return 0
  if (c.daysSinceUsed <= 0) return -0.45
  if (c.daysSinceUsed === 1) return -0.28
  if (c.daysSinceUsed === 2) return -0.10
  return 0
}

/**
 * Variety: if a tag dominated recent entries, damp everything carrying it.
 * This is what turns "you ate fried four days running" into a suggestion
 * change rather than a health lecture.
 */
function fatigueDelta(c: Candidate, recentTags: readonly Tag[]): number {
  if (recentTags.length === 0) return 0
  let hits = 0
  for (const t of recentTags) if (c.tags.includes(t)) hits++
  if (hits === 0) return 0
  const share = hits / recentTags.length
  return share >= 0.5 ? -Math.min(0.2, 0.2 * share) : 0
}

function ratingDelta(c: Candidate): number {
  if (c.rating === null) return 0
  return Math.max(-0.25, Math.min(0.25, c.rating * 0.25))
}

/** Gentle nudge toward things never tried, so the rotation can grow. */
function noveltyDelta(c: Candidate): number {
  return c.daysSinceUsed === null && c.timesUsed === 0 ? 0.06 : 0
}

function push(reasons: Reason[], code: Reason['code'], delta: number): number {
  if (Math.abs(delta) < 0.005) return 0
  reasons.push({ code, delta: round3(delta) })
  return delta
}

/** Scores one candidate and records every contribution that moved it. */
export function scoreCandidate(state: DecisionState, c: Candidate): Scored {
  const reasons: Reason[] = []

  if (!c.available) {
    return {
      key: c.key,
      score: 0,
      confidence: 1,
      reasons: [{ code: 'unavailable', delta: -BASE }],
    }
  }

  let score = BASE
  score += push(reasons, 'overdue', rotationDelta(c, state.historyCount))
  score += push(reasons, 'too-recent', recencyDelta(c))
  score += push(reasons, 'tag-fatigue', fatigueDelta(c, state.recentTags))

  // Environment (weather + rain) and energy get their own reason buckets:
  // "suits the weather" would read as nonsense when the driver was tiredness.
  const env =
    affinity(AFFINITY[`weather:${state.context.weather}`] ?? {}, c.tags) +
    affinity(AFFINITY[`rain:${state.context.rain}`] ?? {}, c.tags)
  score += push(reasons, env >= 0 ? 'weather-fit' : 'weather-clash', env)

  const energy = affinity(AFFINITY[`energy:${state.context.energy}`] ?? {}, c.tags)
  score += push(reasons, energy >= 0 ? 'energy-fit' : 'energy-clash', energy)

  const occasion = affinity(AFFINITY[`occasion:${state.context.occasion}`] ?? {}, c.tags)
  score += push(reasons, occasion >= 0 ? 'occasion-fit' : 'occasion-clash', occasion)

  const slot =
    affinity(AFFINITY[`slot:${state.slot}`] ?? {}, c.tags) +
    affinity(AFFINITY[`day:${state.dayType}`] ?? {}, c.tags)
  score += push(reasons, slot >= 0 ? 'slot-fit' : 'slot-clash', slot)

  const rating = ratingDelta(c)
  score += push(reasons, rating >= 0 ? 'liked' : 'disliked', rating)
  score += push(reasons, 'untried', noveltyDelta(c))

  // A long-standing favourite earns a small, capped edge — enough to break
  // ties, never enough to beat "you had it yesterday".
  if (state.historyCount > 0 && c.timesUsed / state.historyCount > 0.2) {
    score += push(reasons, 'favourite', 0.05)
  }

  return {
    key: c.key,
    score: round3(clamp01(score)),
    confidence: localConfidence(state),
    reasons: reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
  }
}

/**
 * Confidence tracks how well-grounded the answer is, from two independent
 * sources — and takes the better of them.
 *
 *  - History: observations of what the person actually chose. Reaches the 0.9
 *    ceiling at ~60 entries.
 *  - Grounding: a tagged candidate list, whether typed at setup or learned.
 *    Weather and slot fit are REAL signals that work with zero history, so a
 *    seeded list is not a shot in the dark and shouldn't report as one.
 *
 * Grounding deliberately tops out at 0.55, below `MIN_CONFIDENCE`. Stated
 * preferences are weaker evidence than observed behaviour, and staying under
 * the floor is what makes the system reach for a better scorer when online —
 * precisely when it has least of its own history to go on.
 */
export function localConfidence(state: DecisionState): number {
  const history = 0.2 + (Math.max(0, state.historyCount) / 60) * 0.7

  const n = state.candidates.length
  const tagged = n > 0 ? state.candidates.filter((c) => c.tags.length > 0).length / n : 0
  // A two-item list can't support much confidence however well tagged it is.
  const breadth = Math.min(1, n / 5)
  const grounding = 0.2 + tagged * breadth * 0.35

  return round3(Math.max(0.2, Math.min(0.9, Math.max(history, grounding))))
}

/** Highest score first; stable by key so equal scores never shuffle. */
export function rankLocal(state: DecisionState): Scored[] {
  return state.candidates
    .map((c) => scoreCandidate(state, c))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * True when the top two are close enough that the ordering is basically a
 * coin toss. Together with a low confidence score this is what justifies
 * spending a remote call: ask the expensive scorer only when the cheap one is
 * genuinely unsure, not on every tap.
 */
export function isAmbiguous(ranked: readonly Scored[], margin = 0.08): boolean {
  const [first, second] = ranked
  if (!first || !second) return false
  return first.score - second.score < margin
}

/** The always-available implementation of `Scorer`. */
export class LocalScorer implements Scorer {
  async rank(state: DecisionState): Promise<Scored[]> {
    return rankLocal(state)
  }
}
