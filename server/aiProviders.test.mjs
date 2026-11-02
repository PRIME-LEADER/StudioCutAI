import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import {
  clearProviderCooldownsForTests,
  generateAiJson,
  testAiProvider,
} from './aiProviders.mjs'
import {
  fetchLocalVideoOutput,
  getLocalVideoStatus,
  readLocalVideoTask,
  startLocalVideoGeneration,
} from './localVideo.mjs'

const originalFetch = globalThis.fetch

beforeEach(() => {
  clearProviderCooldownsForTests()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearProviderCooldownsForTests()
})

test('Gemini handles structured edit requests', async () => {
  let requestUrl = ''
  let requestBody
  globalThis.fetch = async (url, options) => {
    requestUrl = String(url)
    requestBody = JSON.parse(options.body)
    return Response.json({
      candidates: [{
        content: { parts: [{ text: '{"summary":"A strong opening."}' }] },
      }],
    })
  }

  const result = await generateAiJson(
    'Make a fast-paced highlight reel with a dramatic look.',
    'Return JSON.',
    [],
    { AI_PROVIDER: 'auto', GEMINI_API_KEY: 'test-key' },
  )

  assert.equal(result.provider, 'gemini')
  assert.match(requestUrl, /generativelanguage\.googleapis\.com/)
  assert.match(requestUrl, /key=test-key/)
  assert.equal(
    requestBody.contents[0].parts[0].text,
    'Make a fast-paced highlight reel with a dramatic look.',
  )
  assert.equal(JSON.parse(result.content).summary, 'A strong opening.')
})

test('Gemini quota exhaustion falls back to Groq and then cools Gemini down', async () => {
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    if (String(url).includes('googleapis.com')) {
      return Response.json(
        { error: { message: 'Resource exhausted: quota exceeded.' } },
        { status: 429 },
      )
    }
    return Response.json({
      choices: [{ message: { content: '{"summary":"Fallback response."}' } }],
    })
  }
  const env = {
    AI_PROVIDER: 'auto',
    GEMINI_API_KEY: 'gemini-test',
    GROQ_API_KEY: 'groq-test',
  }

  const first = await generateAiJson('Summarize.', 'Return JSON.', [], env)
  assert.equal(first.provider, 'groq')
  assert.equal(requests.length, 2)

  await assert.rejects(
    generateAiJson('Summarize.', 'Return JSON.', [], {
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-test',
    }),
    /cooling down after a free-tier limit/,
  )
  assert.equal(requests.length, 2)
})

test('provider test rejects invalid credentials without leaking the key', async () => {
  globalThis.fetch = async () =>
    Response.json({ error: { message: 'Invalid API key: test-key' } }, { status: 401 })

  await assert.rejects(
    testAiProvider('gemini', { GEMINI_API_KEY: 'test-key' }),
    error => {
      assert.match(error.message, /rejected the configured credentials/)
      assert.doesNotMatch(error.message, /test-key/)
      return true
    },
  )
})

test('AI requests fail closed when no provider key is configured', async () => {
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('Should not make a request.')
  }
  await assert.rejects(
    generateAiJson('Summarize.', 'Return JSON.', [], { AI_PROVIDER: 'auto' }),
    /No AI provider is configured/,
  )
  assert.equal(called, false)
})

test('local generation stays disabled until ComfyUI workflow and model config exist', async () => {
  const status = await getLocalVideoStatus({})
  assert.equal(status.configured, false)
  assert.equal(status.ready, false)
  assert.match(status.message, /ComfyUI/)
})

