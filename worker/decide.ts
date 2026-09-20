/**
 * POST /api/decide — the online half of the Decide engine.
 *
 * The device does all the thinking it can offline and only calls here when its
 * own scorer is unsure (see src/decide/jev.ts `shouldConsultRemote`). This
 * handler is deliberately thin:
 *
 *   cache hit  → return the stored answer, no model call, no cost
 *   cache miss → env.AI.run('typesafe/jev', …) → store → return
 *
 * Why the call lives here and not in the browser: the Workers AI binding is an
 * account credential, and a cache shared between users is worth far more than
 * a per-device one. Because `stateKey` is built from bucketed enums, different
 * people in the same situation hit the SAME key — one person's miss warms the
 * answer for everyone else that day.
 *
 * That cache is also the offline decision pack. Same keys, same values: sweep
 * it into a JSON bundle and a device can answer with Jev's judgement while
 * fully offline.
 *
 * Nothing identifying arrives here. The body carries opaque candidate ids and
 * a sentence built from enums; see src/decide/state.ts for the boundary.
 */

import { describeShape, normalizeJevResponse } from '../src/decide/jev'

export interface DecideEnv {
  /** Workers AI binding (wrangler.jsonc `"ai": { "binding": "AI" }`). */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> }
  /** Optional KV namespace for the shared answer cache. */
  DECIDE_CACHE?: KVNamespace
}

const MODEL = 'typesafe/jev'
/** Situations recur daily; a day is long enough to be useful, short enough
 *  that a weight or prompt change washes out on its own. */
const CACHE_TTL_SECONDS = 86_400
/** Jev's context window is 32k tokens; this bounds the body well inside it. */
const MAX_BODY_BYTES = 24_000
const MAX_CANDIDATES = 255

interface DecideBody {
  key?: unknown
  request?: {
    state?: unknown
    questions?: Record<string, { type?: unknown; criteria?: unknown }>
  }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  })

/**
 * Validates the request shape before it reaches the model.
 *
 * The client builds this body, so it is untrusted input: a malformed or
 * oversized `questions` map would otherwise be forwarded straight to a billed
 * API call.
 */
function validate(body: DecideBody): string | null {
  if (typeof body.key !== 'string' || body.key.length === 0 || body.key.length > 4096) {
    return 'bad-key'
  }
  const req = body.request
  if (!req || typeof req.state !== 'string' || req.state.length === 0) return 'bad-state'
  const questions = req.questions
  if (!questions || typeof questions !== 'object') return 'bad-questions'
  const names = Object.keys(questions)
  if (names.length === 0 || names.length > 16) return 'bad-questions'
  for (const name of names) {
    const q = questions[name]
    if (!q || typeof q.type !== 'string') return 'bad-question-type'
    if (!['choice', 'score', 'noul'].includes(q.type)) return 'bad-question-type'
    if (q.type === 'choice') {
      const n = Object.keys((q.criteria as Record<string, string>) ?? {}).length
      if (n < 1 || n > MAX_CANDIDATES) return 'bad-choice-cardinality'
    }
  }
  return null
}

export async function handleDecide(request: Request, env: DecideEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413)

  let body: DecideBody
  try {
    body = JSON.parse(raw) as DecideBody
  } catch {
    return json({ error: 'bad-json' }, 400)
  }

  const invalid = validate(body)
  if (invalid) return json({ error: invalid }, 400)

  const cacheKey = `decide:v1:${body.key as string}`

  if (env.DECIDE_CACHE) {
    const hit = await env.DECIDE_CACHE.get(cacheKey)
    if (hit) return json(JSON.parse(hit), 200, { 'x-decide-source': 'cache' })
  }

  // No binding configured — say so plainly rather than failing opaquely. The
  // client treats any non-OK response as "use the local scorer", so the app
  // keeps working; this is a deployment gap, not a user-facing error.
  if (!env.AI) return json({ error: 'ai-binding-missing' }, 503)

  let answer: unknown
  try {
    answer = await env.AI.run(MODEL, body.request)
  } catch (err) {
    return json({ error: 'model-failed', detail: String(err) }, 502)
  }

  // Workers AI may wrap the model's output; find the answer inside whatever
  // envelope it came in rather than demanding one exact shape.
  const normalized = normalizeJevResponse(answer)
  if (!normalized) {
    // Name what DID arrive — "model-shape" alone gave nothing to act on.
    return json({ error: 'model-shape', detail: describeShape(answer) }, 502)
  }

  // Cache the NORMALIZED form, so a cache hit and a fresh call are
  // indistinguishable to the client. Never cache a malformed answer: it would
  // serve the failure to every device landing on this key for a day.
  if (env.DECIDE_CACHE) {
    await env.DECIDE_CACHE.put(cacheKey, JSON.stringify(normalized), {
      expirationTtl: CACHE_TTL_SECONDS,
    })
  }

  return json(normalized, 200, { 'x-decide-source': 'model' })
}
