import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import {
  type Domain,
  type EnergyBucket,
  type RainBucket,
  type ReasonCode,
  type Scored,
  type SeedFrequency,
  type Tag,
  type WeatherBucket,
  DOMAIN_CONTEXT,
  DOMAINS,
} from '../decide/state'
import {
  type ItemSummary,
  buildState,
  labelsFor,
  listItems,
  logCount,
  rateItem,
  recordEntry,
  removeItem,
  seedItem,
  setAvailable,
} from '../decide/habit'
import { type ScoreReason, JevScorer } from '../decide/jev'
import { localConfidence } from '../decide/suggest'

/**
 * How decisive the remote pick was, as lift over chance.
 *
 * Shown instead of the raw confidence because they answer different questions.
 * A 36% confidence over five close options is NOT "the app is unsure" — it is
 * "these are all reasonable", which is a useful answer, not a weak one.
 */
function decisiveness(top: number, options: number): { km: string; en: string } {
  const lift = top * options
  if (lift >= 2.5) return { km: 'ជម្រើសច្បាស់លាស់', en: 'clear winner' }
  if (lift >= 1.8) return { km: 'ល្អជាងគេបន្តិច', en: 'mild preference' }
  return { km: 'ប្រហាក់ប្រហែលគ្នា', en: 'close call — any of the top few work' }
}

/**
 * Decide (/decide) — "what should I eat today?" / "what should I wear today?"
 *
 * The Khmer lives here and only here. The engine deals in opaque ids and
 * `ReasonCode` enums; this view is what turns a code into a sentence a person
 * reads. That is what lets the remote scorer stay language-free.
 *
 * Every answer shows its breakdown. A number with no reasons is an oracle, and
 * an oracle can't be argued with — the same principle as Trace's compliance
 * report.
 */

type Tab = 'ask' | 'items'

type Phrase = { km: string; en: string }

/**
 * Reason codes → readable text.
 *
 * Several read differently per domain: "not had in a while" is right for food,
 * "needs recovery" for exercise and "due for review" for study. The engine only
 * ever emits the CODE, which is exactly what lets it stay language-free.
 */
const REASONS: Record<ReasonCode, Phrase & Partial<Record<Domain, Phrase>>> = {
  overdue: {
    km: 'យូរហើយមិនបានញ៉ាំ', en: 'not had in a while',
    outfit: { km: 'យូរហើយមិនបានស្លៀក', en: 'not worn in a while' },
    exercise: { km: 'យូរហើយមិនបានធ្វើ', en: 'not trained in a while' },
    study: { km: 'ដល់ពេលរំលឹកឡើងវិញ', en: 'due for review' },
  },
  'too-recent': {
    km: 'ទើបតែញ៉ាំថ្មីៗ', en: 'had it very recently',
    outfit: { km: 'ទើបតែស្លៀកថ្មីៗ', en: 'worn very recently' },
    exercise: { km: 'ទើបធ្វើ — ត្រូវសម្រាក', en: 'trained recently — needs recovery' },
    study: { km: 'ទើបតែរៀនរួច', en: 'just covered this' },
  },
  'tag-fatigue': { km: 'ដដែលៗច្រើនថ្ងៃហើយ', en: 'too much of the same lately' },
  'weather-fit': { km: 'សមនឹងអាកាសធាតុ', en: 'suits the weather' },
  'weather-clash': { km: 'មិនសូវសមនឹងអាកាសធាតុ', en: 'against the weather' },
  'energy-fit': { km: 'សមនឹងកម្លាំងឥឡូវ', en: 'matches your energy' },
  'energy-clash': { km: 'ធ្ងន់ពេកសម្រាប់ឥឡូវ', en: 'too demanding right now' },
  'slot-fit': { km: 'សមនឹងពេលវេលា', en: 'suits the time of day' },
  'slot-clash': { km: 'មិនសមនឹងពេលវេលា', en: 'wrong time of day' },
  liked: { km: 'អ្នកចូលចិត្ត', en: 'you like it' },
  disliked: { km: 'អ្នកមិនសូវចូលចិត្ត', en: 'you dislike it' },
  favourite: {
    km: 'អ្នកញ៉ាំញឹកញាប់', en: 'a regular of yours',
    outfit: { km: 'អ្នកស្លៀកញឹកញាប់', en: 'a regular of yours' },
  },
  untried: { km: 'មិនទាន់បានសាក', en: 'not tried yet' },
  unavailable: {
    km: 'មិនមាន', en: 'unavailable',
    outfit: { km: 'កំពុងបោក', en: 'in the wash' },
  },
}

