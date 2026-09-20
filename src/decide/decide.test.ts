/**
 * Decide regression test — the scorer decides what a person eats and wears, so
 * a silent sign error here produces confidently bad advice every single day.
 * Also guards the privacy boundary: nothing user-authored may reach the remote
 * request builder. Run: npm run test:decide
 */
import {
  type Candidate,
  type DecisionState,
  type Tag,
  agoBucket,
  calendarDaysBetween,
  sanitizeTags,
  slotFor,
  seedCandidate,
  seedGapDays,
  stateKey,
  weatherBucket,
} from './state'
import { isAmbiguous, localConfidence, rankLocal, scoreCandidate } from './suggest'
import { cosineDistance, normalize, updateCentroid, verdictFor } from './match'
import { JevScorer, buildQuestions, describeState, readRanking, shouldConsultRemote } from './jev'

let pass = 0; const fails: string[] = []
const ok = (n: string, c: boolean) => { c ? (pass++, console.log('  ✓', n)) : (fails.push(n), console.log('  ✗', n)) }

const cand = (key: string, tags: string[], over: Partial<Candidate> = {}): Candidate => ({
  key,
  tags: tags as Tag[],
  daysSinceUsed: 5,
  timesUsed: 4,
  rating: null,
  available: true,
  ...over,
})

const state = (over: Partial<DecisionState> = {}): DecisionState => ({
  domain: 'meal',
  slot: 'midday',
  dayType: 'work',
  weather: 'warm',
  rain: 'dry',
  historyCount: 60,
  recentTags: [],
  candidates: [],
  ...over,
})

const scoreOf = (s: DecisionState, c: Candidate) => scoreCandidate(s, c).score
const rankKeys = (s: DecisionState) => rankLocal(s).map((r) => r.key)

console.log('\nbuckets')
ok('35C is hot', weatherBucket(35) === 'hot')
ok('29C is warm', weatherBucket(29) === 'warm')
ok('22C is cool', weatherBucket(22) === 'cool')
ok('07:00 is morning', slotFor(7) === 'morning')
ok('12:00 is midday', slotFor(12) === 'midday')
ok('19:00 is evening', slotFor(19) === 'evening')
ok('ago buckets collapse', agoBucket(4) === '3-6' && agoBucket(5) === '3-6' && agoBucket(40) === '14+')
ok('never stays distinct', agoBucket(null) === 'never')

// Calendar days, not 24h spans: dinner yesterday → breakfast today is 1 day.
const dinner = new Date(2026, 8, 19, 20, 0)
const breakfast = new Date(2026, 8, 20, 7, 0)
ok('11h across midnight = 1 day', calendarDaysBetween(dinner, breakfast) === 1)
ok('same day = 0 days', calendarDaysBetween(new Date(2026, 8, 20, 7, 0), breakfast) === 0)

console.log('\nvocabulary guard (privacy boundary)')
ok('drops out-of-vocabulary tags', sanitizeTags('meal', ['soup', 'ស៊ុប', 'made-up']).join() === 'soup')
ok('drops cross-domain tags', sanitizeTags('meal', ['formal', 'rice']).join() === 'rice')
ok('dedupes and sorts', sanitizeTags('meal', ['rice', 'soup', 'rice']).join() === 'rice,soup')

console.log('\nrecency and rotation')
const s = state()
ok('eaten today ranks below eaten 5 days ago',
   scoreOf(s, cand('a', ['rice'], { daysSinceUsed: 0 })) < scoreOf(s, cand('b', ['rice'])))
ok('eaten yesterday ranks below eaten 5 days ago',
   scoreOf(s, cand('a', ['rice'], { daysSinceUsed: 1 })) < scoreOf(s, cand('b', ['rice'])))
ok('overdue beats recent',
   scoreOf(s, cand('a', ['rice'], { daysSinceUsed: 30 })) > scoreOf(s, cand('b', ['rice'], { daysSinceUsed: 2 })))
ok('yesterday cites too-recent',
   scoreCandidate(s, cand('a', ['rice'], { daysSinceUsed: 1 })).reasons.some((r) => r.code === 'too-recent'))
