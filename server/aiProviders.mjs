const GEMINI_MODEL = 'gemini-2.5-flash'
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const PROVIDER_COOLDOWN_MS = 24 * 60 * 60 * 1000
const cooldowns = new Map()

function providerKey(provider, env) {
  return provider === 'gemini' ? env.GEMINI_API_KEY : env.GROQ_API_KEY
}

function selectedProviders(env) {
  const selected = env.AI_PROVIDER || 'auto'
  if (!['auto', 'gemini', 'groq'].includes(selected)) {
    throw new Error('AI_PROVIDER must be auto, gemini, or groq.')
  }
  return selected === 'groq' ? ['groq'] : ['gemini', 'groq']
}

function requestError(message, status = 502, retryAfterSeconds = 0) {
  const error = new Error(message)
  error.status = status
  error.retryAfterSeconds = retryAfterSeconds
  return error
}

function providerFailure(provider, status, body) {
  const message =
    body?.error?.message ||
    body?.error ||
    `${provider === 'gemini' ? 'Gemini' : 'Groq'} returned HTTP ${status}.`
  const limited =
    status === 429 ||
    status === 402 ||
    /resource.?exhausted|quota|rate.?limit|billing/i.test(String(message))
  const error = requestError(
    limited
      ? `${provider === 'gemini' ? 'Gemini' : 'Groq'} free-tier quota or rate limit reached.`
      : status === 401 || status === 403
        ? `${provider === 'gemini' ? 'Gemini' : 'Groq'} rejected the configured credentials. Check the server key.`
        : String(message).slice(0, 400),
    limited ? 429 : status === 401 || status === 403 ? 503 : 502,
  )
  if (limited) {
    const retryAfter = Number(body?.error?.details?.[0]?.retryDelay?.replace?.('s', ''))
    error.retryAfterSeconds =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, PROVIDER_COOLDOWN_MS / 1000)
        : PROVIDER_COOLDOWN_MS / 1000
  }
  return error
}

function imageParts(frames = []) {
  return frames.flatMap(frame => {
    const match = frame.image.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i)
    if (!match) return []
    return [{
      type: 'text',
      text: `Video frame at ${frame.timestamp.toFixed(2)} seconds.`,
    }, {
      type: 'image_url',
      image_url: { url: frame.image, detail: 'low' },
    }]
  })
}

async function callGemini(prompt, systemPrompt, frames, env) {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw requestError('Gemini is not configured.', 503)
  const model = GEMINI_MODEL
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  )
  url.searchParams.set('key', apiKey)
  const parts = [{ text: prompt }, ...frames.flatMap(frame => {
    const match = frame.image.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i)
    return match
      ? [
          { text: `Video frame at ${frame.timestamp.toFixed(2)} seconds.` },
          { inline_data: { mime_type: match[1], data: match[2] } },
        ]
      : []
  })]
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 1800,
          temperature: 0.2,
        },
      }),
    })
  } catch {
    throw requestError('Gemini could not be reached. Check the network and retry.', 502)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw providerFailure('gemini', response.status, body)
  const content = body?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
  if (typeof content !== 'string' || !content.trim()) {
    throw requestError('Gemini returned no AI response.', 502)
  }
  return { content, provider: 'gemini' }
}

async function callGroq(prompt, systemPrompt, frames, env) {
  const apiKey = env.GROQ_API_KEY
  if (!apiKey) throw requestError('Groq is not configured.', 503)
  const model = GROQ_MODEL
  const content = [
    { type: 'text', text: prompt },
    ...imageParts(frames),
  ]
  let response
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
      }),
    })
  } catch {
    throw requestError('Groq could not be reached. Check the network and retry.', 502)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw providerFailure('groq', response.status, body)
  const text = body?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    throw requestError('Groq returned no AI response.', 502)
  }
  return { content: text, provider: 'groq' }
}

