import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateSupabaseBearer } from './supabaseAuth.mjs'

const env = {
  SUPABASE_URL: 'https://studio.example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
}
const token = `Bearer ${'a'.repeat(30)}`

test('local backend mode does not require cloud authentication', async () => {
  assert.deepEqual(await authenticateSupabaseBearer(undefined, {}), {
    configured: false,
    authenticated: true,
  })
})

test('production mode fails closed when Supabase auth is not configured', async () => {
  await assert.rejects(
    authenticateSupabaseBearer(undefined, { REQUIRE_SUPABASE_AUTH: 'true' }),
    /SUPABASE_URL is required/,
  )
})

test('cloud API rejects missing or invalid bearer credentials', async () => {
  assert.deepEqual(await authenticateSupabaseBearer(undefined, env), {
    configured: true,
    authenticated: false,
  })
  const result = await authenticateSupabaseBearer(token, env, async () =>
    new Response('', { status: 401 }),
  )
  assert.equal(result.authenticated, false)
})

test('cloud API validates sessions with Supabase and never sends the secret key', async () => {
  let observedHeaders
  const result = await authenticateSupabaseBearer(token, {
    ...env,
    SUPABASE_SECRET_KEY: 'backend-only-test-secret',
  }, async (_url, options) => {
    observedHeaders = options.headers
    return Response.json({ id: 'user-id' })
  })
  assert.equal(result.authenticated, true)
  assert.equal(observedHeaders.apikey, env.SUPABASE_PUBLISHABLE_KEY)
  assert.equal(observedHeaders.Authorization, token)
  assert.equal(JSON.stringify(observedHeaders).includes('backend-only-test-secret'), false)
})