ok('rotation is per-candidate, not global',
   // daily rice (15 uses) is not "overdue" at 3 days; weekly fish (2 uses) is.
   scoreOf(s, cand('fish', ['grill'], { daysSinceUsed: 30, timesUsed: 2 })) >
   scoreOf(s, cand('rice', ['grill'], { daysSinceUsed: 3, timesUsed: 15 })))

console.log('\nvariety')
const fatigued = state({ recentTags: ['fried', 'fried', 'fried', 'fried'] as Tag[] })
ok('four fried days pushes fried down',
   scoreOf(fatigued, cand('a', ['fried'])) < scoreOf(fatigued, cand('b', ['soup'])))
ok('fatigue is cited',
   scoreCandidate(fatigued, cand('a', ['fried'])).reasons.some((r) => r.code === 'tag-fatigue'))
ok('never-tried gets a nudge',
   scoreOf(s, cand('new', ['rice'], { daysSinceUsed: null, timesUsed: 0 })) >
   scoreOf(s, cand('old', ['rice'], { daysSinceUsed: 2 })))

console.log('\nweather')
const hot = state({ weather: 'hot' })
const cool = state({ weather: 'cool' })
ok('hot day prefers salad over soup', scoreOf(hot, cand('a', ['salad'])) > scoreOf(hot, cand('b', ['soup'])))
ok('cool day prefers soup over salad', scoreOf(cool, cand('a', ['soup'])) > scoreOf(cool, cand('b', ['salad'])))
ok('hot day pushes heavy down', scoreOf(hot, cand('a', ['heavy'])) < scoreOf(hot, cand('b', ['light'])))
ok('weather clash is cited',
   scoreCandidate(hot, cand('a', ['soup'])).reasons.some((r) => r.code === 'weather-clash'))

const rainy = state({ domain: 'outfit', rain: 'rain' })
ok('rain prefers rain-proof',
   scoreOf(rainy, cand('a', ['rain-proof'])) > scoreOf(rainy, cand('b', ['light'])))

console.log('\nslot and day type')
const morning = state({ slot: 'morning' })
ok('morning prefers noodle over heavy',
   scoreOf(morning, cand('a', ['noodle'])) > scoreOf(morning, cand('b', ['heavy'])))
const workday = state({ domain: 'outfit', dayType: 'work' })
const restday = state({ domain: 'outfit', dayType: 'rest' })
ok('work day prefers formal', scoreOf(workday, cand('a', ['formal'])) > scoreOf(workday, cand('b', ['casual'])))
ok('rest day prefers casual', scoreOf(restday, cand('a', ['casual'])) > scoreOf(restday, cand('b', ['formal'])))

console.log('\navailability (the laundry rule)')
const inWash = scoreCandidate(state({ domain: 'outfit' }), cand('a', ['formal'], { available: false }))
ok('unavailable scores 0', inWash.score === 0)
ok('unavailable is certain, not a guess', inWash.confidence === 1)
ok('unavailable cites why', inWash.reasons[0]?.code === 'unavailable')
ok('unavailable cannot win',
   rankKeys(state({ domain: 'outfit', candidates: [
     cand('clean', ['casual'], { daysSinceUsed: 1 }),
     cand('dirty', ['formal'], { daysSinceUsed: 30, available: false }),
   ] }))[0] === 'clean')

console.log('\nconfidence (cold start must admit it)')
ok('no history → low confidence', localConfidence(state({ historyCount: 0 })) <= 0.2)
ok('confidence grows with history',
   localConfidence(state({ historyCount: 10 })) < localConfidence(state({ historyCount: 50 })))
ok('confidence is capped', localConfidence(state({ historyCount: 10_000 })) <= 0.9)
ok('cold start stays below the fallback floor', localConfidence(state({ historyCount: 3 })) < 0.6)

console.log('\nseeding (favourites typed at setup, no waiting)')
const seeded = seedCandidate('uuid-1', 'meal', ['soup', 'ស៊ុប'], 'weekly')
ok('seeded item has no observations yet',
   seeded.daysSinceUsed === null && seeded.timesUsed === 0)
