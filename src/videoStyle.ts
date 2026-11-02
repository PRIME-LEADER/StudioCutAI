export const LOOK_PRESETS = [
  'none',
  'cinematic',
  'warm',
  'vivid',
  'mono',
] as const

export type LookPreset = (typeof LOOK_PRESETS)[number]
export type TitleStyle = 'bold' | 'outline' | 'neon'
export type TitlePosition = 'top' | 'center' | 'bottom'
export type TransitionStyle = 'cut' | 'dissolve' | 'fade' | 'wipe'

export const VIDEO_TRANSITIONS: TransitionStyle[] = [
  'cut',
  'dissolve',
  'fade',
  'wipe',
]

export const TRANSITION_LABELS: Record<TransitionStyle, string> = {
  cut: 'Cut',
  dissolve: 'Dissolve',
  fade: 'Fade',
  wipe: 'Soft wipe',
}

export const LOOK_LABELS: Record<LookPreset, string> = {
  none: 'Original',
  cinematic: 'Cinematic',
  warm: 'Warm',
  vivid: 'Vivid',
  mono: 'B&W',
}

export const LOOK_FILTERS: Record<LookPreset, string> = {
  none: 'none',
  cinematic: 'contrast(1.13) saturate(.88) brightness(.97)',
  warm: 'contrast(1.04) saturate(1.15) sepia(.17)',
  vivid: 'contrast(1.1) saturate(1.3)',
  mono: 'grayscale(1) contrast(1.08)',
}

export type AiEditPlan = {
  provider?: string
  segments: Array<{ sourceStart: number; sourceEnd: number }>
  look: LookPreset
  title: {
    text: string
    style: TitleStyle
    position: TitlePosition
  } | null
  musicVolume: number
  summary: string
}

export type TitleOverlayOptions = {
  text: string
  style: TitleStyle
  position: TitlePosition
  color: string
}

export async function renderTitleOverlay({
  text,
  style,
  position,
  color,
}: TitleOverlayOptions): Promise<Blob | null> {
  const content = text.trim()
  if (!content) return null

  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not render the title overlay.')

  const fontSize = 58
  context.font = `800 ${fontSize}px Arial, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  context.lineWidth = 5

  const maxWidth = 1120
  const words = content.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)

  const lineHeight = fontSize * 1.2
  const blockHeight = lines.length * lineHeight
  const centerY =
    position === 'top'
      ? 105 + blockHeight / 2
      : position === 'bottom'
        ? canvas.height - 105 - blockHeight / 2
        : canvas.height / 2

  if (style === 'neon') {
    context.shadowColor = color
    context.shadowBlur = 24
  } else {
    context.shadowColor = '#000000c9'
    context.shadowBlur = 8
    context.shadowOffsetY = 3
  }

  lines.forEach((textLine, index) => {
    const y = centerY + (index - (lines.length - 1) / 2) * lineHeight
    if (style === 'outline') {
      context.strokeStyle = '#17131f'
      context.strokeText(textLine, canvas.width / 2, y, maxWidth)
    }
    context.fillStyle = color
    context.fillText(textLine, canvas.width / 2, y, maxWidth)
  })

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('Could not encode the title overlay.'))
    }, 'image/png')
  })
}
