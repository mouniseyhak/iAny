/**
 * The remote scoring seam (Workers AI `typesafe/jev`).
 *
 * Nothing here is required for the app to work — it is the "you happen to be
 * online" refinement on top of `LocalScorer`. Three properties are deliberate:
 *
 *  1. `describeState()` renders the typed enums into a short English sentence.
 *     The model therefore never sees Khmer, never sees a photo, and never sees
 *     a name — so its multilingual ability and its lack of image support both
 *     stop mattering. Khmer enters and leaves purely on-device.
 *  2. The model evaluates ONE state against MANY questions in parallel, so the
 *     ranking and its explanation cost a single round trip.
 *  3. An uninformative remote answer is discarded and the local one used, so
 *     "confidently wrong" is a handled branch rather than a silent failure.
 *     Informative means lift over uniform, NOT a flat confidence threshold —
 *     see `remoteIsInformative()` for why that distinction matters.
 *
 * The call itself runs in the Worker (`env.AI.run`), never the browser: the
 * account binding stays server-side and the response is cached under
 * `stateKey()`. That cache is also, by construction, a precomputed offline
 * decision pack — same keys, same values.
 */
import {
  type Candidate,
  type DecisionState,
  type Reason,
  type Scored,
  type Scorer,
  MIN_CONFIDENCE,
  agoBucket,
  aliasMap,
  stateKey,
} from './state'
import { isAmbiguous, rankLocal } from './suggest'

/** Mirrors the `typesafe/jev` request schema. */
export interface JevChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}
export interface JevScoreQuestion {
  type: 'score'
  instructions: string
  criteria: string[]
}
export interface JevNoulQuestion {
  type: 'noul'
  instructions: string
  criteria: { true: string; false: string }
}
export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion

export interface JevRequest {
  state: string
  questions: Record<string, JevQuestion>
}

/** Mirrors the `typesafe/jev` response schema. */
export interface JevResponse {
  model?: string
  answers: Record<string, {
    type: string
    noul?: number
    choice?: string
    score?: number
    confidence?: number
    probabilities?: Record<string, number>
  }>
}

/**
 * Finds the model's answer inside whatever envelope it arrived in.
 *
 * Workers AI hands some models' output back directly and wraps others (the
 * REST shape is `{ result, success, errors }`). Asserting one exact shape made
 * a working model look like a failure, so instead we walk a few known wrapper
 * keys looking for `answers`. Returns null if it genuinely isn't there.
 */
export function normalizeJevResponse(raw: unknown): JevResponse | null {
  let node: unknown = raw
  for (let depth = 0; depth < 4; depth++) {
    if (!node || typeof node !== 'object') return null
    const obj = node as Record<string, unknown>
    const answers = obj['answers']
    if (answers && typeof answers === 'object') return node as JevResponse
    const next = obj['result'] ?? obj['response'] ?? obj['output'] ?? obj['data']
    if (!next || next === node) return null
    node = next
  }
  return null
}

/**
 * The shape of an unexpected payload, for an error a human can act on.
 * Keys only — never values, which could carry content we shouldn't log.
 */
export function describeShape(raw: unknown): string {
  if (raw === null) return 'null'
  if (raw === undefined) return 'undefined'
  if (Array.isArray(raw)) return `array(${raw.length})`
  if (typeof raw !== 'object') return typeof raw
  const keys = Object.keys(raw as object)
  return `object{${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…' : ''}}`
}

/** Context values rendered for the model, one phrase per dimension value. */
const CONTEXT_TEXT: Record<string, string> = {
  'weather:hot': 'the weather is hot, above 32C',
  'weather:warm': 'the weather is warm, 26-32C',
  'weather:cool': 'the weather is cool, below 26C',
  'rain:dry': 'it is dry',
  'rain:showers': 'there are showers',
  'rain:rain': 'it is raining',
  'energy:low': 'they are tired and low on energy',
  'energy:normal': 'their energy is normal',
  'energy:high': 'they feel energetic',
  'occasion:work': 'they are dressing for work',
  'occasion:casual': 'it is an ordinary casual day',
  'occasion:ceremony': 'they are attending a ceremony at the pagoda',
  'occasion:wedding': 'they are attending a wedding',
}

const VERBS: Record<string, string> = {
  meal: 'eat',
  outfit: 'wear',
  exercise: 'do for exercise',
  study: 'study',
}

const AGO_TEXT: Record<string, string> = {
  never: 'never chosen before',
  '0': 'chosen earlier today',
  '1': 'chosen yesterday',
  '2': 'chosen 2 days ago',
  '3-6': 'chosen 3-6 days ago',
  '7-13': 'chosen 1-2 weeks ago',
  '14+': 'not chosen for over 2 weeks',
}