test('ComfyUI verifies an installed workflow model and generates an importable video', async () => {
  const workflowFile = fileURLToPath(
    new URL('./test-fixtures/comfy-video-workflow.json', import.meta.url),
  )
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'))
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    calls.push({ url, options })
    if (url.pathname === '/system_stats') {
      return Response.json({ devices: [{ vram_total: 12 * 1024 ** 3 }] })
    }
    if (url.pathname === '/object_info') {
      return Response.json({
        VideoModelLoader: {
          input: { required: { model_name: [['wan-video-model.safetensors']] } },
        },
      })
    }
    if (url.pathname === '/prompt') {
      return Response.json({ prompt_id: 'task-123' })
    }
    if (url.pathname === '/history/task-123') {
      return Response.json({
        'task-123': {
          status: { completed: true },
          outputs: {
            '4': { videos: [{ filename: 'generated.mp4', type: 'output' }] },
          },
        },
      })
    }
    if (url.pathname === '/queue') {
      return Response.json({ queue_running: [], queue_pending: [] })
    }
    if (url.pathname === '/view') {
      return new Response(new Uint8Array([0, 0, 0, 1]), {
        headers: { 'Content-Type': 'video/mp4' },
      })
    }
    throw new Error(`Unexpected ComfyUI request: ${url.pathname}`)
  }
  const env = {
    COMFYUI_BASE_URL: 'http://127.0.0.1:8188',
    COMFYUI_WORKFLOW_FILE: workflowFile,
    COMFYUI_PROMPT_NODE_ID: '1',
    COMFYUI_PROMPT_INPUT: 'text',
    COMFYUI_MODEL_NODE_ID: '2',
    COMFYUI_MODEL_INPUT: 'model_name',
    COMFYUI_WIDTH_NODE_ID: '3',
    COMFYUI_WIDTH_INPUT: 'width',
    COMFYUI_HEIGHT_NODE_ID: '3',
    COMFYUI_HEIGHT_INPUT: 'height',
    COMFYUI_DURATION_NODE_ID: '3',
    COMFYUI_DURATION_INPUT: 'length',
    COMFYUI_OUTPUT_NODE_ID: '4',
    COMFYUI_DURATION_UNIT: 'frames',
    COMFYUI_FRAMES_PER_SECOND: '16',
    COMFYUI_MIN_VRAM_GB: '8',
  }

  const status = await getLocalVideoStatus(env)
  assert.equal(status.ready, true)
  assert.equal(status.model, 'wan-video-model.safetensors')
  assert.equal(status.gpuMemoryGb, 12)

  const task = await startLocalVideoGeneration(
    'A sunrise over the ocean.',
    '720:1280',
    5,
    env,
  )
  assert.equal(task.id, 'task-123')
  const promptRequest = calls.find(call => call.url.pathname === '/prompt')
  const body = JSON.parse(promptRequest.options.body)
  assert.equal(body.prompt['1'].inputs.text, 'A sunrise over the ocean.')
  assert.equal(body.prompt['3'].inputs.width, 480)
  assert.equal(body.prompt['3'].inputs.height, 832)
  assert.equal(body.prompt['3'].inputs.length, 80)
  assert.equal(workflow['1'].inputs.text, 'original prompt')

  const result = await readLocalVideoTask(task.id, env)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output.filename, 'generated.mp4')
  assert.ok(calls.some(call => call.url.pathname === '/queue'))
  const video = await fetchLocalVideoOutput(result.output, env)
  assert.equal(video.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), new Uint8Array([0, 0, 0, 1]))
})

test('ComfyUI refuses workflows whose selected model is not installed', async () => {
  const workflowFile = fileURLToPath(
    new URL('./test-fixtures/comfy-video-workflow.json', import.meta.url),
  )
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname === '/system_stats') {
      return Response.json({ devices: [{ vram_total: 12 * 1024 ** 3 }] })
    }
    if (url.pathname === '/object_info') {
      return Response.json({
        VideoModelLoader: {
          input: { required: { model_name: [['other-model.safetensors']] } },
        },
      })
    }
    throw new Error(`Unexpected ComfyUI request: ${url.pathname}`)
  }
  const status = await getLocalVideoStatus({
    COMFYUI_BASE_URL: 'http://127.0.0.1:8188',
    COMFYUI_WORKFLOW_FILE: workflowFile,
    COMFYUI_PROMPT_NODE_ID: '1',
    COMFYUI_PROMPT_INPUT: 'text',
    COMFYUI_MODEL_NODE_ID: '2',
    COMFYUI_MODEL_INPUT: 'model_name',
    COMFYUI_WIDTH_NODE_ID: '3',
    COMFYUI_WIDTH_INPUT: 'width',
    COMFYUI_HEIGHT_NODE_ID: '3',
    COMFYUI_HEIGHT_INPUT: 'height',
    COMFYUI_DURATION_NODE_ID: '3',
    COMFYUI_DURATION_INPUT: 'length',
    COMFYUI_OUTPUT_NODE_ID: '4',
    COMFYUI_DURATION_UNIT: 'frames',
  })
  assert.equal(status.configured, true)
  assert.equal(status.ready, false)
  assert.match(status.message, /not installed/)
})
