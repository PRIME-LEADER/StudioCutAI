import { readFile } from 'node:fs/promises'

const requestTimeout = 15_000

function requestError(message, status = 503) {
  const error = new Error(message)
  error.status = status
  return error
}

function getLocalBaseUrl(env) {
  const raw = env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188'
  let url
  try {
    url = new URL(raw)
  } catch {
    throw requestError('COMFYUI_BASE_URL must be a valid local ComfyUI URL.', 500)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw requestError('ComfyUI must use HTTP or HTTPS.', 500)
  }
  const host = url.hostname.toLowerCase()
  const isLoopback =
    host === 'localhost' ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  const isPrivate =
    /^10(?:\.\d{1,3}){3}$/.test(host) ||
    /^192\.168(?:\.\d{1,3}){2}$/.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host) ||
    host.endsWith('.local')
  if (!isLoopback && !isPrivate) {
    throw requestError('ComfyUI must run on localhost or a private local network.', 500)
  }
  return url.origin
}

async function comfyJson(path, options = {}, env = process.env) {
  const base = getLocalBaseUrl(env)
  let response
  try {
    response = await fetch(new URL(path, `${base}/`), {
      ...options,
      signal: AbortSignal.timeout(requestTimeout),
    })
  } catch {
    throw requestError('Could not reach local ComfyUI. Check that it is running and accessible.', 503)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw requestError(
      body?.error?.message || `ComfyUI returned HTTP ${response.status}.`,
      response.status >= 500 ? 503 : 400,
    )
  }
  return body
}

async function readWorkflow(env) {
  if (!env.COMFYUI_WORKFLOW_FILE) {
    throw requestError('Set COMFYUI_WORKFLOW_FILE to a ComfyUI API-format video workflow.')
  }
  let raw
  try {
    raw = await readFile(env.COMFYUI_WORKFLOW_FILE, 'utf8')
  } catch {
    throw requestError('The configured ComfyUI workflow file could not be read.')
  }
  let workflow
  try {
    workflow = JSON.parse(raw)
  } catch {
    throw requestError('The configured ComfyUI workflow file is not valid JSON.')
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw requestError('Use a ComfyUI API-format workflow object.')
  }
  return workflow
}

function getNodeInput(workflow, nodeId, inputName) {
  const node = workflow[nodeId]
  if (!node || !node.inputs || !(inputName in node.inputs)) {
    throw requestError(
      `ComfyUI workflow node ${nodeId} is missing the configured input "${inputName}".`,
      500,
    )
  }
  return node
}

