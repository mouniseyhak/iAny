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

/** Tag affinities per weather bucket. Empty entries are neutral. */
const WEATHER_AFFINITY: Record<string, Partial<Record<Tag, number>>> = {
  hot: {
    soup: -0.14, fried: -0.10, heavy: -0.16, grill: -0.05,
    light: +0.15, salad: +0.12, 'short-sleeve': +0.12, 'long-sleeve': -0.10,
  },
  warm: {},
  cool: {
    soup: +0.15, heavy: +0.10, fried: +0.04,
    light: -0.06, salad: -0.05, 'long-sleeve': +0.12, 'short-sleeve': -0.08,
  },
}

const RAIN_AFFINITY: Record<string, Partial<Record<Tag, number>>> = {
  dry: { 'rain-proof': -0.06 },
  showers: { 'rain-proof': +0.10, soup: +0.04 },
  rain: { 'rain-proof': +0.22, soup: +0.10, light: -0.06, grill: -0.08 },
}

const SLOT_AFFINITY: Record<string, Partial<Record<Tag, number>>> = {
  morning: { noodle: +0.12, soup: +0.10, rice: +0.05, heavy: -0.16, sweet: +0.04 },
  midday: { rice: +0.10, heavy: +0.05, salad: +0.04 },
  evening: { grill: +0.08, heavy: -0.04, sweet: +0.05 },
}

const DAY_AFFINITY: Record<string, Partial<Record<Tag, number>>> = {
  work: { formal: +0.15, casual: -0.08 },
  rest: { formal: -0.20, casual: +0.12 },
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

  const weather = affinity(WEATHER_AFFINITY[state.weather] ?? {}, c.tags)
    + affinity(RAIN_AFFINITY[state.rain] ?? {}, c.tags)
  score += push(reasons, weather >= 0 ? 'weather-fit' : 'weather-clash', weather)

  const slot = affinity(SLOT_AFFINITY[state.slot] ?? {}, c.tags)
    + affinity(DAY_AFFINITY[state.dayType] ?? {}, c.tags)
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

/** The always-available implementation of `Scorer`. */
export class LocalScorer implements Scorer {
  async rank(state: DecisionState): Promise<Scored[]> {
    return rankLocal(state)
  }
}