export async function generateAiJson(
  prompt,
  systemPrompt,
  frames = [],
  env = process.env,
) {
  const providers = selectedProviders(env)
  const failures = []
  for (const provider of providers) {
    if (!providerKey(provider, env)) continue
    const cooldown = cooldowns.get(provider) || 0
    if (cooldown > Date.now()) {
      failures.push(requestError(
        `${provider === 'gemini' ? 'Gemini' : 'Groq'} is cooling down after a free-tier limit; retry in ${Math.ceil((cooldown - Date.now()) / 60_000)} minute(s).`,
        429,
      ))
      continue
    }

    try {
      return provider === 'gemini'
        ? await callGemini(prompt, systemPrompt, frames, env)
        : await callGroq(prompt, systemPrompt, frames, env)
    } catch (error) {
      failures.push(error)
      if (error.status === 429) {
        cooldowns.set(
          provider,
          Date.now() + (error.retryAfterSeconds || PROVIDER_COOLDOWN_MS / 1000) * 1000,
        )
      }
      if (error.status === 400) throw error
    }
  }

  if (failures.length) {
    const exhausted = failures.find(error => error.status === 429)
    throw exhausted || failures[failures.length - 1]
  }
  throw requestError(
    'No AI provider is configured. Add GEMINI_API_KEY and optionally GROQ_API_KEY to the server environment.',
    503,
  )
}

export function getAiProviderStatus(env = process.env) {
  const selected = env.AI_PROVIDER || 'auto'
  const now = Date.now()
  return {
    selected,
    primary: {
      name: 'gemini',
      configured: Boolean(env.GEMINI_API_KEY),
      model: GEMINI_MODEL,
      cooldownSeconds: Math.max(0, Math.ceil(((cooldowns.get('gemini') || 0) - now) / 1000)),
    },
    fallback: {
      name: 'groq',
      configured: Boolean(env.GROQ_API_KEY),
      model: GROQ_MODEL,
      cooldownSeconds: Math.max(0, Math.ceil(((cooldowns.get('groq') || 0) - now) / 1000)),
    },
  }
}

export async function testAiProvider(provider, env = process.env) {
  if (!['gemini', 'groq'].includes(provider)) {
    throw requestError('Choose Gemini or Groq for the connection test.', 400)
  }
  const cooldown = cooldowns.get(provider) || 0
  if (cooldown > Date.now()) {
    throw requestError(
      `${provider} is cooling down after a free-tier limit; retry in ${Math.ceil((cooldown - Date.now()) / 60_000)} minute(s).`,
      429,
    )
  }
  let result
  try {
    result = provider === 'gemini'
      ? await callGemini('Return {"ok":true}.', 'Return only valid JSON with an ok boolean.', [], env)
      : await callGroq('Return {"ok":true}.', 'Return only valid JSON with an ok boolean.', [], env)
  } catch (error) {
    if (error.status === 429) {
      cooldowns.set(
        provider,
        Date.now() + (error.retryAfterSeconds || PROVIDER_COOLDOWN_MS / 1000) * 1000,
      )
    }
    throw error
  }
  try {
    const parsed = JSON.parse(result.content)
    if (parsed.ok !== true) throw new Error()
  } catch {
    throw requestError(`${provider} responded, but its test response was invalid.`, 502)
  }
  return {
    provider,
    model: provider === 'gemini' ? GEMINI_MODEL : GROQ_MODEL,
    connected: true,
  }
}

export function clearProviderCooldownsForTests() {
  cooldowns.clear()
}