export async function getLocalVideoStatus(env = process.env) {
  const configured = Boolean(
    env.COMFYUI_WORKFLOW_FILE &&
    env.COMFYUI_PROMPT_NODE_ID &&
    env.COMFYUI_PROMPT_INPUT &&
    env.COMFYUI_MODEL_NODE_ID &&
    env.COMFYUI_MODEL_INPUT &&
    env.COMFYUI_WIDTH_NODE_ID &&
    env.COMFYUI_WIDTH_INPUT &&
    env.COMFYUI_HEIGHT_NODE_ID &&
    env.COMFYUI_HEIGHT_INPUT &&
    env.COMFYUI_DURATION_NODE_ID &&
    env.COMFYUI_DURATION_INPUT &&
    env.COMFYUI_OUTPUT_NODE_ID,
  )
  if (!configured) {
    return {
      configured: false,
      ready: false,
      provider: 'comfyui',
      message: 'Local video generation needs ComfyUI, an API workflow, a prompt node, and an installed-model node configured.',
    }
  }
  try {
    const workflow = await readWorkflow(env)
    const promptNode = getNodeInput(
      workflow,
      env.COMFYUI_PROMPT_NODE_ID,
      env.COMFYUI_PROMPT_INPUT,
    )
    const modelNode = getNodeInput(
      workflow,
      env.COMFYUI_MODEL_NODE_ID,
      env.COMFYUI_MODEL_INPUT,
    )
    const widthNode = getNodeInput(
      workflow,
      env.COMFYUI_WIDTH_NODE_ID,
      env.COMFYUI_WIDTH_INPUT,
    )
    const heightNode = getNodeInput(
      workflow,
      env.COMFYUI_HEIGHT_NODE_ID,
      env.COMFYUI_HEIGHT_INPUT,
    )
    const durationNode = getNodeInput(
      workflow,
      env.COMFYUI_DURATION_NODE_ID,
      env.COMFYUI_DURATION_INPUT,
    )
    const outputNode = workflow[env.COMFYUI_OUTPUT_NODE_ID]
    if (typeof promptNode.inputs[env.COMFYUI_PROMPT_INPUT] !== 'string') {
      throw requestError('The configured ComfyUI prompt input must be a text value.', 500)
    }
    if (typeof modelNode.inputs[env.COMFYUI_MODEL_INPUT] !== 'string') {
      throw requestError('The configured ComfyUI model input must select an installed model.', 500)
    }
    const modelName = modelNode.inputs[env.COMFYUI_MODEL_INPUT]
    if (!modelName || modelName.startsWith('http')) {
      throw requestError('Select a locally installed model in the ComfyUI workflow.', 500)
    }
    if (
      typeof widthNode.inputs[env.COMFYUI_WIDTH_INPUT] !== 'number' ||
      typeof heightNode.inputs[env.COMFYUI_HEIGHT_INPUT] !== 'number' ||
      typeof durationNode.inputs[env.COMFYUI_DURATION_INPUT] !== 'number'
    ) {
      throw requestError('ComfyUI workflow width, height, and duration inputs must be numbers.', 500)
    }
    if (
      !outputNode ||
      typeof outputNode.class_type !== 'string' ||
      !/(video|gif|webp)/i.test(outputNode.class_type)
    ) {
      throw requestError('The configured ComfyUI output node must save a video or animated output.', 500)
    }
    const [stats, objectInfo] = await Promise.all([
      comfyJson('/system_stats', {}, env),
      comfyJson('/object_info', {}, env),
    ])
    const classType = modelNode.class_type
    const modelInputs =
      objectInfo?.[classType]?.input?.required?.[env.COMFYUI_MODEL_INPUT] ||
      objectInfo?.[classType]?.input?.optional?.[env.COMFYUI_MODEL_INPUT]
    const availableModels = Array.isArray(modelInputs?.[0]) ? modelInputs[0] : null
    if (!availableModels) {
      return {
        configured: true,
        ready: false,
        provider: 'comfyui',
        model: modelName,
        message: 'ComfyUI could not verify the configured model loader. Check its node ID and model input name.',
      }
    }
    if (!availableModels.includes(modelName)) {
      return {
        configured: true,
        ready: false,
        provider: 'comfyui',
        model: modelName,
        message: `Model "${modelName}" is not installed or available in ComfyUI.`,
      }
    }
    const gpuMemoryBytes = Math.max(
      0,
      ...(stats?.devices || []).map(device => Number(device.vram_total) || 0),
    )
    const gpuMemoryGb = gpuMemoryBytes / (1024 ** 3)
    const minMemoryGb = Number(env.COMFYUI_MIN_VRAM_GB || 0)
    if (Number.isFinite(minMemoryGb) && minMemoryGb > 0 &&
      (gpuMemoryGb === 0 || gpuMemoryGb < minMemoryGb)) {
      return {
        configured: true,
        ready: false,
        provider: 'comfyui',
        model: modelName,
        ...(gpuMemoryGb > 0 ? { gpuMemoryGb: Number(gpuMemoryGb.toFixed(1)) } : {}),
        message: gpuMemoryGb > 0
          ? `This workflow requires at least ${minMemoryGb} GB VRAM; detected ${gpuMemoryGb.toFixed(1)} GB.`
          : `This workflow requires ${minMemoryGb} GB VRAM, but ComfyUI did not report a compatible GPU.`,
      }
    }
    return {
      configured: true,
      ready: true,
      provider: 'comfyui',
      model: modelName,
      gpuMemoryGb: Number(gpuMemoryGb.toFixed(1)),
      message: gpuMemoryGb > 0
        ? `Local ComfyUI is ready with ${modelName} and ${gpuMemoryGb.toFixed(1)} GB detected GPU memory.`
        : `Local ComfyUI is ready with ${modelName}; no GPU memory was reported, so generation may be very slow or unsupported.`,
    }
  } catch (error) {
    return {
      configured: true,
      ready: false,
      provider: 'comfyui',
      message: error instanceof Error ? error.message : 'Local ComfyUI is not ready.',
    }
  }
}