/** Per-domain wording for the buttons and headings. */
const DOMAIN_UI: Record<Domain, { icon: string; km: string; en: string; askKm: string; askEn: string; didKm: string; didEn: string; nameKm: string; nameEn: string }> = {
  meal: {
    icon: '🍚', km: 'ញ៉ាំអ្វី?', en: 'What to eat?',
    askKm: 'ថ្ងៃនេះគួរញ៉ាំអ្វី?', askEn: 'What should I eat today?',
    didKm: 'ញ៉ាំមួយនេះ', didEn: 'Ate this', nameKm: 'ឈ្មោះម្ហូប', nameEn: 'Dish name',
  },
  outfit: {
    icon: '👕', km: 'ស្លៀកអ្វី?', en: 'What to wear?',
    askKm: 'ថ្ងៃនេះគួរស្លៀកអ្វី?', askEn: 'What should I wear today?',
    didKm: 'ស្លៀកមួយនេះ', didEn: 'Wore this', nameKm: 'ឈ្មោះសម្លៀកបំពាក់', nameEn: 'Garment name',
  },
  exercise: {
    icon: '🏃', km: 'ហាត់ប្រាណអ្វី?', en: 'What to train?',
    askKm: 'ថ្ងៃនេះគួរហាត់អ្វី?', askEn: 'What should I train today?',
    didKm: 'បានធ្វើ', didEn: 'Did this', nameKm: 'ឈ្មោះលំហាត់', nameEn: 'Activity name',
  },
  study: {
    icon: '📚', km: 'រៀនអ្វី?', en: 'What to study?',
    askKm: 'ឥឡូវគួររៀនអ្វី?', askEn: 'What should I study now?',
    didKm: 'បានរៀន', didEn: 'Studied this', nameKm: 'ប្រធានបទ', nameEn: 'Topic name',
  },
}

const TAG_TEXT: Partial<Record<Tag, { km: string; en: string }>> = {
  soup: { km: 'ស៊ុប', en: 'soup' },
  porridge: { km: 'បបរ', en: 'porridge' },
  rice: { km: 'បាយ', en: 'rice' },
  noodle: { km: 'មី/គុយទាវ', en: 'noodles' },
  grill: { km: 'អាំង', en: 'grilled' },
  fried: { km: 'ឆា/បំពង', en: 'fried' },
  steamed: { km: 'ចំហុយ', en: 'steamed' },
  curry: { km: 'ការី', en: 'curry' },
  salad: { km: 'ញាំ/សាឡាត់', en: 'salad' },
  fish: { km: 'ត្រី', en: 'fish' },
  meat: { km: 'សាច់', en: 'meat' },
  egg: { km: 'ពង', en: 'egg' },
  veg: { km: 'បន្លែ', en: 'vegetables' },
  spicy: { km: 'ហឹរ', en: 'spicy' },
  sour: { km: 'ជូរ', en: 'sour' },
  sweet: { km: 'ផ្អែម', en: 'sweet' },
  fruit: { km: 'ផ្លែឈើ', en: 'fruit' },
  light: { km: 'ស្រាល', en: 'light' },
  heavy: { km: 'ធ្ងន់', en: 'heavy' },
  street: { km: 'តាមផ្លូវ', en: 'street food' },
  'long-sleeve': { km: 'ដៃវែង', en: 'long sleeve' },
  'short-sleeve': { km: 'ដៃខ្លី', en: 'short sleeve' },
  shorts: { km: 'ខោខ្លី', en: 'shorts' },
  formal: { km: 'ផ្លូវការ', en: 'formal' },
  casual: { km: 'ធម្មតា', en: 'casual' },
  traditional: { km: 'ប្រពៃណី', en: 'traditional' },
  'rain-proof': { km: 'ការពារភ្លៀង', en: 'rain-proof' },
  'sun-protective': { km: 'ការពារកំដៅថ្ងៃ', en: 'sun cover' },
  walk: { km: 'ដើរ', en: 'walk' },
  run: { km: 'រត់', en: 'run' },
  cycle: { km: 'ជិះកង់', en: 'cycling' },
  swim: { km: 'ហែលទឹក', en: 'swim' },
  strength: { km: 'លើកទម្ងន់', en: 'strength' },
  stretch: { km: 'ទាញសាច់ដុំ', en: 'stretching' },
  sport: { km: 'កីឡា', en: 'sport' },
  legs: { km: 'ជើង', en: 'legs' },
  arms: { km: 'ដៃ', en: 'arms' },
  core: { km: 'ពោះ/ចង្កេះ', en: 'core' },
  'full-body': { km: 'ទាំងខ្លួន', en: 'full body' },
  gentle: { km: 'ស្រាលៗ', en: 'gentle' },
  intense: { km: 'ខ្លាំង', en: 'intense' },
  short: { km: 'ខ្លី', en: 'short' },
  long: { km: 'វែង', en: 'long' },
  indoor: { km: 'ក្នុងផ្ទះ', en: 'indoor' },
  outdoor: { km: 'ក្រៅផ្ទះ', en: 'outdoor' },
  reading: { km: 'អាន', en: 'reading' },
  writing: { km: 'សរសេរ', en: 'writing' },
  listening: { km: 'ស្តាប់', en: 'listening' },
  speaking: { km: 'និយាយ', en: 'speaking' },
  vocabulary: { km: 'វាក្យសព្ទ', en: 'vocabulary' },
  grammar: { km: 'វេយ្យាករណ៍', en: 'grammar' },
  math: { km: 'គណិត', en: 'maths' },
  practice: { km: 'អនុវត្ត', en: 'practice' },
  new: { km: 'មេរៀនថ្មី', en: 'new material' },
  review: { km: 'រំលឹក', en: 'review' },
  easy: { km: 'ងាយ', en: 'easy' },
  hard: { km: 'ពិបាក', en: 'hard' },
}

