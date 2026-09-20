import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useI18n } from './i18n'
import { DecideView } from './views/DecideView'
import './styles.css'

/**
 * Standalone **Decide** page (served at /decide) — "what should I eat today?"
 * and "what should I wear today?".
 *
 * Answers come from the user's own habit log, scored on-device with plain
 * arithmetic. The page works with no network; when it is online AND the local
 * scorer is unsure, it asks /api/decide for a second opinion. See src/decide/.
 */
function DecideApp() {
  const { lang, setLang } = useI18n()
  const km = lang === 'km'
  return (
    <div className="voice-shell">
      <header className="voice-topbar">
        <div className="voice-brand">
          <span aria-hidden>🤔</span>
          <div>
            <h1>{km ? 'សម្រេចចិត្ត' : 'Decide'}</h1>
            <p>{km ? 'ញ៉ាំអ្វី · ស្លៀកអ្វី · ក្រៅបណ្តាញ' : 'What to eat · what to wear · offline'}</p>
          </div>
        </div>
        <button className="voice-lang" onClick={() => setLang(km ? 'en' : 'km')}>
          {km ? 'EN' : 'ខ្មែរ'}
        </button>
      </header>

      <main className="voice-main">
        <DecideView />
      </main>
    </div>
  )
}

createRoot(document.getElementById('decide-root')!).render(
  <StrictMode>
    <I18nProvider>
      <DecideApp />
    </I18nProvider>
  </StrictMode>,
)
