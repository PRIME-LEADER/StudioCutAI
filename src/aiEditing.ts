import { LOOK_PRESETS } from './videoStyle'
import { supabaseClient } from './cloudSync'
import type {
  AiEditPlan,
  LookPreset,
  TitlePosition,
  TitleStyle,
} from './videoStyle'

export type AiServiceStatus = {
  editingEnabled: boolean
  videoGenerationEnabled: boolean
  musicRecommendationsEnabled: boolean
  jamendoEnabled: boolean
  providers?: {
    selected: string
    primary: { name: string; configured: boolean; model: string; cooldownSeconds: number }
    fallback: { name: string; configured: boolean; model: string; cooldownSeconds: number }
  }
  localVideo?: {
    configured: boolean
    ready: boolean
    provider: string
    model?: string
    gpuMemoryGb?: number
    message: string
  }
}

type VideoFrame = { timestamp: number; image: string }
export type AiToolName = 'summary' | 'script' | 'captions' | 'scenes'
export type TimedCaption = { start: number; end: number; text: string }
export type JamendoTrack = Omit<MusicRecommendation, 'matchReason'> & {
  license: string
  attributionRequired: boolean
}
export type AiProviderPreference = 'auto' | 'gemini' | 'groq'
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export function apiUrl(path: string) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

export async function authorizedApiFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (supabaseClient) {
    const { data, error } = await supabaseClient.auth.getSession()
    if (error) throw error
    if (data.session?.access_token) {
      headers.set('Authorization', `Bearer ${data.session.access_token}`)
    }
  }
  return fetch(apiUrl(path), { ...init, headers })
}

export type MusicRecommendation = {
  id: string
  name: string
  artist: string
  duration: number
  previewUrl: string
  licenseUrl: string
  shareUrl: string
  matchReason: string
  license?: string
  attributionRequired?: boolean
}

function waitForEvent(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'seeked',
  action: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const alreadyReady =
      eventName === 'loadedmetadata' &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA
    if (alreadyReady) {
      resolve()
      return
    }

    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while reading the video for AI analysis.'))
    }, 15000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener(eventName, onSuccess)
      video.removeEventListener('error', onError)
    }
    const onSuccess = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Could not read the imported video for AI analysis.'))
    }

    video.addEventListener(eventName, onSuccess, { once: true })
    video.addEventListener('error', onError, { once: true })
    action()
  })
}

export async function captureVideoFrames(
  videoUrl: string,
  duration: number,
): Promise<VideoFrame[]> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  await waitForEvent(video, 'loadedmetadata', () => {
    video.src = videoUrl
    video.load()
  })

  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 270
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare video frames for analysis.')

  const sampleTimes = [0.08, 0.28, 0.5, 0.72, 0.92]
    .map(fraction => Math.min(Math.max(0, duration - 0.05), duration * fraction))
    .filter((time, index, times) =>
      Number.isFinite(time) && times.indexOf(time) === index,
    )
  const frames: VideoFrame[] = []

  for (const timestamp of sampleTimes) {
    if (Math.abs(video.currentTime - timestamp) > 0.001) {
      await waitForEvent(video, 'seeked', () => {
        video.currentTime = timestamp
      })
    }
    const scale = Math.min(
      canvas.width / video.videoWidth,
      canvas.height / video.videoHeight,
    )
    const width = video.videoWidth * scale
    const height = video.videoHeight * scale
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(
      video,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    )
    frames.push({
      timestamp: Number(timestamp.toFixed(2)),
      image: canvas.toDataURL('image/jpeg', 0.68),
    })
  }

  video.removeAttribute('src')
  video.load()
  return frames
}

function isLookPreset(value: unknown): value is LookPreset {
  return typeof value === 'string' &&
    (LOOK_PRESETS as readonly string[]).includes(value)
}

function isTitleStyle(value: unknown): value is TitleStyle {
  return value === 'bold' || value === 'outline' || value === 'neon'
}

function isTitlePosition(value: unknown): value is TitlePosition {
  return value === 'top' || value === 'center' || value === 'bottom'
}

