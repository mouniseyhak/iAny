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
 *  3. Below `MIN_CONFIDENCE` the caller falls back to the local scorer, which
 *     turns "confidently wrong" from a silent failure into a handled branch.
 *     Calibrated is not the same as correct, and the floor is where we say so.
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

const WEATHER_TEXT: Record<string, string> = {
  hot: 'hot (above 32C)',
  warm: 'warm (26-32C)',
  cool: 'cool (below 26C)',
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
export function describeState(state: DecisionState): string {
  const what = state.domain === 'meal' ? 'eat' : 'wear'
  const depth = state.historyCount < 10
    ? 'Their history is short, so habit signals are weak.'
    : `They have ${state.historyCount} past entries.`
  const recent = state.recentTags.length
    ? ` Recent choices were mostly: ${[...new Set(state.recentTags)].join(', ')}.`
    : ''
  return (
    `A person in Cambodia is deciding what to ${what} for the ${state.slot} ` +
    `of a ${state.dayType} day. The weather is ${WEATHER_TEXT[state.weather] ?? state.weather} ` +
    `and it is ${state.rain}. ${depth}${recent} ` +
    `Prefer variety over repetition, and comfort appropriate to the weather.`
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
  const verb = state.domain === 'meal' ? 'eat' : 'wear'
  return {
    pick: {
      type: 'choice',
      instructions: `Which option should the person ${verb} right now?`,
      criteria,
    },
    heaviness: {
      type: 'score',
      instructions: 'How heavy should the choice be, given the weather and time of day?',
      criteria: ['Light', 'Moderate', 'Heavy'],
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

/**
 * Remote scorer with an unconditional local fallback.
 *
 * Falls back on: offline, HTTP error, empty candidate set, or a confidence
 * below the floor. The caller cannot end up with no answer — and `lastReason`
 * says which of those happened.
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

  constructor(
    private endpoint = '/api/decide',
    private fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  async rank(state: DecisionState): Promise<Scored[]> {
    const local = rankLocal(state)
    this.lastSource = 'local'
    this.lastStatus = 0
    this.lastDetail = ''
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
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: stateKey(state), request: buildRequest(state) }),
      })
      if (!res.ok) {
        this.lastReason = 'server-error'
        this.lastStatus = res.status
        try {
          const body = (await res.json()) as { error?: string; detail?: string }
          this.lastDetail = [body.error, body.detail].filter(Boolean).join(': ').slice(0, 300)
        } catch {
          this.lastDetail = ''
        }
        return local
      }
      const remote = readRanking(state, (await res.json()) as JevResponse)
      const top = remote[0]
      if (!top || top.confidence < MIN_CONFIDENCE) {
        this.lastReason = 'low-confidence'
        return local
      }
      // Keep the local reasons alongside the remote score: the user still gets
      // a breakdown they can argue with, whichever scorer produced the number.
      const byKey = new Map(local.map((s) => [s.key, s.reasons]))
      this.lastSource = 'remote'
      this.lastReason = 'used'
      return remote.map((s) => ({ ...s, reasons: [...(byKey.get(s.key) ?? []), ...s.reasons] }))
    } catch {
      this.lastReason = 'unreachable'
      return local
    }
  }
}
