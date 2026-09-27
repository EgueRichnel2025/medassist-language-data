const API_BASE =
  import.meta.env.VITE_API_URL ||
  'http://127.0.0.1:8000/api'

async function request(path, options = {}) {
  const response = await fetch(
    `${API_BASE}${path}`,
    options,
  )

  let data = null

  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    throw new Error(
      data?.detail ||
      `Erreur API (${response.status})`,
    )
  }

  return data
}

export function createContributor(clientId) {
  return request(
    `/contributors?client_id=${encodeURIComponent(clientId)}`,
    {
      method: 'POST',
    },
  )
}

export function getContributor(assistId) {
  return request(
    `/contributors/${encodeURIComponent(assistId)}`,
  )
}

export function getLeaderboard() {
  return request('/leaderboard?limit=20')
}

export function getChallenge(assistId) {
  return request(
    `/leaderboard/${encodeURIComponent(assistId)}/challenge`,
  )
}

export function getSession(language, sessionId) {
  return request(
    `/sessions/${encodeURIComponent(language)}/${sessionId}`,
  )
}

export async function uploadRecording({
  language,
  symptomId,
  blob,
  accessToken,
}) {
  const formData = new FormData()

  formData.append('language', language)
  formData.append('symptom_id', symptomId)

  formData.append(
    'audio',
    blob,
    `recording-${symptomId}.webm`,
  )

  return request('/recordings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  })
}