/**
 * Tags grouped for the picker. Twenty chips in one flat row is a wall; grouped
 * they read as a few small decisions, which is what they are.
 */
const TAG_GROUPS: Record<Domain, { km: string; en: string; tags: Tag[] }[]> = {
  meal: [
    { km: 'ប្រភេទ', en: 'Kind', tags: ['soup', 'porridge', 'rice', 'noodle', 'grill', 'fried', 'steamed', 'curry', 'salad'] },
    { km: 'សាច់ / បន្លែ', en: 'Main', tags: ['fish', 'meat', 'egg', 'veg'] },
    { km: 'រសជាតិ', en: 'Character', tags: ['spicy', 'sour', 'sweet', 'fruit', 'light', 'heavy'] },
    { km: 'ទីកន្លែង', en: 'Where', tags: ['street'] },
  ],
  outfit: [
    { km: 'បែប', en: 'Cut', tags: ['long-sleeve', 'short-sleeve', 'shorts'] },
    { km: 'រចនាបថ', en: 'Style', tags: ['formal', 'casual', 'traditional'] },
    { km: 'អាកាសធាតុ', en: 'Weather', tags: ['rain-proof', 'sun-protective', 'light', 'heavy'] },
  ],
  exercise: [
    { km: 'ប្រភេទ', en: 'Kind', tags: ['walk', 'run', 'cycle', 'swim', 'strength', 'stretch', 'sport'] },
    // Recovery is per body area, so this is the rotation axis that matters.
    { km: 'ផ្នែករាងកាយ', en: 'Works', tags: ['legs', 'arms', 'core', 'full-body'] },
    { km: 'កម្រិត', en: 'Effort', tags: ['gentle', 'intense', 'short', 'long'] },
    { km: 'ទីកន្លែង', en: 'Where', tags: ['indoor', 'outdoor'] },
  ],
  study: [
    { km: 'ជំនាញ', en: 'Skill', tags: ['reading', 'writing', 'listening', 'speaking', 'vocabulary', 'grammar', 'math', 'practice'] },
    { km: 'បែបមេរៀន', en: 'Session', tags: ['new', 'review', 'practice', 'short', 'long', 'easy', 'hard'] },
  ],
}