export async function startLocalVideoGeneration(
  prompt,
  ratio,
  durationSeconds,
  env = process.env,
) {
  const status = await getLocalVideoStatus(env)
  if (!status.ready) throw requestError(status.message)
  const workflow = await readWorkflow(env)
  const promptNode = getNodeInput(
    workflow,
    env.COMFYUI_PROMPT_NODE_ID,
    env.COMFYUI_PROMPT_INPUT,
  )
  const widthNode = getNodeInput(
    workflow,
    env.COMFYUI_WIDTH_NODE_ID,
    env.COMFYUI_WIDTH_INPUT,
  )
  const heightNode = getNodeInput(
    workflow,
    env.COMFYUI_HEIGHT_NODE_ID,
    env.COMFYUI_HEIGHT_INPUT,
  )
  const durationNode = getNodeInput(
    workflow,
    env.COMFYUI_DURATION_NODE_ID,
    env.COMFYUI_DURATION_INPUT,
  )
  promptNode.inputs[env.COMFYUI_PROMPT_INPUT] = prompt
  const [width, height] = ratio === '720:1280' ? [480, 832] : [832, 480]
  widthNode.inputs[env.COMFYUI_WIDTH_INPUT] = width
  heightNode.inputs[env.COMFYUI_HEIGHT_INPUT] = height
  const framesPerSecond = Number(env.COMFYUI_FRAMES_PER_SECOND || 16)
  durationNode.inputs[env.COMFYUI_DURATION_INPUT] =
    env.COMFYUI_DURATION_UNIT === 'seconds'
      ? durationSeconds
      : Math.round(durationSeconds * framesPerSecond)
  const result = await comfyJson('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  }, env)
  if (typeof result?.prompt_id !== 'string') {
    throw requestError('ComfyUI did not return a generation task ID.', 502)
  }
  return { id: result.prompt_id, model: status.model }
}

export async function readLocalVideoTask(taskId, env = process.env) {
  const [history, queue] = await Promise.all([
    comfyJson(`/history/${encodeURIComponent(taskId)}`, {}, env),
    comfyJson('/queue', {}, env),
  ])
  const inQueue = (queue?.queue_pending || []).some(item => item?.[1] === taskId)
  const running = (queue?.queue_running || []).some(item => item?.[1] === taskId)
  const task = history?.[taskId]
  if (!task) return { status: running ? 'running' : 'pending', progress: running ? 5 : inQueue ? 1 : 0 }

  const outputs = [task.outputs?.[env.COMFYUI_OUTPUT_NODE_ID]].filter(Boolean)
  const video = outputs
    .flatMap(output => [...(output.videos || []), ...(output.gifs || [])])
    .find(file => typeof file?.filename === 'string')
  const completed = Boolean(task.status?.completed)
  if (completed && !video) {
    return {
      status: 'failed',
      progress: 100,
      error: 'The ComfyUI workflow finished but did not produce a video. Add a video output node to its workflow.',
    }
  }
  if (video) {
    return {
      status: 'succeeded',
      progress: 100,
      output: {
        filename: video.filename,
        subfolder: video.subfolder || '',
        type: video.type || 'output',
      },
    }
  }
  const failed = task.status?.status_str === 'error'
  if (failed) {
    return {
      status: 'failed',
      progress: 0,
      error: 'ComfyUI could not complete the configured workflow. Check its local logs.',
    }
  }
  return { status: running ? 'running' : 'pending', progress: running ? 5 : inQueue ? 1 : 0 }
}

export async function fetchLocalVideoOutput(output, env = process.env) {
  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder,
    type: output.type,
  })
  const base = getLocalBaseUrl(env)
  let response
  try {
    response = await fetch(new URL(`/view?${query}`, base), {
      signal: AbortSignal.timeout(120_000),
    })
  } catch {
    throw requestError('Could not download the generated video from local ComfyUI.', 503)
  }
  if (!response.ok || !response.body) {
    throw requestError(`ComfyUI video download returned HTTP ${response.status}.`, 502)
  }
  return response
}
