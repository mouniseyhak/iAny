/**
 * Generates the Decide → Laya evaluation set from the REAL engine code.
 *
 * Every payload here is built by the same `buildRequest()` the deployed app
 * sends to typesafe/jev, so whatever answers Laya gives were given to the
 * exact production wire format — same English enum sentences, same opt_N
 * aliases, same question set. Hand-written payloads would test nothing.
 *
 * Also embeds the on-device ranking for each scenario, so the runner can
 * report agreement without reimplementing the scorer in Python.
 *
 * Regenerate after engine changes:
 *   npx esbuild scripts/decide-eval/gen-payloads.ts --bundle --platform=node \
 *     --format=esm --outfile=node_modules/.cache/gen-payloads.mjs && \
 *   node node_modules/.cache/gen-payloads.mjs > scripts/decide-eval/payloads.json
 */
import {
  type Candidate,
  type DecisionState,
  type Tag,
  aliasMap,
  seedCandidate,
} from '../../src/decide/state'
import { buildRequest } from '../../src/decide/jev'
import { rankLocal } from '../../src/decide/suggest'

const cand = (
  key: string,
  tags: string[],
  over: Partial<Candidate> = {},
): Candidate => ({
  key,
  tags: tags as Tag[],
  daysSinceUsed: 5,
  timesUsed: 4,
  rating: null,
  available: true,
  ...over,
})

const base = (over: Partial<DecisionState>): DecisionState => ({
  domain: 'meal',
  slot: 'midday',
  dayType: 'work',
  context: { weather: 'warm', rain: 'dry' },
  historyCount: 60,
  recentTags: [],
  candidates: [],
  ...over,
})

// Legends are for the human reading the report — synthetic stand-ins shaped
// like a real Cambodian list. They are NOT sent to the model; only the keys'
// aliases and tag descriptions cross, exactly as in production.
interface Scenario {
  id: string
  title: string
  expectation: string
  state: DecisionState
  names: Record<string, string>
}

const mealList: [string, string, string[], Partial<Candidate>][] = [
  ['fried-fish', 'trei chien (fried fish)', ['fried', 'fish'], { daysSinceUsed: 4, timesUsed: 9, rating: 1 }],
  ['sour-soup', 'samlor machu (sour soup)', ['soup', 'sour', 'fish'], { daysSinceUsed: 9, timesUsed: 6 }],
  ['prahok', 'prahok ktis', ['meat', 'spicy', 'heavy'], { daysSinceUsed: 12, timesUsed: 3 }],
  ['fried-rice', 'bai cha (fried rice)', ['fried', 'rice'], { daysSinceUsed: 1, timesUsed: 14 }],
  ['num-banh-chok', 'num banh chok', ['noodle', 'fish', 'light'], { daysSinceUsed: 3, timesUsed: 8 }],
  ['grilled-chicken', 'moan ang (grilled chicken)', ['grill', 'meat'], { daysSinceUsed: 6, timesUsed: 5 }],
  ['kari', 'samlor kari (curry)', ['curry', 'meat', 'heavy'], { daysSinceUsed: 10, timesUsed: 4 }],
  ['salad', 'green salad', ['salad', 'veg', 'light'], { daysSinceUsed: 8, timesUsed: 2 }],
  ['porridge', 'borbor (rice porridge)', ['porridge', 'light'], { daysSinceUsed: 2, timesUsed: 7 }],
  ['street-noodles', 'street stall noodles', ['noodle', 'street'], { daysSinceUsed: 5, timesUsed: 5 }],
]

const meals = (over: Partial<Candidate> = {}) =>
  mealList.map(([k, , tags, o]) => cand(k, tags, { ...o, ...over }))
const mealNames = Object.fromEntries(mealList.map(([k, name]) => [k, name]))