function validateEditPlan(value: unknown, duration: number): AiEditPlan {
  if (!value || typeof value !== 'object') {
    throw new Error('The AI returned an invalid edit plan.')
  }
  const plan = value as Record<string, unknown>
  if (
    !Array.isArray(plan.segments) ||
    plan.segments.length === 0 ||
    plan.segments.length > 20 ||
    !isLookPreset(plan.look) ||
    typeof plan.musicVolume !== 'number' ||
    !Number.isFinite(plan.musicVolume) ||
    plan.musicVolume < 0 ||
    plan.musicVolume > 1 ||
    typeof plan.summary !== 'string'
  ) {
    throw new Error('The AI returned an incomplete edit plan.')
  }

  let previousEnd = -1
  const segments = plan.segments.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`The AI returned an invalid cut at position ${index + 1}.`)
    }
    const segment = value as Record<string, unknown>
    const sourceStart = segment.sourceStart
    const sourceEnd = segment.sourceEnd
    if (
      typeof sourceStart !== 'number' ||
      typeof sourceEnd !== 'number' ||
      !Number.isFinite(sourceStart) ||
      !Number.isFinite(sourceEnd) ||
      sourceStart < 0 ||
      sourceEnd <= sourceStart ||
      sourceEnd > duration + 0.05 ||
      sourceStart < previousEnd - 0.05
    ) {
      throw new Error(`The AI returned a cut outside the video at position ${index + 1}.`)
    }
    previousEnd = sourceEnd
    return {
      sourceStart: Math.max(0, sourceStart),
      sourceEnd: Math.min(duration, sourceEnd),
    }
  })

  let title: AiEditPlan['title'] = null
  if (plan.title !== null) {
    if (!plan.title || typeof plan.title !== 'object') {
      throw new Error('The AI returned an invalid title style.')
    }
    const value = plan.title as Record<string, unknown>
    if (
      typeof value.text !== 'string' ||
      value.text.length > 100 ||
      !isTitleStyle(value.style) ||
      !isTitlePosition(value.position)
    ) {
      throw new Error('The AI returned an invalid title style.')
    }
    title = {
      text: value.text,
      style: value.style,
      position: value.position,
    }
  }

  return {
    provider: typeof plan.provider === 'string' ? plan.provider : undefined,
    segments,
    look: plan.look,
    title,
    musicVolume: plan.musicVolume,
    summary: plan.summary.slice(0, 500),
  }
}

export async function requestEditPlan(
  prompt: string,
  duration: number,
  frames: VideoFrame[],
  provider: AiProviderPreference = 'auto',
): Promise<AiEditPlan> {
  const response = await authorizedApiFetch('/api/ai/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration, frames, provider }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `AI edit request failed (${response.status}).`
    throw new Error(message)
  }

  return validateEditPlan(body, duration)
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  return body && typeof body === 'object' && 'error' in body &&
    typeof body.error === 'string'
    ? body.error
    : fallback
}

export async function requestAiTool(
  task: AiToolName,
  prompt: string,
  duration: number,
  frames: VideoFrame[],
  provider: AiProviderPreference = 'auto',
): Promise<Record<string, unknown> & { provider: string }> {
  const response = await authorizedApiFetch('/api/ai/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, prompt, duration, frames, provider }),
  })
  if (!response.ok) {
    throw new Error(await readApiError(response, `AI ${task} failed (${response.status}).`))
  }
  const body: unknown = await response.json()
  if (
    !body ||
    typeof body !== 'object' ||
    !('provider' in body) ||
    typeof body.provider !== 'string'
  ) {
    throw new Error('The AI tool returned an invalid response.')
  }
  return body as Record<string, unknown> & { provider: string }
}

export async function transcribeAudio(
  audio: Blob,
  duration: number,
  provider: AiProviderPreference = 'auto',
): Promise<{ provider: string; captions: TimedCaption[] }> {
  const bytes = new Uint8Array(await audio.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  const mimeType = audio.type === 'audio/mpeg' ? 'audio/mpeg' : 'audio/mp4'
  const response = await authorizedApiFetch('/api/ai/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      duration,
      audio: `data:${mimeType};base64,${btoa(binary)}`,
      provider,
    }),
  })
  if (!response.ok) {
    throw new Error(await readApiError(response, `Transcription failed (${response.status}).`))
  }
  const body: unknown = await response.json()
  if (
    !body ||
    typeof body !== 'object' ||
    !('provider' in body) ||
    typeof body.provider !== 'string' ||
    !('captions' in body) ||
    !Array.isArray(body.captions)
  ) {
    throw new Error('The transcription service returned an invalid response.')
  }
  return {
    provider: body.provider,
    captions: body.captions as TimedCaption[],
  }
}