ok('seeded item carries the stated cadence', seeded.expectedGapDays === 7)
ok('seeded tags are sanitized', seeded.tags.join() === 'soup')
ok('frequency maps to a gap', seedGapDays('daily') === 2 && seedGapDays('rare') === 30)

// A seeded list still answers, because weather and slot fit need no history.
const seedList = state({
  historyCount: 0,
  candidates: [
    seedCandidate('salad', 'meal', ['salad', 'light'], 'sometimes'),
    seedCandidate('soup', 'meal', ['soup'], 'weekly'),
    seedCandidate('rice', 'meal', ['rice'], 'daily'),
    seedCandidate('noodle', 'meal', ['noodle'], 'weekly'),
    seedCandidate('grill', 'meal', ['grill'], 'rare'),
  ],
})
ok('seeded list answers on a hot day',
   rankKeys({ ...seedList, weather: 'hot' })[0] === 'salad')
ok('seeded list answers differently when cool',
   rankKeys({ ...seedList, weather: 'cool' })[0] === 'soup')
ok('seeded confidence beats bare cold start',
   localConfidence(seedList) > localConfidence(state({ historyCount: 0 })))
ok('seeded confidence stays under the fallback floor',
   localConfidence(seedList) < 0.6)
ok('untagged candidates earn no grounding',
   localConfidence(state({ historyCount: 0, candidates: [cand('x', []), cand('y', [])] })) === 0.2)
ok('a thin list earns less grounding than a broad one',
   localConfidence({ ...seedList, candidates: seedList.candidates.slice(0, 2) }) <
   localConfidence(seedList))
ok('real history still outranks grounding',
   localConfidence({ ...seedList, historyCount: 60 }) === 0.9)

// The stated cadence earns its keep from the first real log entry onward.
const statedDaily = cand('a', ['rice'], { daysSinceUsed: 5, timesUsed: 0, expectedGapDays: 2 })
const statedRare = cand('b', ['rice'], { daysSinceUsed: 5, timesUsed: 0, expectedGapDays: 30 })
ok('stated-daily item is overdue after 5 days',
   scoreCandidate(state({ historyCount: 1 }), statedDaily).reasons.some((r) => r.code === 'overdue'))
ok('stated-rare item is not overdue after 5 days',
   !scoreCandidate(state({ historyCount: 1 }), statedRare).reasons.some((r) => r.code === 'overdue'))
ok('stated cadence outranks an unseen one',
   scoreOf(state({ historyCount: 1 }), statedDaily) > scoreOf(state({ historyCount: 1 }), statedRare))
ok('stated cadence overrides the log-derived gap',
   // 30 uses in 60 entries implies a 2-day rhythm, but the user said "rarely".
   !scoreCandidate(s, cand('c', ['rice'], { daysSinceUsed: 5, timesUsed: 30, expectedGapDays: 30 }))
     .reasons.some((r) => r.code === 'overdue'))

console.log('\nranking')
const ranked = rankLocal(state({ candidates: [
  cand('yesterday', ['rice'], { daysSinceUsed: 1 }),
  cand('overdue', ['rice'], { daysSinceUsed: 20 }),
  cand('normal', ['rice'], { daysSinceUsed: 5 }),
] }))
ok('sorted descending', ranked[0]!.score >= ranked[1]!.score && ranked[1]!.score >= ranked[2]!.score)
ok('overdue wins, yesterday loses',
   ranked[0]!.key === 'overdue' && ranked[2]!.key === 'yesterday')
ok('scores stay in 0..1', ranked.every((r) => r.score >= 0 && r.score <= 1))
ok('ties are stable by key',
   rankKeys(state({ candidates: [cand('b', ['rice']), cand('a', ['rice'])] })).join() === 'a,b')

console.log('\ncache key')
const c1 = cand('x', ['rice']), c2 = cand('y', ['soup'])
ok('candidate order does not change the key',
   stateKey(state({ candidates: [c1, c2] })) === stateKey(state({ candidates: [c2, c1] })))
ok('weather changes the key',
   stateKey(state({ candidates: [c1] })) !== stateKey(state({ weather: 'hot', candidates: [c1] })))
