import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import {
  type Domain,
  type RainBucket,
  type ReasonCode,
  type Scored,
  type SeedFrequency,
  type Tag,
  type WeatherBucket,
  MEAL_TAGS,
  OUTFIT_TAGS,
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

/** Reason codes → readable text. Some differ by domain (eat vs wear). */
const REASONS: Record<ReasonCode, { km: string; en: string; kmWear?: string; enWear?: string }> = {
  overdue: { km: 'យូរហើយមិនបានញ៉ាំ', en: 'not had in a while', kmWear: 'យូរហើយមិនបានស្លៀក', enWear: 'not worn in a while' },
  'too-recent': { km: 'ទើបតែញ៉ាំថ្មីៗ', en: 'had it very recently', kmWear: 'ទើបតែស្លៀកថ្មីៗ', enWear: 'worn very recently' },
  'tag-fatigue': { km: 'ដដែលៗច្រើនថ្ងៃហើយ', en: 'too much of the same lately' },
  'weather-fit': { km: 'សមនឹងអាកាសធាតុ', en: 'suits the weather' },
  'weather-clash': { km: 'មិនសូវសមនឹងអាកាសធាតុ', en: 'against the weather' },
  'slot-fit': { km: 'សមនឹងពេលវេលា', en: 'suits the time of day' },
  'slot-clash': { km: 'មិនសមនឹងពេលវេលា', en: 'wrong time of day' },
  liked: { km: 'អ្នកចូលចិត្ត', en: 'you like it' },
  disliked: { km: 'អ្នកមិនសូវចូលចិត្ត', en: 'you dislike it' },
  favourite: { km: 'អ្នកញ៉ាំញឹកញាប់', en: 'a regular of yours', kmWear: 'អ្នកស្លៀកញឹកញាប់' },
  untried: { km: 'មិនទាន់បានសាក', en: 'not tried yet' },
  unavailable: { km: 'មិនមាន / កំពុងបោក', en: 'unavailable / in the wash' },
}

const TAG_TEXT: Partial<Record<Tag, { km: string; en: string }>> = {
  soup: { km: 'ស៊ុប', en: 'soup' },
  grill: { km: 'អាំង', en: 'grilled' },
  fried: { km: 'ឆា/បំពង', en: 'fried' },
  rice: { km: 'បាយ', en: 'rice' },
  noodle: { km: 'មី/គុយទាវ', en: 'noodles' },
  salad: { km: 'ញាំ/សាឡាត់', en: 'salad' },
  sweet: { km: 'ផ្អែម', en: 'sweet' },
  spicy: { km: 'ហឹរ', en: 'spicy' },
  light: { km: 'ស្រាល', en: 'light' },
  heavy: { km: 'ធ្ងន់', en: 'heavy' },
  'long-sleeve': { km: 'ដៃវែង', en: 'long sleeve' },
  'short-sleeve': { km: 'ដៃខ្លី', en: 'short sleeve' },
  'rain-proof': { km: 'ការពារភ្លៀង', en: 'rain-proof' },
  formal: { km: 'ផ្លូវការ', en: 'formal' },
  casual: { km: 'ធម្មតា', en: 'casual' },
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

  const [draftLabel, setDraftLabel] = useState('')
  const [draftTags, setDraftTags] = useState<Tag[]>([])
  const [draftFreq, setDraftFreq] = useState<SeedFrequency>('weekly')

  const wear = domain === 'outfit'
  const vocabulary = (wear ? OUTFIT_TAGS : MEAL_TAGS) as readonly Tag[]

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
    if (wear) return km ? (r.kmWear ?? r.km) : (r.enWear ?? r.en)
    return km ? r.km : r.en
  }

  const tagText = (t: Tag) => {
    const x = TAG_TEXT[t]
    return x ? (km ? x.km : x.en) : t
  }

  async function ask() {
    setBusy(true)
    setError('')
    try {
      const state = await buildState(domain, { weather, rain })
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
      setConfidence(ranked[0]?.confidence ?? 0)
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
        <button
          className={`decide-domain ${!wear ? 'is-on' : ''}`}
          onClick={() => setDomain('meal')}
        >
          <span aria-hidden>🍚</span> {km ? 'ញ៉ាំអ្វី?' : 'What to eat?'}
        </button>
        <button
          className={`decide-domain ${wear ? 'is-on' : ''}`}
          onClick={() => setDomain('outfit')}
        >
          <span aria-hidden>👕</span> {km ? 'ស្លៀកអ្វី?' : 'What to wear?'}
        </button>
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
            <div className="decide-env-group" role="group" aria-label={km ? 'ភ្លៀង' : 'Rain'}>
              {(['dry', 'showers', 'rain'] as RainBucket[]).map((r) => (
                <button key={r} className={rain === r ? 'is-on' : ''} onClick={() => setRain(r)}>
                  {r === 'dry' ? (km ? 'មិនភ្លៀង' : 'Dry') : r === 'showers' ? (km ? 'ភ្លៀងតិច' : 'Showers') : (km ? 'ភ្លៀង' : 'Rain')}
                </button>
              ))}
            </div>
          </div>

          <button className="decide-ask" onClick={() => void ask()} disabled={busy}>
            {busy
              ? (km ? 'កំពុងគិត…' : 'Thinking…')
              : wear
                ? (km ? 'ថ្ងៃនេះគួរស្លៀកអ្វី?' : 'What should I wear today?')
                : (km ? 'ថ្ងៃនេះគួរញ៉ាំអ្វី?' : 'What should I eat today?')}
          </button>

          {results?.length === 0 && (
            <p className="decide-empty">
              {km
                ? 'បន្ថែមម្ហូប ឬសម្លៀកបំពាក់ដែលអ្នកចូលចិត្តជាមុនសិន។'
                : 'Add a few favourites first — no waiting required.'}
            </p>
          )}

          {results && results.length > 0 && (
            <>
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
                      {wear ? (km ? 'ស្លៀកមួយនេះ' : 'Wore this') : (km ? 'ញ៉ាំមួយនេះ' : 'Ate this')}
                    </button>
                  </li>
                ))}
              </ol>

              <p className="decide-meta">
                {km ? 'ទំនុកចិត្ត' : 'Confidence'} {Math.round(confidence * 100)}% ·{' '}
                {km ? SOURCES[reason].km : SOURCES[reason].en}
                {status ? ` (${status})` : ''} · {entries} {km ? 'កំណត់ត្រា' : 'entries'}
              </p>
              {detail && <p className="decide-error">{detail}</p>}
              {remote && reason !== 'used' && (
                <p className="decide-meta">
                  Jev: conf {remote.confidence.toFixed(2)} · top {remote.top.toFixed(2)} ·{' '}
                  {remote.options} {km ? 'ជម្រើស' : 'options'} · lift{' '}
                  {(remote.top * remote.options).toFixed(2)}
                </p>
              )}
              {confidence < 0.6 && (
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
              placeholder={wear ? (km ? 'ឈ្មោះសម្លៀកបំពាក់' : 'Garment name') : (km ? 'ឈ្មោះម្ហូប' : 'Dish name')}
              aria-label={km ? 'ឈ្មោះ' : 'Name'}
            />
            <div className="decide-chips">
              {vocabulary.map((t) => (
                <button
                  key={t}
                  className={draftTags.includes(t) ? 'is-on' : ''}
                  onClick={() => toggleTag(t)}
                >
                  {tagText(t)}
                </button>
              ))}
            </div>
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
