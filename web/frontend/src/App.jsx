import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createContributor,
  getChallenge,
  getContributor,
  getLeaderboard,
  getSession,
  uploadRecording,
} from './api'

const languages = [
  { id: 'fon', name: 'Fon' },
  { id: 'goun', name: 'Goun' },
  { id: 'yoruba', name: 'Yoruba' },
]

const SESSION_COUNT = 6
const PHRASES_PER_SESSION = 5
const POINTS_PER_CONTRIBUTION = 100

function App() {
  const [page, setPage] = useState('welcome')

  const [language, setLanguage] = useState('')
  const [assistId, setAssistId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [profile, setProfile] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [challenge, setChallenge] = useState(null)

  const [session, setSession] = useState(null)
  const [sessionIndex, setSessionIndex] = useState(0)
  const [phraseIndex, setPhraseIndex] = useState(0)

  const [recordingState, setRecordingState] = useState('ready')
  const [recordingUrl, setRecordingUrl] = useState('')
  const [recordingBlob, setRecordingBlob] = useState(null)
  const [seconds, setSeconds] = useState(0)

  const [loading, setLoading] = useState(true)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [showCelebration, setShowCelebration] = useState(false)
  const [celebrationChallenge, setCelebrationChallenge] =
    useState(null)

  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const celebrationTimerRef = useRef(null)
  const chunksRef = useRef([])

  const selectedLanguage = useMemo(
    () =>
      languages.find((item) => item.id === language),
    [language],
  )

  const currentPhrase =
    session?.phrases?.[phraseIndex] || null

  const progress = currentPhrase
    ? ((phraseIndex + 1) / PHRASES_PER_SESSION) * 100
    : 0

  useEffect(() => {
    bootstrap()
  }, [])

  useEffect(() => {
    return () => {
      stopStream()

      if (timerRef.current) {
        window.clearInterval(timerRef.current)
      }

      if (celebrationTimerRef.current) {
        window.clearTimeout(celebrationTimerRef.current)
      }

      if (recordingUrl) {
        URL.revokeObjectURL(recordingUrl)
      }
    }
  }, [recordingUrl])

  async function bootstrap() {
    setLoading(true)
    setError('')

    try {
      let contributorId =
        window.localStorage.getItem(
          'medassist_backend_assist_id',
        )

      let clientId =
        window.localStorage.getItem(
          'medassist_client_id',
        )

      if (!clientId) {
        clientId = crypto.randomUUID()

        window.localStorage.setItem(
          'medassist_client_id',
          clientId,
        )
      }

      let contributor = null

      if (contributorId) {
        try {
          contributor =
            await getContributor(contributorId)
        } catch {
          window.localStorage.removeItem(
            'medassist_backend_assist_id',
          )

          contributorId = null
        }
      }

      if (!contributor) {
        contributor = await createContributor(
          clientId,
        )

        contributorId = contributor.assist_id

        window.localStorage.setItem(
          'medassist_backend_assist_id',
          contributorId,
        )
      }

      if (!contributor.access_token) {
        contributor = await createContributor(
          clientId,
        )

        contributorId = contributor.assist_id

        window.localStorage.setItem(
          'medassist_backend_assist_id',
          contributorId,
        )
      }

      const token =
        contributor.access_token || ''

      if (!token) {
        throw new Error(
          "Le serveur n'a pas fourni de jeton d'authentification.",
        )
      }

      setAssistId(contributorId)
      setAccessToken(token)
      setProfile(contributor)

      await refreshRanking(contributorId)
    } catch (err) {
      console.error(err)
      setError(
        `Impossible de joindre le serveur : ${err.message}`,
      )
    } finally {
      setLoading(false)
    }
  }

  async function refreshRanking(currentAssistId = assistId) {
    if (!currentAssistId) {
      return
    }

    const [board, currentChallenge, contributor] =
      await Promise.all([
        getLeaderboard(),
        getChallenge(currentAssistId),
        getContributor(currentAssistId),
      ])

    setLeaderboard(board.items || [])
    setChallenge(currentChallenge)
    setProfile(contributor)
  }

  async function loadSession(
    selectedLanguageId,
    selectedSessionIndex,
  ) {
    setSessionLoading(true)
    setError('')

    try {
      const data = await getSession(
        selectedLanguageId,
        selectedSessionIndex + 1,
      )

      setSession(data)
      setPhraseIndex(0)
    } catch (err) {
      console.error(err)
      setError(
        `Impossible de charger cette session : ${err.message}`,
      )
    } finally {
      setSessionLoading(false)
    }
  }

  function stopStream() {
    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((track) => track.stop())

      streamRef.current = null
    }
  }

  function clearRecordingUrl() {
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl)
      setRecordingUrl('')
    }
  }

  function resetRecorder() {
    if (
      recorderRef.current &&
      recorderRef.current.state === 'recording'
    ) {
      recorderRef.current.stop()
    }

    stopStream()

    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }

    clearRecordingUrl()

    chunksRef.current = []
    setRecordingBlob(null)
    setSeconds(0)
    setRecordingState('ready')
  }

  async function startRecording() {
    setError('')

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "L'enregistrement audio n'est pas disponible.",
        )
      }

      if (!currentPhrase) {
        return
      }

      clearRecordingUrl()
      setRecordingBlob(null)
      setSeconds(0)
      chunksRef.current = []

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        })

      streamRef.current = stream

      const recorder = new MediaRecorder(stream)

      recorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType,
        })

        const url = URL.createObjectURL(blob)

        setRecordingBlob(blob)
        setRecordingUrl(url)
        setRecordingState('review')

        stopStream()

        if (timerRef.current) {
          window.clearInterval(timerRef.current)
          timerRef.current = null
        }
      }

      recorder.start()

      setRecordingState('recording')

      timerRef.current = window.setInterval(() => {
        setSeconds((value) => value + 1)
      }, 1000)
    } catch (err) {
      console.error(err)
      setRecordingState('ready')
      setError(err.message)
    }
  }

  function stopRecording() {
    if (
      recorderRef.current &&
      recorderRef.current.state === 'recording'
    ) {
      recorderRef.current.stop()
    }
  }

  async function validateRecording() {
    if (
      !recordingBlob ||
      !currentPhrase ||
      !selectedLanguage ||
      !assistId ||
      submitting
    ) {
      return
    }

    setSubmitting(true)
    setError('')

    try {
      const result = await uploadRecording({
        assistId,
        language: selectedLanguage.id,
        symptomId: currentPhrase.id,
        blob: recordingBlob,
        accessToken,
      })

      await refreshRanking(assistId)

      resetRecorder()

      const isLastPhrase =
        phraseIndex === PHRASES_PER_SESSION - 1

      if (!isLastPhrase) {
        setPhraseIndex((value) => value + 1)
        return
      }

      const freshChallenge =
        await getChallenge(assistId)

      setCelebrationChallenge(freshChallenge)
      setShowCelebration(true)

      celebrationTimerRef.current =
        window.setTimeout(() => {
          setShowCelebration(false)
          setPage('sessionComplete')
        }, 2800)

      console.log(
        'Contribution enregistrée:',
        result,
      )
    } catch (err) {
      console.error(err)
      setError(
        `La contribution n'a pas pu être enregistrée : ${err.message}`,
      )
    } finally {
      setSubmitting(false)
    }
  }

  function chooseLanguage(id) {
    resetRecorder()
    setError('')
    setLanguage(id)
  }

  async function startCollection() {
    if (!language) {
      setPage('language')
      return
    }

    setSessionIndex(0)
    setPhraseIndex(0)
    resetRecorder()

    await loadSession(language, 0)

    setPage('recording')
  }

  async function continueSession() {
    if (sessionIndex >= SESSION_COUNT - 1) {
      setPage('complete')
      return
    }

    const nextIndex = sessionIndex + 1

    setSessionIndex(nextIndex)
    setPhraseIndex(0)
    resetRecorder()

    await loadSession(language, nextIndex)

    setPage('recording')
  }

  async function changeLanguage() {
    resetRecorder()
    setSession(null)
    setPhraseIndex(0)
    setSessionIndex(0)
    setPage('language')
  }

  const formatTime = (value) => {
    const minutes = Math.floor(value / 60)
      .toString()
      .padStart(2, '0')

    const secs = (value % 60)
      .toString()
      .padStart(2, '0')

    return `${minutes}:${secs}`
  }

  const ranking =
    challenge?.rank ||
    profile?.ranking ||
    null

  const pointsToNext =
    challenge?.points_to_next || 0

  const contributionsToNext =
    challenge?.contributions_to_next || 0

  const targetAssist =
    challenge?.target_assist_id || null

  return (
    <div className="app">
      {showCelebration && (
        <div className="celebration-overlay">
          <div className="confetti-field" aria-hidden="true">
            {Array.from({ length: 38 }, (_, index) => (
              <span
                key={index}
                className={`confetti confetti-${index % 3}`}
                style={{
                  left: `${(index * 31) % 100}%`,
                  animationDelay: `${(index % 9) * -0.11}s`,
                  animationDuration: `${
                    1.8 + (index % 5) * 0.18
                  }s`,
                }}
              />
            ))}
          </div>

          <div className="celebration-modal">
            <div className="celebration-check">
              ✓
            </div>

            <span className="celebration-kicker">
              SESSION TERMINÉE
            </span>

            <h2>Félicitations !</h2>

            <p>
              Tu viens de terminer tes 5 contributions.
            </p>

            <div className="celebration-score">
              <strong>
                +{PHRASES_PER_SESSION * POINTS_PER_CONTRIBUTION}
              </strong>

              <span>points gagnés</span>
            </div>

            {celebrationChallenge?.leader ? (
              <div className="celebration-message">
                Tu es maintenant en tête du classement. 🔥
              </div>
            ) : targetAssist ? (
              <div className="celebration-message">
                Encore {pointsToNext} pts (
                {contributionsToNext} contributions)
                pour dépasser {targetAssist}.
                <br />
                Courage, tu y es presque !
              </div>
            ) : null}
          </div>
        </div>
      )}

      {loading && (
        <div className="loading-screen">
          <div className="loading-mark">+</div>
          <strong>MedAssist</strong>
          <span>Préparation de votre espace...</span>
        </div>
      )}

      <header className="header">
        <button
          type="button"
          className="logo"
          onClick={() => setPage('welcome')}
        >
          <span className="logo-mark">+</span>

          <span>
            <strong>MedAssist</strong>
            <small>Language Voices</small>
          </span>
        </button>

        {assistId && (
          <div className="header-profile">
            <span>{assistId}</span>

            <strong>
              {profile?.points || 0} pts
            </strong>
          </div>
        )}
      </header>

      {error && (
        <div className="global-error">
          <span>!</span>
          {error}
          <button
            type="button"
            onClick={() => setError('')}
          >
            ×
          </button>
        </div>
      )}

      {page === 'welcome' && !loading && (
        <main className="welcome-page">
          <section className="welcome-hero">
            <div className="hero-image" />
            <div className="hero-overlay" />

            <div className="hero-content">
              <span className="hero-kicker">
                MEDASSIST · LANGUES LOCALES
              </span>

              <h1>
                Votre voix
                <br />
                <span>compte vraiment.</span>
              </h1>

              <p>
                Chaque voix enregistrée aide MedAssist à mieux
                comprendre les langues que nous parlons chaque jour.
              </p>

              <button
                type="button"
                className="start-button"
                onClick={() => setPage('language')}
              >
                Commencer à contribuer
                <span>→</span>
              </button>

              <div className="hero-note">
                <span>🎙</span>
                Vous pouvez avancer à votre rythme.
              </div>

              <div className="hero-profile">
                <div className="hero-profile-avatar">
                  {assistId.replace('Assist-', '')}
                </div>

                <div>
                  <span>VOTRE PROFIL</span>
                  <strong>{assistId}</strong>
                </div>

                <div className="hero-profile-stats">
                  <strong>{profile?.points || 0}</strong>
                  <span>points</span>
                </div>

                <div className="hero-profile-stats">
                  <strong>
                    {profile?.contributions || 0}
                  </strong>
                  <span>contributions</span>
                </div>
              </div>
            </div>
          </section>

          <section className="home-grid">
            <div className="impact-card">
              <div className="card-topline">
                <span className="section-label">
                  VOTRE IMPACT
                </span>

                <span className="tiny-pill">
                  {assistId}
                </span>
              </div>

              <div className="impact-number">
                {profile?.contributions || 0}
              </div>

              <p>contributions vocales</p>

              <div className="impact-stats">
                <div>
                  <strong>
                    {profile?.points || 0}
                  </strong>
                  <span>points</span>
                </div>

                <div>
                  <strong>
                    {ranking ? `#${ranking}` : '—'}
                  </strong>
                  <span>classement</span>
                </div>
              </div>
            </div>

            <div className="leaderboard-card">
              <div className="card-topline">
                <div>
                  <span className="section-label">
                    CLASSEMENT
                  </span>

                  <h2>
                    La communauté avance ensemble
                  </h2>
                </div>

                <span className="mini-icon">
                  ↗
                </span>
              </div>

              <div className="leaderboard">
                {leaderboard.length === 0 ? (
                  <div className="empty-ranking">
                    Aucun contributeur pour le moment.
                  </div>
                ) : (
                  leaderboard
                    .slice(0, 7)
                    .map((item, index) => (
                      <div
                        key={item.assist_id}
                        className={`leader-row ${
                          item.assist_id === assistId
                            ? 'current-user'
                            : ''
                        }`}
                      >
                        <span className="rank">
                          {index + 1}
                        </span>

                        <div className="leader-person">
                          <span className="avatar">
                            {item.assist_id.replace(
                              'Assist-',
                              '',
                            )}
                          </span>

                          <div>
                            <strong>
                              {item.assist_id}
                            </strong>

                            <span>
                              {item.contributions}{' '}
                              contributions
                            </span>
                          </div>
                        </div>

                        <strong className="leader-points">
                          {item.points}
                        </strong>
                      </div>
                    ))
                )}
              </div>
            </div>
          </section>
        </main>
      )}

      {page === 'language' && (
        <main className="content-page">
          <div className="page-intro">
            <span className="section-label">
              01 · VOTRE LANGUE
            </span>

            <h1>
              Choisissez la langue que vous allez lire.
            </h1>

            <p>
              La phrase sera déjà préparée. Vous n'avez rien
              à traduire : vous allez simplement la lire et
              enregistrer votre voix.
            </p>
          </div>

          <div className="language-selector">
            {languages.map((item) => {
              const selected = item.id === language

              return (
                <button
                  type="button"
                  key={item.id}
                  className={`language-tile ${
                    selected ? 'selected' : ''
                  }`}
                  onClick={() => chooseLanguage(item.id)}
                >
                  <span className="language-letter">
                    {item.name.charAt(0)}
                  </span>

                  <strong>{item.name}</strong>

                  <span className="selection">
                    {selected
                      ? '✓ Sélectionnée'
                      : 'Choisir'}
                  </span>
                </button>
              )
            })}
          </div>

          {selectedLanguage && (
            <div className="language-confirm">
              <div>
                <span>Votre choix</span>

                <strong>
                  {selectedLanguage.name}
                </strong>
              </div>

              <button
                type="button"
                className="primary-button"
                onClick={startCollection}
                disabled={sessionLoading}
              >
                {sessionLoading
                  ? 'Chargement...'
                  : 'Commencer la session →'}
              </button>
            </div>
          )}
        </main>
      )}

      {page === 'recording' && (
        <main className="content-page recording-page">
          <div className="recording-top">
            <div>
              <span className="section-label">
                SESSION {session?.session_id || sessionIndex + 1}
                {' · '}5 EXPRESSIONS
              </span>

              <h1>
                {session?.title || 'Chargement...'}
              </h1>
            </div>

            <button
              type="button"
              className="session-language"
              onClick={changeLanguage}
            >
              {selectedLanguage?.name} · Changer
            </button>
          </div>

          {session?.phrases?.length > 0 ? (
            <>
              <div className="progress-wrap">
                <div className="progress-text">
                  <span>
                    Expression {phraseIndex + 1} sur 5
                  </span>

                  <strong>
                    {Math.round(progress)}%
                  </strong>
                </div>

                <div className="progress-bar">
                  <span
                    style={{
                      width: `${progress}%`,
                    }}
                  />
                </div>

                <div className="dots">
                  {session.phrases.map(
                    (_, index) => (
                      <span
                        key={index}
                        className={
                          index < phraseIndex
                            ? 'done'
                            : index === phraseIndex
                              ? 'active'
                              : ''
                        }
                      />
                    ),
                  )}
                </div>
              </div>

              <section className="voice-card">
                <div className="expression-header">
                  <span>
                    {currentPhrase.id}
                  </span>

                  <strong>
                    {currentPhrase.title}
                  </strong>
                </div>

                <div className="phrase-language french">
                  <span className="phrase-section-label">
                    PHRASE À TRADUIRE
                  </span>

                  <h2 className="symptom-name">
                    {currentPhrase.title || 'Symptôme'}
                  </h2>

                  <span className="source-language">
                    FRANÇAIS
                  </span>

                  <p className="french-phrase">
                    « {currentPhrase.french} »
                  </p>

                  <div className="translation-instruction">
                    Traduis cette phrase en {selectedLanguage?.name},
                    puis enregistre ta voix.
                  </div>
                </div>

                <div className="phrase-language local-language">
                  <div className="local-title">
                    <span>
                      À LIRE EN{' '}
                      {selectedLanguage?.name.toUpperCase()}
                    </span>

                    <button
                      type="button"
                      className="audio-button"
                      disabled
                    >
                      🔊 Écouter
                    </button>
                  </div>

                  <p className="local-text">
                    {currentPhrase.local_text ||
                      `Traduction en ${selectedLanguage?.name} pas disponible`}
                  </p>

                  {!currentPhrase.local_text && (
                    <small className="translation-unavailable">
                      Cette expression sera disponible dès que sa
                      traduction aura été validée.
                    </small>
                  )}
                </div>

                <div
                  className={`recorder ${
                    recordingState === 'recording'
                      ? 'is-recording'
                      : ''
                  }`}
                >
                  {recordingState === 'ready' && (
                    <>
                      <button
                        type="button"
                        className="record-button"
                        onClick={startRecording}
                        disabled={!currentPhrase.local_text}
                      >
                        <span className="mic">●</span>
                        {currentPhrase.local_text
                          ? 'Enregistrer ma voix'
                          : `Traduction en ${selectedLanguage?.name} indisponible`}
                      </button>

                      <p>
                        {currentPhrase.local_text
                          ? 'Lis simplement la phrase affichée.'
                          : 'Aucune traduction disponible pour cette expression.'}
                      </p>
                    </>
                  )}

                  {recordingState === 'recording' && (
                    <>
                      <div className="recording-live">
                        <div className="recording-dot" />

                        <div>
                          <strong>
                            Enregistrement en cours
                          </strong>

                          <span>
                            {formatTime(seconds)}
                          </span>
                        </div>
                      </div>

                      <div className="wave">
                        {Array.from({
                          length: 26,
                        }).map((_, index) => (
                          <i
                            key={index}
                            style={{
                              animationDelay: `${
                                index * -0.045
                              }s`,
                            }}
                          />
                        ))}
                      </div>

                      <button
                        type="button"
                        className="stop-button"
                        onClick={stopRecording}
                      >
                        ■ Arrêter
                      </button>
                    </>
                  )}

                  {recordingState === 'review' && (
                    <>
                      <div className="recording-done">
                        <span>✓</span>

                        <div>
                          <strong>
                            Enregistrement terminé
                          </strong>

                          <small>
                            Écoute ta voix tranquillement.
                          </small>
                        </div>
                      </div>

                      <audio
                        controls
                        src={recordingUrl}
                        className="audio-review"
                      >
                        Votre navigateur ne prend pas en
                        charge la lecture audio.
                      </audio>

                      <div className="review-buttons">
                        <button
                          type="button"
                          className="restart"
                          onClick={resetRecorder}
                          disabled={submitting}
                        >
                          ↻ Recommencer
                        </button>

                        <button
                          type="button"
                          className="validate"
                          onClick={validateRecording}
                          disabled={submitting}
                        >
                          {submitting
                            ? 'Envoi en cours...'
                            : '✓ Valider et continuer'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </section>

              <div className="motivation-bar">
                <div className="motivation-icon">
                  ✦
                </div>

                <div>
                  {challenge?.leader ? (
                    <>
                      <strong>
                        Tu es actuellement en tête.
                      </strong>

                      <span>
                        Continue à faire entendre les
                        langues locales.
                      </span>
                    </>
                  ) : targetAssist ? (
                    <>
                      <strong>
                        Encore {pointsToNext} pts (
                        {contributionsToNext}{' '}
                        contributions) pour dépasser{' '}
                        {targetAssist}.
                      </strong>

                      <span>
                        Courage, tu avances à chaque
                        contribution.
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>
                        Chaque contribution compte.
                      </strong>

                      <span>
                        Continue à faire entendre les
                        langues locales.
                      </span>
                    </>
                  )}
                </div>

                <div className="current-score">
                  <strong>
                    +{POINTS_PER_CONTRIBUTION}
                  </strong>

                  <span>
                    points / validation
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="loading-card">
              Chargement de la session...
            </div>
          )}
        </main>
      )}

      {page === 'sessionComplete' && (
        <main className="complete-page">
          <div className="complete-symbol">
            ✓
          </div>

          <span className="section-label">
            SESSION TERMINÉE
          </span>

          <h1>
            Tu viens de faire 5 contributions.
          </h1>

          <p>
            Ta progression vient d'être enregistrée
            sur MedAssist.
          </p>

          <div className="result-card">
            <div>
              <span>Votre profil</span>
              <strong>{assistId}</strong>
            </div>

            <div>
              <span>Contributions</span>
              <strong>
                {profile?.contributions || 0}
              </strong>
            </div>

            <div>
              <span>Points</span>
              <strong>
                {profile?.points || 0}
              </strong>
            </div>

            <div>
              <span>Position</span>
              <strong>
                {ranking ? `#${ranking}` : '—'}
              </strong>
            </div>
          </div>

          <div className="result-ranking">
            <div className="result-ranking-title">
              <span>CLASSEMENT</span>
              <strong>Ta position</strong>
            </div>

            {leaderboard
              .slice(0, 7)
              .map((item, index) => (
                <div
                  key={item.assist_id}
                  className={`result-row ${
                    item.assist_id === assistId
                      ? 'current-user'
                      : ''
                  }`}
                >
                  <span>#{index + 1}</span>

                  <strong>
                    {item.assist_id}
                  </strong>

                  <span>
                    {item.points} pts
                  </span>
                </div>
              ))}
          </div>

          <div className="ranking-challenge">
            <div className="challenge-icon">
              ↗
            </div>

            <div>
              {challenge?.leader ? (
                <>
                  <strong>
                    Tu es en tête du classement.
                  </strong>

                  <span>
                    Continue, tu fais avancer le projet.
                  </span>
                </>
              ) : targetAssist ? (
                <>
                  <strong>
                    Encore {pointsToNext} pts (
                    {contributionsToNext}{' '}
                    contributions) pour dépasser{' '}
                    {targetAssist}.
                  </strong>

                  <span>
                    Courage, tu y es presque.
                  </span>
                </>
              ) : (
                <>
                  <strong>
                    Continue ta progression.
                  </strong>

                  <span>
                    Chaque contribution ajoute 100 points.
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="session-earned">
            <span>Cette session</span>

            <strong>
              +{PHRASES_PER_SESSION *
                POINTS_PER_CONTRIBUTION}{' '}
              points
            </strong>

            <small>
              5 contributions vocales
            </small>
          </div>

          <div className="result-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setPage('welcome')}
            >
              Arrêter pour maintenant
            </button>

            <button
              type="button"
              className="primary-button"
              onClick={continueSession}
              disabled={sessionLoading}
            >
              {sessionLoading
                ? 'Chargement...'
                : sessionIndex < SESSION_COUNT - 1
                  ? 'Continuer avec 5 autres →'
                  : 'Terminer la série →'}
            </button>
          </div>
        </main>
      )}

      {page === 'complete' && (
        <main className="complete-page">
          <div className="complete-symbol star">
            ✦
          </div>

          <span className="section-label">
            BRAVO
          </span>

          <h1>
            Merci pour ta voix.
          </h1>

          <p>
            Tu as parcouru toutes les sessions de cette
            série.
          </p>

          <div className="final-stats">
            <strong>
              {profile?.contributions || 0}
            </strong>

            <span>contributions vocales</span>

            <strong>
              {profile?.points || 0}
            </strong>

            <span>points gagnés</span>
          </div>

          <button
            type="button"
            className="primary-button single"
            onClick={() => setPage('welcome')}
          >
            Retour à l'accueil
          </button>
        </main>
      )}

      <footer>
        <span>
          MedAssist · Language Voices
        </span>

        <span>
          Fon · Goun · Yoruba
        </span>
      </footer>
    </div>
  )
}

export default App