ok('same ago-bucket reuses the key',
   stateKey(state({ candidates: [cand('x', ['rice'], { daysSinceUsed: 4 })] })) ===
   stateKey(state({ candidates: [cand('x', ['rice'], { daysSinceUsed: 6 })] })))
ok('crossing a bucket changes the key',
   stateKey(state({ candidates: [cand('x', ['rice'], { daysSinceUsed: 1 })] })) !==
   stateKey(state({ candidates: [cand('x', ['rice'], { daysSinceUsed: 9 })] })))
ok('history depth is bucketed, not exact',
   stateKey(state({ historyCount: 61, candidates: [c1] })) ===
   stateKey(state({ historyCount: 400, candidates: [c1] })))

console.log('\nphoto matching')
ok('close and clear → confident',
   verdictFor([{ itemId: 'a', distance: 0.05 }, { itemId: 'b', distance: 0.5 }]).kind === 'confident')
ok('close but ambiguous → review (two rice plates)',
   verdictFor([{ itemId: 'a', distance: 0.10 }, { itemId: 'b', distance: 0.12 }]).kind === 'review')
ok('far → unknown, ask for a name',
   verdictFor([{ itemId: 'a', distance: 0.9 }]).kind === 'unknown')
ok('empty → unknown', verdictFor([]).kind === 'unknown')
const review = verdictFor(
  [{ itemId: 'c', distance: 0.30 }, { itemId: 'a', distance: 0.22 }, { itemId: 'b', distance: 0.26 }, { itemId: 'd', distance: 0.33 }])
ok('review options are nearest-first and capped',
   review.kind === 'review' && review.options.length === 3 && review.options[0]!.itemId === 'a')

console.log('\ncentroid learning')
const v1 = normalize(Float32Array.from([1, 0, 0]))
const v2 = normalize(Float32Array.from([0, 1, 0]))
ok('normalize gives unit length', Math.abs(cosineDistance(v1, v1)) < 1e-6)
ok('orthogonal distance is 1', Math.abs(cosineDistance(v1, v2) - 1) < 1e-6)
ok('zero vector survives normalize', normalize(new Float32Array(3)).every((n) => n === 0))
const merged = updateCentroid(v1, 1, v2)
ok('centroid moves toward the new sample', cosineDistance(merged, v2) < cosineDistance(v1, v2))
ok('centroid stays unit length',
   Math.abs(Math.hypot(...Array.from(merged)) - 1) < 1e-6)
ok('first sample becomes the centroid',
   cosineDistance(updateCentroid(new Float32Array(3), 0, v2), v2) < 1e-6)
const heavy = updateCentroid(v1, 20, v2)
ok('more samples means more inertia', cosineDistance(heavy, v1) < cosineDistance(merged, v1))

console.log('\nremote request (nothing personal may cross)')
const remoteState = state({ candidates: [
  cand('uuid-1', ['soup']),
  cand('uuid-2', ['fried'], { available: false }),
] })
const described = describeState(remoteState)
ok('no Khmer script in the request', !/[ក-៿]/.test(described))
ok('describes the situation', described.includes('midday') && described.includes('work'))
const qs = buildQuestions(remoteState)
const pickQ = qs['pick'] as { type: string; criteria: Record<string, string> }
ok('choice covers available candidates only',
   Object.keys(pickQ.criteria).join() === 'uuid-1')
ok('criteria carry tags, never labels', pickQ.criteria['uuid-1']!.includes('soup'))
ok('asks a score and a noul too', qs['heaviness']?.type === 'score' && qs['needs_variety']?.type === 'noul')

const remote = readRanking(remoteState, {
  answers: {
    pick: { type: 'choice', choice: 'uuid-1', confidence: 0.8, probabilities: { 'uuid-1': 0.9 } },
    needs_variety: { type: 'noul', noul: 0.95 },
  },
})
ok('probabilities become scores', remote[0]!.key === 'uuid-1' && remote[0]!.score === 0.9)
ok('unavailable stays 0 even if the model picked it',
   remote.find((r) => r.key === 'uuid-2')!.score === 0)
ok('high variety signal is cited',
   remote[0]!.reasons.some((r) => r.code === 'tag-fatigue'))