export async function requestMusicRecommendations(
  prompt: string,
  duration: number,
  frames: VideoFrame[],
  provider: AiProviderPreference = 'auto',
): Promise<{ tracks: MusicRecommendation[]; matchReason: string }> {
  const response = await authorizedApiFetch('/api/music/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration, frames, provider }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `Music recommendations failed (${response.status}).`
    throw new Error(message)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('tracks' in body) ||
    !Array.isArray(body.tracks) ||
    !('matchReason' in body) ||
    typeof body.matchReason !== 'string'
  ) {
    throw new Error('The music service returned invalid recommendations.')
  }

  const tracks = body.tracks.map((value, index): MusicRecommendation => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Music recommendation ${index + 1} is invalid.`)
    }
    const track = value as Record<string, unknown>
    if (
      typeof track.id !== 'string' ||
      typeof track.name !== 'string' ||
      typeof track.artist !== 'string' ||
      typeof track.duration !== 'number' ||
      !Number.isFinite(track.duration) ||
      typeof track.previewUrl !== 'string' ||
      typeof track.licenseUrl !== 'string' ||
      typeof track.shareUrl !== 'string' ||
      typeof track.matchReason !== 'string'
    ) {
      throw new Error(`Music recommendation ${index + 1} is incomplete.`)
    }
    return {
      id: track.id,
      name: track.name,
      artist: track.artist,
      duration: track.duration,
      previewUrl: track.previewUrl,
      licenseUrl: track.licenseUrl,
      shareUrl: track.shareUrl,
      matchReason: track.matchReason,
      ...('license' in track && typeof track.license === 'string'
        ? { license: track.license }
        : {}),
      ...('attributionRequired' in track && typeof track.attributionRequired === 'boolean'
        ? { attributionRequired: track.attributionRequired }
        : {}),
    }
  })

  return { tracks, matchReason: body.matchReason }
}

export async function searchJamendoTracks(options: {
  query?: string
  genre?: string
  mood?: string
}): Promise<JamendoTrack[]> {
  const params = new URLSearchParams()
  if (options.query) params.set('q', options.query)
  if (options.genre) params.set('genre', options.genre)
  if (options.mood) params.set('mood', options.mood)
  const response = await authorizedApiFetch(`/api/music/search?${params}`)
  if (!response.ok) {
    throw new Error(await readApiError(response, `Jamendo search failed (${response.status}).`))
  }
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('tracks' in body) || !Array.isArray(body.tracks)) {
    throw new Error('Jamendo returned invalid search results.')
  }
  return body.tracks as JamendoTrack[]
}

export async function testApiConnection(
  provider: 'gemini' | 'groq' | 'jamendo',
): Promise<string> {
  const response = provider === 'jamendo'
    ? await authorizedApiFetch('/api/music/test')
    : await authorizedApiFetch(`/api/ai/test?provider=${provider}`)
  if (!response.ok) {
    throw new Error(await readApiError(response, `${provider} connection test failed.`))
  }
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') {
    throw new Error(`${provider} returned an invalid connection test response.`)
  }
  return 'model' in body && typeof body.model === 'string'
    ? `${provider} connected (${body.model})`
    : `${provider} connected`
}

export async function loadAiServiceStatus(): Promise<AiServiceStatus> {
  const response = await authorizedApiFetch('/api/ai/status')
  if (!response.ok) {
    const fallback = response.status === 502
      ? 'The API host returned a gateway error. Check that the StudioCut API is running, then open /api/health and review the hosting logs.'
      : `AI service status could not be loaded (${response.status}).`
    throw new Error(await readApiError(response, fallback))
  }
  const value: unknown = await response.json()
  if (
    !value ||
    typeof value !== 'object' ||
    !('editingEnabled' in value) ||
    !('videoGenerationEnabled' in value) ||
    !('musicRecommendationsEnabled' in value) ||
    !('jamendoEnabled' in value) ||
    typeof value.editingEnabled !== 'boolean' ||
    typeof value.videoGenerationEnabled !== 'boolean' ||
    typeof value.musicRecommendationsEnabled !== 'boolean' ||
    typeof value.jamendoEnabled !== 'boolean'
  ) {
    throw new Error('AI service returned an invalid status response.')
  }
  return {
    editingEnabled: value.editingEnabled,
    videoGenerationEnabled: value.videoGenerationEnabled,
    musicRecommendationsEnabled: value.musicRecommendationsEnabled,
    jamendoEnabled: value.jamendoEnabled,
    ...('providers' in value && value.providers && typeof value.providers === 'object'
      ? { providers: value.providers as AiServiceStatus['providers'] }
      : {}),
    ...('localVideo' in value && value.localVideo && typeof value.localVideo === 'object'
      ? { localVideo: value.localVideo as AiServiceStatus['localVideo'] }
      : {}),
  }
}

export async function createGeneratedVideo(
  prompt: string,
  ratio: '1280:720' | '720:1280',
  duration: number,
): Promise<string> {
  const response = await authorizedApiFetch('/api/ai/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, ratio, duration }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `Video generation request failed (${response.status}).`
    throw new Error(message)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('id' in body) ||
    typeof body.id !== 'string'
  ) {
    throw new Error('Video generation service returned an invalid task ID.')
  }
  return body.id
}

export async function readGeneratedVideoTask(taskId: string): Promise<{
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  progress: number
  error?: string
}> {
  const response = await authorizedApiFetch(`/api/ai/generate/${encodeURIComponent(taskId)}`)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `Video generation status failed (${response.status}).`
    throw new Error(message)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('status' in body) ||
    !['pending', 'running', 'succeeded', 'failed'].includes(String(body.status)) ||
    !('progress' in body) ||
    typeof body.progress !== 'number'
  ) {
    throw new Error('Video generation service returned an invalid task status.')
  }
  return {
    status: body.status as 'pending' | 'running' | 'succeeded' | 'failed',
    progress: Math.max(0, Math.min(100, body.progress)),
    ...('error' in body && typeof body.error === 'string'
      ? { error: body.error }
      : {}),
  }
}