/** Where the answer came from, and why — so a broken binding is visible. */
const SOURCES: Record<ScoreReason, { km: string; en: string }> = {
  used: { km: 'ពិគ្រោះនឹង Jev លើបណ្តាញ', en: 'checked online with Jev' },
  'not-needed': { km: 'លើឧបករណ៍ · ច្បាស់ណាស់ មិនចាំបាច់សួរ', en: 'on-device · confident, no call needed' },
  'single-option': { km: 'លើឧបករណ៍ · មានជម្រើសតែមួយ', en: 'on-device · only one option' },
  unreachable: { km: 'លើឧបករណ៍ · ទៅមិនដល់ម៉ាស៊ីនមេ', en: 'on-device · server unreachable' },
  'server-error': { km: 'លើឧបករណ៍ · ម៉ាស៊ីនមេមានបញ្ហា', en: 'on-device · server error' },
  'low-confidence': { km: 'លើឧបករណ៍ · ចម្លើយបណ្តាញមិនច្បាស់', en: 'on-device · online answer unclear' },
}

const FREQUENCIES: { value: SeedFrequency; km: string; en: string }[] = [
  { value: 'daily', km: 'ស្ទើរតែរាល់ថ្ងៃ', en: 'most days' },
  { value: 'weekly', km: 'ប្រចាំសប្តាហ៍', en: 'most weeks' },
  { value: 'sometimes', km: 'ម្តងម្កាល', en: 'now and then' },
  { value: 'rare', km: 'កម្រណាស់', en: 'rarely' },
]

