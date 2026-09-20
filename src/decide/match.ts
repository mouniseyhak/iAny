/**
 * Photo matching — pure vector maths, no DB, no model.
 *
 * The trick that makes this work offline in Khmer: we never classify. No
 * pretrained model knows នំបញ្ចុក or សម្លការី — Food-101 is pizza and
 * hamburgers. So instead of asking "what dish is this?", we ask "does this
 * look like something I've already photographed?". The vision encoder supplies
 * similarity; the USER supplies the Khmer name, once. After that it matches
 * itself.
 *
 * This bootstraps fast because people are repetitive: a typical rotation is
 * 30-50 dishes, so within about two weeks most photos match automatically.
 */

/**
 * Image-embedding width. Deliberately NOT `EMBEDDING_DIMS` from ../types —
 * that one is the text model's, pinned so knowledge packs import without
 * re-embedding. Mixing the two into one column would silently corrupt both
 * indexes.
 */
export const VISION_DIMS = 512

/**
 * Cosine distance (0 = identical) below which a photo is confidently the same
 * item. Above `REVIEW_DISTANCE` we don't even offer a guess.
 */
export const MATCH_DISTANCE = 0.18
export const REVIEW_DISTANCE = 0.38

export interface MatchRow {
  itemId: string
  /** pgvector `<=>` cosine distance. */
  distance: number
}

export type MatchVerdict =
  /** Close enough to label automatically — still shown, still correctable. */
  | { kind: 'confident'; itemId: string; distance: number }
  /** Plausible, but the user picks from a short list. */
  | { kind: 'review'; options: MatchRow[] }
  /** Nothing close. Ask for a name; this becomes a new item. */
  | { kind: 'unknown' }

/**
 * Turns nearest-neighbour rows into a decision.
 *
 * Two dishes of rice-and-meat embed very close together, so a single nearest
 * hit is not enough evidence. A confident verdict needs the best match to be
 * both close AND clearly ahead of the runner-up — otherwise the user gets a
 * short list to tap, which is faster than correcting a wrong auto-label.
 */
export function verdictFor(rows: readonly MatchRow[], maxOptions = 3): MatchVerdict {
  const sorted = [...rows].sort((a, b) => a.distance - b.distance)
  const best = sorted[0]
  if (!best || best.distance > REVIEW_DISTANCE) return { kind: 'unknown' }

  const runnerUp = sorted[1]
  const clear = !runnerUp || runnerUp.distance - best.distance > 0.06
  if (best.distance <= MATCH_DISTANCE && clear) {
    return { kind: 'confident', itemId: best.itemId, distance: best.distance }
  }
  return { kind: 'review', options: sorted.slice(0, maxOptions) }
}

/** In-place-safe L2 normalisation; cosine distance assumes unit vectors. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
  return out
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i]! * b[i]!
  return 1 - dot
}

/**
 * Folds a newly confirmed photo into an item's centroid.
 *
 * Running mean, then renormalised: each confirmation makes the item's
 * signature a little more robust to plate, lighting and angle. This is the
 * entire "learning" in the system — no training loop, no gradients, and it
 * improves with the very first correction the user makes.
 */
export function updateCentroid(
  centroid: Float32Array,
  samples: number,
  next: Float32Array,
): Float32Array {
  if (samples <= 0) return normalize(next)
  const out = new Float32Array(centroid.length)
  for (let i = 0; i < centroid.length; i++) {
    out[i] = (centroid[i]! * samples + (next[i] ?? 0)) / (samples + 1)
  }
  return normalize(out)
}
