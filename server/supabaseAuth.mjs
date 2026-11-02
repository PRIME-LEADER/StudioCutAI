import { createHash } from 'node:crypto'

const userCache = new Map()
const CACHE_TTL_MS = 30_000

function authError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

function getSupabaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw authError('SUPABASE_URL must be a valid HTTPS Supabase project URL.', 500)
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw authError('SUPABASE_URL must use HTTPS outside local development.', 500)
  }
  return url.origin
}

export async function authenticateSupabaseBearer(
  authorization,
  env = process.env,
  fetchImpl = fetch,
) {
  if (!env.SUPABASE_URL) {
    if (env.REQUIRE_SUPABASE_AUTH === 'true') {
      throw authError('SUPABASE_URL is required while cloud API authentication is enabled.', 503)
    }
    return { configured: false, authenticated: true }
  }
  if (!env.SUPABASE_PUBLISHABLE_KEY) {
    throw authError('SUPABASE_PUBLISHABLE_KEY is required to authenticate cloud API requests.', 503)
  }
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer ([A-Za-z0-9._~-]{20,8192})$/)
    : null
  if (!match) return { configured: true, authenticated: false }

  const token = match[1]
  const cacheKey = createHash('sha256').update(token).digest('hex')
  const cached = userCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { configured: true, authenticated: true }
  }
  userCache.delete(cacheKey)

  let response
  try {
    const url = getSupabaseUrl(env.SUPABASE_URL)
    response = await fetchImpl(`${url}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(8_000),
    })
  } catch (error) {
    if (error?.status) throw error
    throw authError('Supabase authentication could not be reached.', 503)
  }
  if (response.status === 401 || response.status === 403) {
    return { configured: true, authenticated: false }
  }
  if (!response.ok) {
    throw authError(`Supabase authentication returned HTTP ${response.status}.`, 503)
  }
  userCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS })
  if (userCache.size > 2000) {
    for (const [key, value] of userCache) {
      if (value.expiresAt <= Date.now()) userCache.delete(key)
    }
  }
  return { configured: true, authenticated: true }
}