export function DecideView() {
  const { lang } = useI18n()
  const km = lang === 'km'

  const [domain, setDomain] = useState<Domain>('meal')
  const [tab, setTab] = useState<Tab>('ask')
  const [items, setItems] = useState<ItemSummary[]>([])
  const [entries, setEntries] = useState(0)
  const [results, setResults] = useState<Scored[] | null>(null)
  const [labels, setLabels] = useState<Map<string, string>>(new Map())
  const [reason, setReason] = useState<ScoreReason>('not-needed')
  const [status, setStatus] = useState(0)
  const [detail, setDetail] = useState('')
  const [remote, setRemote] = useState<{ confidence: number; top: number; options: number } | null>(null)
  const [confidence, setConfidence] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [weather, setWeather] = useState<WeatherBucket>('warm')
  const [rain, setRain] = useState<RainBucket>('dry')
  const [energy, setEnergy] = useState<EnergyBucket>('normal')

  const [draftLabel, setDraftLabel] = useState('')
  const [draftTags, setDraftTags] = useState<Tag[]>([])
  const [draftFreq, setDraftFreq] = useState<SeedFrequency>('weekly')

  const wear = domain === 'outfit'
  const groups = TAG_GROUPS[domain]
  const ui = DOMAIN_UI[domain]
  const dims = DOMAIN_CONTEXT[domain]

  const refresh = useCallback(async () => {
    try {
      const [list, n] = await Promise.all([listItems(domain), logCount(domain)])
      setItems(list)
      setEntries(n)
    } catch (err) {
      setError(String(err))
    }
  }, [domain])

  useEffect(() => {
    setResults(null)
    void refresh()
  }, [refresh])

  const reasonText = (code: ReasonCode) => {
    const r = REASONS[code]
    if (!r) return code
    const p: Phrase = r[domain] ?? r
    return km ? p.km : p.en
  }

  const tagText = (t: Tag) => {
    const x = TAG_TEXT[t]
    return x ? (km ? x.km : x.en) : t
  }

  async function ask() {
    setBusy(true)
    setError('')
    try {
      const state = await buildState(domain, { weather, rain, energy })
      if (state.candidates.length === 0) {
        setResults([])
        setTab('items')
        return
      }
      const scorer = new JevScorer()
      const ranked = await scorer.rank(state)
      setResults(ranked)
      setReason(scorer.lastReason)
      setStatus(scorer.lastStatus)
      setDetail(scorer.lastDetail)
      setRemote(scorer.lastRemote)
      // Whichever scorer answered, this is ITS confidence — the source is
      // printed next to it, so the number is never unlabelled.
      setConfidence(ranked[0]?.confidence ?? localConfidence(state))
      setLabels(await labelsFor(ranked.map((r) => r.key)))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function chose(itemId: string) {
    await recordEntry(domain, itemId)
    // Wearing something takes it out of rotation until laundry day. Eating
    // something does not — the recency rule handles meals on its own.
    if (wear) await setAvailable(itemId, false)
    setResults(null)
    await refresh()
  }

  async function addItem() {
    const label = draftLabel.trim()
    if (!label) return
    await seedItem(domain, label, draftTags, draftFreq)
    setDraftLabel('')
    setDraftTags([])
    await refresh()
  }

  const toggleTag = (t: Tag) =>
    setDraftTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))

  return (
    <div className="decide">
      <div className="decide-domains">
        {DOMAINS.map((d) => (
          <button
            key={d}
            className={`decide-domain ${domain === d ? 'is-on' : ''}`}
            onClick={() => setDomain(d)}
          >
            <span aria-hidden>{DOMAIN_UI[d].icon}</span>{' '}
            {km ? DOMAIN_UI[d].km : DOMAIN_UI[d].en}
          </button>
        ))}
      </div>

      <div className="decide-tabs">
        <button className={tab === 'ask' ? 'is-on' : ''} onClick={() => setTab('ask')}>
          {km ? 'សួរ' : 'Ask'}
        </button>
        <button className={tab === 'items' ? 'is-on' : ''} onClick={() => setTab('items')}>
          {km ? 'បញ្ជីរបស់ខ្ញុំ' : 'My list'} ({items.length})
        </button>
      </div>

      {error && <p className="decide-error">{error}</p>}

      {tab === 'ask' && (
        <section className="decide-panel">
          <div className="decide-env">
            {dims.includes('weather') && (
              <div className="decide-env-group" role="group" aria-label={km ? 'អាកាសធាតុ' : 'Weather'}>
                {(['cool', 'warm', 'hot'] as WeatherBucket[]).map((w) => (
                  <button
                    key={w}
                    className={weather === w ? 'is-on' : ''}
                    onClick={() => setWeather(w)}
                  >
                    {w === 'cool' ? (km ? 'ត្រជាក់' : 'Cool') : w === 'warm' ? (km ? 'ធម្មតា' : 'Warm') : (km ? 'ក្តៅ' : 'Hot')}
                  </button>
                ))}
              </div>
            )}
            {dims.includes('rain') && (
              <div className="decide-env-group" role="group" aria-label={km ? 'ភ្លៀង' : 'Rain'}>
                {(['dry', 'showers', 'rain'] as RainBucket[]).map((r) => (
                  <button key={r} className={rain === r ? 'is-on' : ''} onClick={() => setRain(r)}>
                    {r === 'dry' ? (km ? 'មិនភ្លៀង' : 'Dry') : r === 'showers' ? (km ? 'ភ្លៀងតិច' : 'Showers') : (km ? 'ភ្លៀង' : 'Rain')}
                  </button>
                ))}
              </div>
            )}
            {dims.includes('energy') && (
              <div className="decide-env-group" role="group" aria-label={km ? 'កម្លាំង' : 'Energy'}>
                {(['low', 'normal', 'high'] as EnergyBucket[]).map((e) => (
                  <button key={e} className={energy === e ? 'is-on' : ''} onClick={() => setEnergy(e)}>
                    {e === 'low' ? (km ? 'ហត់' : 'Tired') : e === 'normal' ? (km ? 'ធម្មតា' : 'Normal') : (km ? 'ស្វាហាប់' : 'Fresh')}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="decide-ask" onClick={() => void ask()} disabled={busy}>
            {busy ? (km ? 'កំពុងគិត…' : 'Thinking…') : (km ? ui.askKm : ui.askEn)}
          </button>

          {results?.length === 0 && (
            <p className="decide-empty">
              {km
                ? 'បន្ថែមអ្វីដែលអ្នកធ្វើជាប្រចាំជាមុនសិន។'
                : 'Add a few of your usual choices first — no waiting required.'}
            </p>
          )}

          {results && results.length > 0 && (
            <>
              <p className="decide-status">
                {km ? 'ទំនុកចិត្ត' : 'Confidence'} {Math.round(confidence * 100)}% ·{' '}
                {km ? SOURCES[reason].km : SOURCES[reason].en}
                {status ? ` (${status})` : ''} · {entries} {km ? 'កំណត់ត្រា' : 'entries'}
              </p>
              {detail && <p className="decide-error">{detail}</p>}
              {remote && (
                <p className="decide-meta">
                  Jev · {km
                    ? decisiveness(remote.top, remote.options).km
                    : decisiveness(remote.top, remote.options).en}{' '}
                  · {remote.options} {km ? 'ជម្រើស' : 'options'} · top {remote.top.toFixed(2)} ·
                  lift {(remote.top * remote.options).toFixed(2)}
                </p>
              )}

              <ol className="decide-results">
                {results.map((r, i) => (
                  <li key={r.key} className={i === 0 ? 'is-top' : ''}>
                    <div className="decide-row">
                      <span className="decide-label">{labels.get(r.key) ?? r.key}</span>
                      <span className="decide-score">{Math.round(r.score * 100)}</span>
                    </div>
                    <div className="decide-bar">
                      <i style={{ width: `${Math.round(r.score * 100)}%` }} />
                    </div>
                    <ul className="decide-reasons">
                      {r.reasons.map((reason, j) => (
                        <li key={j} className={reason.delta >= 0 ? 'is-up' : 'is-down'}>
                          {reason.delta >= 0 ? '▲' : '▼'} {reasonText(reason.code)}
                        </li>
                      ))}
                    </ul>
                    <button className="decide-chose" onClick={() => void chose(r.key)}>
                      {km ? ui.didKm : ui.didEn}
                    </button>
                  </li>
                ))}
              </ol>

              {entries < 35 && (
                <p className="decide-hint">
                  {km
                    ? 'កត់ត្រាបន្តិចទៀត នោះការណែនាំនឹងកាន់តែត្រឹមត្រូវ។'
                    : 'Keep logging — the suggestion sharpens as your history grows.'}
                </p>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'items' && (
        <section className="decide-panel">
          <div className="decide-add">
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder={km ? ui.nameKm : ui.nameEn}
              aria-label={km ? 'ឈ្មោះ' : 'Name'}
            />
            {groups.map((g) => (
              <div key={g.en} className="decide-group">
                <span className="decide-group-label">{km ? g.km : g.en}</span>
                <div className="decide-chips">
                  {g.tags.map((t) => (
                    <button
                      key={t}
                      className={draftTags.includes(t) ? 'is-on' : ''}
                      onClick={() => toggleTag(t)}
                    >
                      {tagText(t)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="decide-chips">
              {FREQUENCIES.map((f) => (
                <button
                  key={f.value}
                  className={draftFreq === f.value ? 'is-on' : ''}
                  onClick={() => setDraftFreq(f.value)}
                >
                  {km ? f.km : f.en}
                </button>
              ))}
            </div>
            <button className="decide-ask" onClick={() => void addItem()} disabled={!draftLabel.trim()}>
              {km ? 'បន្ថែម' : 'Add'}
            </button>
          </div>

          <ul className="decide-items">
            {items.map((it) => (
              <li key={it.id}>
                <div className="decide-row">
                  <span className="decide-label">{it.label}</span>
                  <span className="decide-count">
                    {it.timesUsed}× {!it.available && (km ? '· កំពុងបោក' : '· in wash')}
                  </span>
                </div>
                <p className="decide-itemtags">{it.tags.map(tagText).join(' · ') || '—'}</p>
                <div className="decide-itemactions">
                  <button onClick={() => void rateItem(it.id, 1).then(refresh)}>👍</button>
                  <button onClick={() => void rateItem(it.id, -1).then(refresh)}>👎</button>
                  {wear && (
                    <button onClick={() => void setAvailable(it.id, !it.available).then(refresh)}>
                      {it.available ? (km ? 'ដាក់បោក' : 'To wash') : (km ? 'ស្អាតហើយ' : 'Clean')}
                    </button>
                  )}
                  <button onClick={() => void removeItem(it.id).then(refresh)}>
                    {km ? 'លុប' : 'Remove'}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {items.length === 0 && (
            <p className="decide-empty">
              {km
                ? 'សរសេរអ្វីដែលអ្នកញ៉ាំ ឬស្លៀកជាប្រចាំ ហើយប្រាប់ថាញឹកញាប់ប៉ុណ្ណា។'
                : 'List what you already eat or wear, and how often. That is enough to start.'}
            </p>
          )}
        </section>
      )}
    </div>
  )
}