const wardrobe: [string, string, string[], Partial<Candidate>][] = [
  ['tshirt', 'plain t-shirt', ['short-sleeve', 'casual', 'light'], { daysSinceUsed: 1, timesUsed: 15 }],
  ['work-shirt', 'office shirt', ['long-sleeve', 'formal'], { daysSinceUsed: 2, timesUsed: 12 }],
  ['sampot', 'sampot hol (traditional)', ['traditional'], { daysSinceUsed: 40, timesUsed: 2 }],
  ['rain-jacket', 'rain jacket', ['rain-proof'], { daysSinceUsed: 20, timesUsed: 3 }],
  ['riding-shirt', 'long-sleeve riding shirt', ['long-sleeve', 'sun-protective', 'casual'], { daysSinceUsed: 3, timesUsed: 8 }],
  ['shorts', 'shorts', ['shorts', 'casual', 'light'], { daysSinceUsed: 2, timesUsed: 10 }],
]
const outfits = () => wardrobe.map(([k, , tags, o]) => cand(k, tags, o))
const outfitNames = Object.fromEntries(wardrobe.map(([k, name]) => [k, name]))

const scenarios: Scenario[] = [
  {
    id: 'M1-hot-lunch',
    title: 'Meal · hot midday, full 10-item list',
    expectation: 'light/sour/salad up, curry and heavy down; fried rice punished (eaten yesterday)',
    state: base({ context: { weather: 'hot', rain: 'dry' }, candidates: meals() }),
    names: mealNames,
  },
  {
    id: 'M2-cool-breakfast',
    title: 'Meal · cool morning (breakfast)',
    expectation: 'porridge or noodle soup should top; heavy/grill buried',
    state: base({ slot: 'morning', context: { weather: 'cool', rain: 'dry' }, candidates: meals() }),
    names: mealNames,
  },
  {
    id: 'M3-rainy-dinner',
    title: 'Meal · rainy evening (dinner)',
    expectation: 'soup up, street stall down',
    state: base({ slot: 'evening', context: { weather: 'warm', rain: 'rain' }, candidates: meals() }),
    names: mealNames,
  },
  {
    id: 'M4-fried-fatigue',
    title: 'Meal · hot midday after a fried-heavy week',
    expectation: 'fried fish (otherwise a favourite) should lose to non-fried options',
    state: base({
      context: { weather: 'hot', rain: 'dry' },
      recentTags: ['fried', 'fried', 'fried', 'rice', 'fried'] as Tag[],
      candidates: meals(),
    }),
    names: mealNames,
  },
  {
    id: 'M5-untagged',
    title: 'Meal · five untagged items (worst case: only recency separates them)',
    expectation: 'low information; a good model should be near-uniform, not confidently wrong',
    state: base({
      historyCount: 0,
      candidates: [
        cand('u1', [], { daysSinceUsed: null, timesUsed: 0 }),
        cand('u2', [], { daysSinceUsed: 0, timesUsed: 1 }),
        cand('u3', [], { daysSinceUsed: null, timesUsed: 0 }),
        cand('u4', [], { daysSinceUsed: 14, timesUsed: 1 }),
        cand('u5', [], { daysSinceUsed: null, timesUsed: 0 }),
      ],
    }),
    names: { u1: 'mystery 1', u2: 'mystery 2 (today)', u3: 'mystery 3', u4: 'mystery 4 (2wk ago)', u5: 'mystery 5' },
  },
  {
    id: 'M6-coin-toss',
    title: 'Meal · two similar dishes, one eaten yesterday',
    expectation: 'the one NOT eaten yesterday should win clearly',
    state: base({
      candidates: [
        cand('a', ['fried', 'rice'], { daysSinceUsed: 1 }),
        cand('b', ['fried', 'rice'], { daysSinceUsed: 6 }),
      ],
    }),
    names: { a: 'fried rice A (yesterday)', b: 'fried rice B (6 days ago)' },
  },
  {
    id: 'O1-wedding',
    title: 'Outfit · wedding day',
    expectation: 'sampot hol must win despite being worn only twice ever',
    state: base({
      domain: 'outfit',
      context: { weather: 'warm', rain: 'dry', occasion: 'wedding' },
      candidates: outfits(),
    }),
    names: outfitNames,
  },
  {
    id: 'O2-hot-workday',
    title: 'Outfit · hot work day',
    expectation: 'office shirt or sun-cover shirt; shorts must not win a work day',
    state: base({
      domain: 'outfit',
      context: { weather: 'hot', rain: 'dry', occasion: 'work' },
      candidates: outfits(),
    }),
    names: outfitNames,
  },
  {
    id: 'O3-rainy-casual',
    title: 'Outfit · rainy casual day',
    expectation: 'rain jacket surges',
    state: base({
      domain: 'outfit',
      context: { weather: 'warm', rain: 'rain', occasion: 'casual' },
      candidates: outfits(),
    }),
    names: outfitNames,
  },
  {
    id: 'E1-tired-rainy',
    title: 'Exercise · tired, raining',
    expectation: 'gentle indoor stretching over intense outdoor run',
    state: base({
      domain: 'exercise',
      slot: 'evening',
      context: { weather: 'warm', rain: 'rain', energy: 'low' },
      candidates: [
        cand('run', ['run', 'outdoor', 'intense', 'legs'], { daysSinceUsed: 2, timesUsed: 10 }),
        cand('stretch', ['stretch', 'indoor', 'gentle'], { daysSinceUsed: 4, timesUsed: 5 }),
        cand('weights', ['strength', 'indoor', 'arms'], { daysSinceUsed: 1, timesUsed: 6 }),
      ],
    }),
    names: { run: 'park run', stretch: 'stretching', weights: 'weights (arms, yesterday)' },
  },
  {
    id: 'S1-tired-evening',
    title: 'Study · tired evening',
    expectation: 'easy vocabulary review over hard new grammar',
    state: base({
      domain: 'study',
      slot: 'evening',
      context: { energy: 'low' },
      candidates: [
        cand('vocab', ['vocabulary', 'review', 'easy'], { daysSinceUsed: 2, timesUsed: 12 }),
        cand('grammar', ['grammar', 'new', 'hard'], { daysSinceUsed: 6, timesUsed: 3 }),
        cand('writing', ['writing', 'practice', 'long'], { daysSinceUsed: 4, timesUsed: 5 }),
      ],
    }),
    names: { vocab: 'English vocabulary', grammar: 'new grammar unit', writing: 'essay practice' },
  },
  {
    id: 'S2-fresh-morning',
    title: 'Study · fresh morning on a work day',
    expectation: 'hard new material wins the morning; long sessions lose the work day',
    state: base({
      domain: 'study',
      slot: 'morning',
      context: { energy: 'high' },
      candidates: [
        cand('vocab', ['vocabulary', 'review', 'easy', 'short'], { daysSinceUsed: 1, timesUsed: 12 }),
        cand('grammar', ['grammar', 'new', 'hard', 'short'], { daysSinceUsed: 6, timesUsed: 3 }),
        cand('writing', ['writing', 'practice', 'long'], { daysSinceUsed: 4, timesUsed: 5 }),
      ],
    }),
    names: { vocab: 'English vocabulary', grammar: 'new grammar unit', writing: 'essay practice' },
  },
]

const out = scenarios.map((sc) => {
  const { toAlias } = aliasMap(sc.state.candidates)
  const device = rankLocal(sc.state)
    .filter((r) => toAlias.has(r.key))
    .map((r) => ({ alias: toAlias.get(r.key)!, score: r.score }))
  const legend = Object.fromEntries(
    [...toAlias.entries()].map(([key, alias]) => [alias, sc.names[key] ?? key]),
  )
  return {
    id: sc.id,
    title: sc.title,
    expectation: sc.expectation,
    options: sc.state.candidates.filter((c) => c.available).length,
    request: buildRequest(sc.state),
    device,
    legend,
  }
})

console.log(JSON.stringify({ generated: new Date().toISOString().slice(0, 10), scenarios: out }, null, 2))