/** One candidate rendered for the model — tags and buckets only, no label. */
function describeCandidate(c: Candidate): string {
  const parts = [c.tags.length ? c.tags.join(', ') : 'no tags']
  parts.push(AGO_TEXT[agoBucket(c.daysSinceUsed)] ?? 'unknown')
  if (c.rating !== null) parts.push(c.rating > 0 ? 'the person likes it' : 'the person dislikes it')
  return parts.join('; ')
}

/**
 * The situation, as a compact sentence. Built only from enums — there is no
 * code path here that can emit user-authored text.
 */
/** For meals the slot IS the meal, and the model should hear it that way. */
const MEAL_SLOT_TEXT: Record<string, string> = {
  morning: 'breakfast',
  midday: 'lunch',
  evening: 'dinner',
}

export function describeState(state: DecisionState): string {
  const what = VERBS[state.domain] ?? 'choose'
  const depth = state.historyCount < 10
    ? 'Their history is short, so habit signals are weak.'
    : `They have ${state.historyCount} past entries.`
  const recent = state.recentTags.length
    ? ` Recent choices were mostly: ${[...new Set(state.recentTags)].join(', ')}.`
    : ''
  // Only the dimensions this domain supplied — study never mentions weather.
  const ctx = Object.entries(state.context)
    .filter(([, v]) => v)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => CONTEXT_TEXT[`${k}:${v}`] ?? `${k} is ${v}`)
    .join(', ')
  const situation = ctx ? ` Right now ${ctx}.` : ''
  const when = state.domain === 'meal' ? (MEAL_SLOT_TEXT[state.slot] ?? state.slot) : state.slot
  return (
    `A person in Cambodia is deciding what to ${what} for the ${when} ` +
    `of a ${state.dayType} day.${situation} ${depth}${recent} ` +
    `Prefer variety over repetition, and a choice that suits the situation.`
  )
}

/**
 * One call: the ranking plus the two judgements that explain it.
 *
 * Candidates are sent as `opt_1`…`opt_n`, never as item ids — see
 * `aliasMap()`. Nothing leaves that could be correlated across requests.
 */
export function buildQuestions(state: DecisionState): Record<string, JevQuestion> {
  const criteria: Record<string, string> = {}
  const { toAlias } = aliasMap(state.candidates)
  for (const c of state.candidates) {
    const alias = toAlias.get(c.key)
    if (c.available && alias) criteria[alias] = describeCandidate(c)
  }
  const verb = VERBS[state.domain] ?? 'choose'
  return {
    pick: {
      type: 'choice',
      instructions: `Which option should the person ${verb} right now?`,
      criteria,
    },
    // "How heavy, given the weather" is nonsense for a study session. The
    // question is really about effort, which every domain has.
    effort: {
      type: 'score',
      instructions: 'How demanding should the choice be, given the situation and time of day?',
      criteria: ['Easy', 'Moderate', 'Demanding'],
    },
    needs_variety: {
      type: 'noul',
      instructions: 'Does this person need a change from their recent pattern?',
      criteria: {
        true: 'Recent choices are repetitive',
        false: 'Recent choices are already varied',
      },
    },
  }
}

export function buildRequest(state: DecisionState): JevRequest {
  return { state: describeState(state), questions: buildQuestions(state) }
}

/**
 * Turns the choice distribution into a ranking.
 *
 * The probability map IS the ranking — every candidate gets a number, not just
 * the winner, which is what lets the UI show a bar per option instead of a
 * bare verdict. Candidates the model omitted keep a score of 0.
 */