ok('missing answers degrade to 0, not NaN',
   readRanking(remoteState, { answers: {} }).every((r) => r.score === 0 && !Number.isNaN(r.score)))

console.log('\nwhen to spend a remote call')
const deep = state({ historyCount: 60, candidates: [
  cand('a', ['rice'], { daysSinceUsed: 20 }), cand('b', ['soup'], { daysSinceUsed: 1 }) ] })
ok('clear winner with deep history → stay offline',
   !shouldConsultRemote(deep, rankLocal(deep)))
const tied = state({ historyCount: 60, candidates: [cand('a', ['rice']), cand('b', ['rice'])] })
ok('a coin toss is worth asking about', shouldConsultRemote(tied, rankLocal(tied)))
const thin = state({ historyCount: 2, candidates: [cand('a', ['rice']), cand('b', ['soup'])] })
ok('low confidence is worth asking about', shouldConsultRemote(thin, rankLocal(thin)))
ok('one candidate is never worth a call',
   !shouldConsultRemote(state({ historyCount: 0, candidates: [cand('a', ['rice'])] }),
                        rankLocal(state({ historyCount: 0, candidates: [cand('a', ['rice'])] }))))
ok('ambiguity needs two entries', !isAmbiguous(rankLocal(state({ candidates: [cand('a', ['rice'])] }))))
ok('a wide gap is not ambiguous',
   !isAmbiguous([{ key: 'a', score: 0.9, confidence: 1, reasons: [] },
                 { key: 'b', score: 0.2, confidence: 1, reasons: [] }]))

// Offline / server failure must never leave the user with nothing.
const offlineScorer = new JevScorer('/api/decide', (async () => {
  throw new Error('offline')
}) as unknown as typeof fetch)
const offlineRanked = await offlineScorer.rank(thin)
ok('network failure still returns a ranking', offlineRanked.length === 2)
ok('network failure reports local provenance', offlineScorer.lastSource === 'local')
ok('network failure names the cause', offlineScorer.lastReason === 'unreachable')

const badStatus = new JevScorer('/api/decide', (async () =>
  new Response('nope', { status: 503 })) as unknown as typeof fetch)
ok('server error falls back to local', (await badStatus.rank(thin)).length === 2)
ok('server error names the cause', badStatus.lastReason === 'server-error')
ok('server error keeps the status code', badStatus.lastStatus === 503)

const lowConf = new JevScorer('/api/decide', (async () => new Response(JSON.stringify({
  answers: { pick: { type: 'choice', confidence: 0.1, probabilities: { a: 0.5, b: 0.5 } } },
}))) as unknown as typeof fetch)
await lowConf.rank(thin)
ok('an under-confident remote answer is discarded', lowConf.lastSource === 'local')
ok('a discarded answer names the cause', lowConf.lastReason === 'low-confidence')

const goodConf = new JevScorer('/api/decide', (async () => new Response(JSON.stringify({
  answers: { pick: { type: 'choice', confidence: 0.85, probabilities: { a: 0.7, b: 0.3 } } },
}))) as unknown as typeof fetch)
const remoteRanked = await goodConf.rank(thin)
ok('a confident remote answer is used', goodConf.lastSource === 'remote')
ok('a used answer says so', goodConf.lastReason === 'used')
ok('remote answers keep the local reasons for the breakdown',
   remoteRanked[0]!.key === 'a' && remoteRanked[0]!.score === 0.7)

// A confident local answer must be distinguishable from a broken deployment.
const skipper = new JevScorer('/api/decide', (async () => {
  throw new Error('should not be called')
}) as unknown as typeof fetch)
await skipper.rank(deep)
ok('a skipped call says it was not needed', skipper.lastReason === 'not-needed')
const solo = state({ historyCount: 0, candidates: [cand('a', ['rice'])] })
await skipper.rank(solo)
ok('one option says so, not "unreachable"', skipper.lastReason === 'single-option')

console.log(`\n${fails.length ? '❌' : '✅'} ${pass} passed, ${fails.length} failed`)
if (fails.length) throw new Error(fails.join('; '))