export async function transcribeAudio(audioBase64, duration, env = process.env) {
  const providers = selectedProviders(env)
  const failures = []
  for (const provider of providers) {
    if (!providerKey(provider, env)) continue
    const cooldown = cooldowns.get(provider) || 0
    if (cooldown > Date.now()) {
      failures.push(requestError(
        `${provider} is cooling down after a free-tier limit; retry in ${Math.ceil((cooldown - Date.now()) / 60_000)} minute(s).`,
        429,
      ))
      continue
    }

    try {
      let captions
      if (provider === 'gemini') {
        const url = new URL(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        )
        url.searchParams.set('key', env.GEMINI_API_KEY)
        const audio = audioBase64.match(/^data:(audio\/(?:mpeg|mp4));base64,([A-Za-z0-9+/=]+)$/)
        if (!audio) throw requestError('Caption audio must be MP3 or M4A.', 400)
        let response
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(90_000),
            body: JSON.stringify({
              system_instruction: {
                parts: [{
                  text: `Transcribe the audio verbatim and return timed captions as JSON: {"captions":[{"start":0.0,"end":2.5,"text":"exact spoken words"}]}. Source duration is ${duration.toFixed(2)} seconds. Use seconds, keep words faithful, and do not invent speech.`,
                }],
              },
              contents: [{
                role: 'user',
                parts: [
                  { inline_data: { mime_type: audio[1], data: audio[2] } },
                  { text: 'Transcribe all audible speech with timestamps.' },
                ],
              }],
              generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 6000,
                temperature: 0,
              },
            }),
          })
        } catch {
          throw requestError('Gemini audio transcription could not be reached.', 502)
        }
        const body = await response.json().catch(() => null)
        if (!response.ok) throw providerFailure('gemini', response.status, body)
        const text = body?.candidates?.[0]?.content?.parts
          ?.map(part => part.text || '')
          .join('')
        captions = JSON.parse(text || '{}').captions
      } else {
        const [, mimeType, encodedAudio] =
          audioBase64.match(/^data:(audio\/(?:mpeg|mp4));base64,([A-Za-z0-9+/=]+)$/) || []
        if (!mimeType || !encodedAudio) {
          throw requestError('Caption audio must be MP3 or M4A audio.', 400)
        }
        const fileBytes = Buffer.from(encodedAudio, 'base64')
        const form = new FormData()
        form.set('model', 'whisper-large-v3-turbo')
        form.set('response_format', 'verbose_json')
        form.set('timestamp_granularities[]', 'segment')
        form.set('file', new Blob([fileBytes], { type: mimeType }), mimeType === 'audio/mpeg' ? 'studiocut-audio.mp3' : 'studiocut-audio.m4a')
        let response
        try {
          response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
            body: form,
            signal: AbortSignal.timeout(90_000),
          })
        } catch {
          throw requestError('Groq audio transcription could not be reached.', 502)
        }
        const body = await response.json().catch(() => null)
        if (!response.ok) throw providerFailure('groq', response.status, body)
        captions = body?.segments?.map(segment => ({
          start: segment.start,
          end: segment.end,
          text: segment.text,
        }))
      }

      if (!Array.isArray(captions)) {
        throw requestError(`${provider} returned no timed captions.`, 502)
      }
      const cleanCaptions = captions
        .filter(caption =>
          caption &&
          Number.isFinite(caption.start) &&
          Number.isFinite(caption.end) &&
          caption.start >= 0 &&
          caption.end > caption.start &&
          caption.end <= duration + 0.1 &&
          typeof caption.text === 'string' &&
          caption.text.trim().length > 0 &&
          caption.text.length <= 500,
        )
        .slice(0, 500)
        .map(caption => ({
          start: Math.max(0, caption.start),
          end: Math.min(duration, caption.end),
          text: caption.text.trim(),
        }))
      if (!cleanCaptions.length) {
        throw requestError(`${provider} did not return valid timed captions.`, 502)
      }
      return { provider, captions: cleanCaptions }
    } catch (error) {
      failures.push(error)
      if (error.status === 429) {
        cooldowns.set(
          provider,
          Date.now() + (error.retryAfterSeconds || PROVIDER_COOLDOWN_MS / 1000) * 1000,
        )
      }
      if (error.status === 400) throw error
    }
  }
  if (failures.length) {
    const exhausted = failures.find(error => error.status === 429)
    throw exhausted || failures[failures.length - 1]
  }
  throw requestError(
    'Timed speech captions require GEMINI_API_KEY and/or GROQ_API_KEY.',
    503,
  )
}