export function readRanking(state: DecisionState, resp: JevResponse): Scored[] {
  const pick = resp.answers?.['pick']
  const rawProbs = pick?.probabilities ?? {}
  const confidence = pick?.confidence ?? 0

  // Aliases back to local ids. Rebuilt from the same canonical ordering the
  // request used, so a cached answer from another device maps correctly here.
  const { toKey } = aliasMap(state.candidates)
  const probs: Record<string, number> = {}
  for (const [alias, p] of Object.entries(rawProbs)) {
    const key = toKey.get(alias)
    if (key) probs[key] = p
  }

  // A response can carry a confident `choice` with no usable probability map
  // (absent, or keys that don't survive the alias mapping). Scoring that as
  // all-zeros would misreport a confident answer as "unclear", so the choice
  // itself becomes the distribution: its confidence as the top mass.
  if (Object.keys(probs).length === 0 && pick?.choice) {
    const chosen = toKey.get(pick.choice)
    if (chosen) probs[chosen] = confidence > 0 ? confidence : 0.5
  }

  const aux: Reason[] = []
  const variety = resp.answers?.['needs_variety']?.noul
  if (typeof variety === 'number' && variety > 0.6) {
    aux.push({ code: 'tag-fatigue', delta: -Math.round(variety * 200) / 1000 })
  }

  return state.candidates
    .map((c) => ({
      key: c.key,
      score: c.available ? Math.round((probs[c.key] ?? 0) * 1000) / 1000 : 0,
      confidence: c.available ? confidence : 1,
      reasons: c.available ? aux : [{ code: 'unavailable' as const, delta: -0.5 }],
    }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Is a remote call worth making?
 *
 * Yes when the local scorer is under-confident (little history, or a thin
 * candidate list) or when its top two are effectively tied. No otherwise —
 * a settled habit with a clear winner doesn't need a second opinion, and not
 * asking keeps the answer instant and free.
 */
/**
 * How far above chance the top option must sit. 1.0 is exactly uniform (no
 * information); 1.4 means the winner carries 40% more mass than if the model
 * had shrugged.
 */
export const MIN_LIFT = 1.4

/**
 * The model's self-assessment must also beat chance, by this multiple. Like
 * the lift, it is measured AGAINST 1/n, never against a flat number: an
 * earlier flat 0.35 floor silently rejected every answer over ten options,
 * however sharp, because confidence tracks the top probability and 10-way
 * answers physically top out around 0.3. Same cardinality mistake as the
 * original 0.6 gate, one constant lower — this is the version that can't
 * repeat it.
 */
export const MIN_SELF_TRUST = 1.2

/** Which gate a remote answer failed, if any. One source of truth: the accept
 *  decision AND the words on screen both come from here, so the status line
 *  can never call an answer "unclear" while the detail line says "clear
 *  winner" — the contradiction that motivated this shape. */
export type GateVerdict = 'ok' | 'solo' | 'self-doubt' | 'flat'

export function remoteGate(
  confidence: number,
  topProbability: number,
  optionCount: number,
): { verdict: GateVerdict; lift: number; confFloor: number } {
  const uniform = optionCount > 0 ? 1 / optionCount : 1
  const lift = topProbability / uniform
  const confFloor = Math.round(MIN_SELF_TRUST * uniform * 1000) / 1000
  if (optionCount < 2) return { verdict: 'solo', lift, confFloor }
  if (confidence < confFloor) return { verdict: 'self-doubt', lift, confFloor }
  if (lift < MIN_LIFT) return { verdict: 'flat', lift, confFloor }
  return { verdict: 'ok', lift, confFloor }
}

/** Is the remote answer actually informative? See `remoteGate`. */
export function remoteIsInformative(
  confidence: number,
  topProbability: number,
  optionCount: number,
): boolean {
  return remoteGate(confidence, topProbability, optionCount).verdict === 'ok'
}

export function shouldConsultRemote(state: DecisionState, local: readonly Scored[]): boolean {
  // Nothing to choose between — a second opinion cannot change the answer.
  if (state.candidates.filter((c) => c.available).length < 2) return false
  const confidence = local[0]?.confidence ?? 0
  return confidence < MIN_CONFIDENCE || isAmbiguous(local)
}

/**
 * Why the last ranking came from where it did.
 *
 * "It answered on-device" is not diagnostic on its own — a confident local
 * answer and a broken deployment look identical to the user. Naming the cause
 * is what makes a missing binding or an unreachable worker visible instead of
 * silently indistinguishable from working correctly.
 */
export type ScoreReason =
  | 'used'            // the remote answer was taken
  | 'not-needed'      // local was confident and unambiguous; no call made
  | 'single-option'   // nothing to choose between
  | 'unreachable'     // offline, DNS, CORS — the request never completed
  | 'server-error'    // the endpoint answered, but not with 2xx
  | 'low-confidence'  // the model answered below the floor, so it was discarded

/** Everything a side-by-side test run needs, with nothing blended. */
export interface Comparison {
  /** The on-device ranking, exactly as the offline path would show it. */
  local: Scored[]
  /** Jev's ranking — raw probabilities, NOT merged with local reasons, and
   *  NOT gated: shown even when the production path would discard it. */
  remote: Scored[] | null
  gate: { verdict: GateVerdict; lift: number; confFloor: number } | null
  remoteMeta: { confidence: number; top: number; options: number } | null
  /** Do the two top picks match? Null when either side is missing. */
  agree: boolean | null
  failure: ScoreReason | null
  status: number
  detail: string
}

/**
 * Remote scorer with an unconditional local fallback.
 *
 * Falls back on: offline, HTTP error, empty candidate set, or an
 * uninformative answer. The caller cannot end up with no answer — and
 * `lastReason` says which of those happened.
 */
export class JevScorer implements Scorer {
  /** Which scorer actually produced the last result, for the UI to show. */
  lastSource: 'local' | 'remote' = 'local'
  /** Why — see `ScoreReason`. Surfaced in the UI so failures aren't silent. */
  lastReason: ScoreReason = 'not-needed'
  /** HTTP status when `lastReason` is 'server-error', else 0. */
  lastStatus = 0
  /** The server's own error code, when it sent one. A bare status number is
   *  not enough to act on — 502 could be a missing model, a rejected schema
   *  or a quota, and only the body distinguishes them. */
  lastDetail = ''
  /** What the model actually returned, kept even when the answer is rejected —
   *  a threshold can only be calibrated against real numbers. */
  lastRemote: { confidence: number; top: number; options: number } | null = null

  constructor(
    private endpoint = '/api/decide',
    private fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  /** One transport for both the production path and the test bench, so a
   *  comparison exercises exactly the request the real path sends. */
  private async callRemote(state: DecisionState): Promise<
    | { ok: true; ranked: Scored[]; meta: { confidence: number; top: number; options: number } }
    | { ok: false; reason: 'unreachable' | 'server-error'; status: number; detail: string }
  > {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: stateKey(state), request: buildRequest(state) }),
      })
      if (!res.ok) {
        let detail = ''
        try {
          const body = (await res.json()) as { error?: string; detail?: string }
          detail = [body.error, body.detail].filter(Boolean).join(': ').slice(0, 300)
        } catch { /* body unreadable — the status alone will have to do */ }
        return { ok: false, reason: 'server-error', status: res.status, detail }
      }
      const ranked = readRanking(state, (await res.json()) as JevResponse)
      const top = ranked[0]
      const options = state.candidates.filter((c) => c.available).length
      return {
        ok: true,
        ranked,
        meta: { confidence: top?.confidence ?? 0, top: top?.score ?? 0, options },
      }
    } catch {
      return { ok: false, reason: 'unreachable', status: 0, detail: '' }
    }
  }

  async rank(state: DecisionState): Promise<Scored[]> {
    const local = rankLocal(state)
    this.lastSource = 'local'
    this.lastStatus = 0
    this.lastDetail = ''
    this.lastRemote = null
    if (state.candidates.length === 0 || !this.fetchImpl) {
      this.lastReason = 'single-option'
      return local
    }
    // Spend a call only when the cheap scorer is genuinely unsure — either it
    // lacks the history to stand on, or its top two are a coin toss. A user
    // with deep history and a clear winner gets an instant offline answer and
    // costs nothing.
    if (!shouldConsultRemote(state, local)) {
      this.lastReason =
        state.candidates.filter((c) => c.available).length < 2 ? 'single-option' : 'not-needed'
      return local
    }
    const r = await this.callRemote(state)
    if (!r.ok) {
      this.lastReason = r.reason
      this.lastStatus = r.status
      this.lastDetail = r.detail
      return local
    }
    this.lastRemote = r.meta
    if (!remoteIsInformative(r.meta.confidence, r.meta.top, r.meta.options)) {
      this.lastReason = 'low-confidence'
      return local
    }
    // Keep the local reasons alongside the remote score: the user still gets
    // a breakdown they can argue with, whichever scorer produced the number.
    const byKey = new Map(local.map((s) => [s.key, s.reasons]))
    this.lastSource = 'remote'
    this.lastReason = 'used'
    return r.ranked.map((s) => ({ ...s, reasons: [...(byKey.get(s.key) ?? []), ...s.reasons] }))
  }

  /**
   * The test bench: both scorers on the SAME state, kept apart.
   *
   * Unlike rank(), this always calls the model (no cost gate — the point is to
   * exercise it), never merges local reasons into Jev's ranking, and returns
   * Jev's answer even when the production gate would discard it. The gate
   * verdict is reported alongside instead, so "what did Jev say" and "would
   * the normal mode have used it" are separately visible — which is what
   * testing capacity means.
   */
  async compare(state: DecisionState): Promise<Comparison> {
    const local = rankLocal(state)
    const none = { gate: null, remoteMeta: null, agree: null, status: 0, detail: '' }
    if (!this.fetchImpl || state.candidates.filter((c) => c.available).length < 2) {
      return { ...none, local, remote: null, failure: 'single-option' }
    }
    const r = await this.callRemote(state)
    if (!r.ok) {
      return { ...none, local, remote: null, failure: r.reason, status: r.status, detail: r.detail }
    }
    const first = local.find((x) => x.score > 0)
    const rfirst = r.ranked.find((x) => x.score > 0)
    return {
      local,
      remote: r.ranked,
      gate: remoteGate(r.meta.confidence, r.meta.top, r.meta.options),
      remoteMeta: r.meta,
      agree: first && rfirst ? first.key === rfirst.key : null,
      failure: null,
      status: 0,
      detail: '',
    }
  }
}
