import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  clipDuration,
  createTimelineClip,
  splitClipAt,
  deleteClip,
  duplicateClip,
  moveClip,
  timelineDuration,
  timelinePositionForClip,
  timelinePositionToSourceTime,
} from './timeline'
import type { TimelineClip } from './timeline'
import { exportVideo, extractAudio } from './videoExport'
import { listStoredProjects, loadProject, saveProject } from './projectStorage'
import type { MusicAttribution, StoredProject } from './projectStorage'
import CloudWorkspace from './CloudWorkspace'
import { restoreCloudProject, syncProjectToCloud } from './cloudSync'
import {
  captureVideoFrames,
  createGeneratedVideo,
  authorizedApiFetch,
  loadAiServiceStatus,
  readGeneratedVideoTask,
  requestAiTool,
  requestMusicRecommendations,
  requestEditPlan,
  searchJamendoTracks,
  testApiConnection,
  transcribeAudio,
} from './aiEditing'
import type {
  AiServiceStatus,
  AiToolName,
  AiProviderPreference,
  JamendoTrack,
  MusicRecommendation,
  TimedCaption,
} from './aiEditing'
import {
  LOOK_FILTERS,
  LOOK_LABELS,
  LOOK_PRESETS,
  TRANSITION_LABELS,
  VIDEO_TRANSITIONS,
  renderTitleOverlay,
} from './videoStyle'
import type {
  AiEditPlan,
  LookPreset,
  TitlePosition,
  TitleStyle,
  TransitionStyle,
} from './videoStyle'
import './App.css'

type Project = { id: number; name: string; updated: string }
type VideoAsset = { file: File; duration: number }
type TimelineDrag =
  | { mode: 'playhead' }
  | {
      mode: 'video-start' | 'video-end'
      clipId: string
      pointerStartTime: number
      timelineScale: number
      sourceStart: number
      sourceEnd: number
    }
  | {
      mode: 'music-move' | 'music-start' | 'music-end'
      pointerStartTime: number
      timelineScale: number
      timelineStart: number
      sourceStart: number
      sourceEnd: number
    }

function readVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const duration = video.duration
      video.removeAttribute('src')
      video.load()
      if (Number.isFinite(duration) && duration > 0) resolve(duration)
      else reject(new Error('The video has an invalid duration.'))
    }
    video.onerror = () => {
      video.removeAttribute('src')
      video.load()
      reject(new Error('This browser could not read the video. Try MP4, MOV, or WebM.'))
    }
    video.src = url
  })
}

function readProjectList(): Project[] {
  try {
    const savedProjects = localStorage.getItem('studiocut-project-list')
    if (!savedProjects) return []

    const parsed: unknown = JSON.parse(savedProjects)
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (project): project is Project =>
        typeof project?.id === 'number' &&
        typeof project?.name === 'string' &&
        typeof project?.updated === 'string',
    )
  } catch (error) {
    console.error('Project list could not be loaded:', error)
    return []
  }
}

function readPreference(key: string) {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function createProjectId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

function App() {
  const [projects, setProjects] = useState<Project[]>(readProjectList)
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectReady, setProjectReady] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [cloudUser, setCloudUser] = useState<User | null>(null)
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(() =>
    readPreference('studiocut-cloud-sync-enabled'),
  )
  const [mediaSyncEnabled, setMediaSyncEnabled] = useState(() =>
    readPreference('studiocut-cloud-media-enabled'),
  )
  const [cloudSyncMessage, setCloudSyncMessage] = useState('')
  const [aiMediaConsent, setAiMediaConsent] = useState(false)

  const [videoUrl, setVideoUrl] = useState('')
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoName, setVideoName] = useState('')
  const [videoDuration, setVideoDuration] = useState(0)
  const [videoAssets, setVideoAssets] = useState<VideoAsset[]>([])
  const [playheadTime, setPlayheadTime] = useState(0)

  const [musicName, setMusicName] = useState('')
  const [musicFile, setMusicFile] = useState<File | null>(null)
  const [musicAttribution, setMusicAttribution] =
    useState<MusicAttribution | null>(null)
  const [musicUrl, setMusicUrl] = useState('')
  const [musicDuration, setMusicDuration] = useState(0)
  const [musicTimelineStart, setMusicTimelineStart] = useState(0)
  const [musicSourceStart, setMusicSourceStart] = useState(0)
  const [musicSourceEnd, setMusicSourceEnd] = useState(0)
  const [musicVolume, setMusicVolume] = useState(0.8)
  const [videoVolume, setVideoVolume] = useState(1)

  const [timelineClips, setTimelineClips] = useState<TimelineClip[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)

  const [assistantPrompt, setAssistantPrompt] = useState('')
  const [assistantMessages, setAssistantMessages] = useState<string[]>([
    'Hi! Describe the edit you want and I’ll build a cut plan from your footage.',
  ])
  const [assistantLoading, setAssistantLoading] = useState(false)
  const [pendingAiPlan, setPendingAiPlan] = useState<AiEditPlan | null>(null)
  const [activeTab, setActiveTab] = useState('AI Edit')
  const [aiProviderPreference, setAiProviderPreference] =
    useState<AiProviderPreference>('auto')
  const [aiToolLoading, setAiToolLoading] = useState(false)
  const [aiToolError, setAiToolError] = useState('')
  const [aiToolResult, setAiToolResult] = useState<{
    task: AiToolName
    provider: string
    text?: string
    captions?: TimedCaption[]
    scenes?: Array<{ timestamp: number; description: string; suggestion: string }>
  } | null>(null)
  const [connectionTestMessages, setConnectionTestMessages] =
    useState<Record<string, string>>({})
  const [musicSearchQuery, setMusicSearchQuery] = useState('')
  const [musicSearchGenre, setMusicSearchGenre] = useState('')
  const [musicSearchMood, setMusicSearchMood] = useState('')
  const [jamendoTracks, setJamendoTracks] = useState<JamendoTrack[]>([])
  const [musicSearchLoading, setMusicSearchLoading] = useState(false)
  const [musicSearchError, setMusicSearchError] = useState('')
  const [videoPrompt, setVideoPrompt] = useState('')
  const [videoRatio, setVideoRatio] = useState<'1280:720' | '720:1280'>('1280:720')
  const [videoGenerationDuration, setVideoGenerationDuration] = useState(5)
  const [musicRecommendations, setMusicRecommendations] =
    useState<MusicRecommendation[]>([])
  const [musicMatchReason, setMusicMatchReason] = useState('')
  const [musicRecommendationsLoading, setMusicRecommendationsLoading] =
    useState(false)
  const [musicRecommendationsError, setMusicRecommendationsError] =
    useState('')
  const [generatedVideo, setGeneratedVideo] = useState<{
    taskId: string
    prompt: string
    duration: number
    status: 'pending' | 'running' | 'succeeded' | 'failed'
    progress: number
    error?: string
  } | null>(null)
  const [generatedVideoPreview, setGeneratedVideoPreview] = useState<{
    taskId: string
    url: string
  } | null>(null)
  const [aiServiceStatus, setAiServiceStatus] = useState<AiServiceStatus>({
    editingEnabled: false,
    videoGenerationEnabled: false,
    musicRecommendationsEnabled: false,
    jamendoEnabled: false,
  })
  const [aiServiceError, setAiServiceError] = useState('')
  const [lookPreset, setLookPreset] = useState<LookPreset>('none')
  const [titleText, setTitleText] = useState('')
  const [titleStyle, setTitleStyle] = useState<TitleStyle>('bold')
  const [titlePosition, setTitlePosition] = useState<TitlePosition>('bottom')
  const [titleColor, setTitleColor] = useState('#ffffff')
  const [transitionStyle, setTransitionStyle] = useState<TransitionStyle>('cut')
  const [transitionDuration, setTransitionDuration] = useState(0.35)
  const [brightness, setBrightness] = useState(0)
  const [contrast, setContrast] = useState(1)
  const [saturation, setSaturation] = useState(1)
  const [selectedTool, setSelectedTool] = useState('Select')
  const [editorMessage, setEditorMessage] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

  const videoElementRef = useRef<HTMLVideoElement | null>(null)
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const timelineLaneRef = useRef<HTMLDivElement | null>(null)
  const musicLaneRef = useRef<HTMLDivElement | null>(null)
  const dragModeRef = useRef<TimelineDrag | null>(null)
  const draggedClipIndexRef = useRef<number | null>(null)
  const playheadClipIndexRef = useRef(0)
  const videoRevisionRef = useRef(0)
  const generationRequestRef = useRef(0)
  const musicMatchRequestRef = useRef(0)
  const providerPreferenceLoadedRef = useRef(false)
  const cloudRevisionsRef = useRef(new Map<number, number>())

  const handleCloudUserChange = useCallback((user: User | null) => {
    setCloudUser(user)
  }, [])
  const videoUrlsRef = useRef(new Map<File, string>())
  const pendingPreviewRef = useRef<{ time: number; resume: boolean } | null>(null)
  const pendingAiSourceRef = useRef<File | null>(null)
  const generatedTaskId =
    generatedVideo?.status === 'succeeded' ? generatedVideo.taskId : null
  const generatedVideoUrl =
    generatedVideoPreview?.taskId === generatedTaskId
      ? generatedVideoPreview.url
      : ''

  function getVideoUrl(file: File): string {
    let url = videoUrlsRef.current.get(file)
    if (!url) {
      url = URL.createObjectURL(file)
      videoUrlsRef.current.set(file, url)
    }
    return url
  }

  useEffect(() => {
    let active = true
    const refreshStatus = () => {
      void loadAiServiceStatus()
        .then(status => {
          if (!active) return
          setAiServiceStatus(status)
          if (
            !providerPreferenceLoadedRef.current &&
            ['auto', 'gemini', 'groq'].includes(status.providers?.selected || '')
          ) {
            setAiProviderPreference(status.providers?.selected as AiProviderPreference)
            providerPreferenceLoadedRef.current = true
          }
          setAiServiceError('')
        })
        .catch(error => {
          console.error('AI service status could not be loaded:', error)
          if (active) {
            setAiServiceError(
              error instanceof Error ? error.message : 'AI services are unavailable.',
            )
          }
        })
    }

    refreshStatus()
    const interval = window.setInterval(refreshStatus, 30000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [cloudUser])

  useEffect(() => {
    if (!generatedTaskId) return
    let active = true
    let objectUrl = ''
    void authorizedApiFetch(
      `/api/ai/generate/${encodeURIComponent(generatedTaskId)}/content`,
    ).then(async response => {
      if (!response.ok) throw new Error(`Generated video could not be loaded (${response.status}).`)
      objectUrl = URL.createObjectURL(await response.blob())
      if (active) setGeneratedVideoPreview({ taskId: generatedTaskId, url: objectUrl })
      else URL.revokeObjectURL(objectUrl)
    }).catch(error => {
      if (active) {
        console.error('Generated video preview could not be loaded:', error)
        setEditorMessage(error instanceof Error ? error.message : 'Generated video could not be loaded.')
      }
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [generatedTaskId])

  useEffect(() => {
    if (!activeProject || !projectReady) return

    let cloudTimeout: number | undefined
    const timeout = window.setTimeout(() => {
      const stored: StoredProject = {
        ...activeProject,
        cloudRevision: cloudRevisionsRef.current.get(activeProject.id) || 0,
        videoFile,
        videoDuration,
        playheadTime,
        musicFile,
        musicAttribution,
        musicDuration,
        musicTimelineStart,
        musicSourceStart,
        musicSourceEnd,
        musicVolume,
        videoVolume,
        timelineClips,
        videoAssets,
        lookPreset,
        titleText,
        titleStyle,
        titlePosition,
        titleColor,
        transitionStyle,
        transitionDuration,
        brightness,
        contrast,
        saturation,
      }

      void saveProject(stored).then(() => {
        if (!cloudUser || !cloudSyncEnabled) return
        cloudTimeout = window.setTimeout(() => {
          void syncProjectToCloud(stored, mediaSyncEnabled, (filename, uploaded, total) => {
            const percent = total > 0 ? Math.round((uploaded / total) * 100) : 0
            setCloudSyncMessage(`Uploading ${filename} · ${percent}%`)
          }).then(async result => {
            cloudRevisionsRef.current.set(activeProject.id, result.revision)
            const latest = await loadProject(activeProject.id)
            if (latest) {
              await saveProject({
                ...latest,
                cloudRevision: result.revision,
                cloudMedia: result.project.cloudMedia,
              })
            }
            setCloudSyncMessage(`${activeProject.name} synced to cloud (revision ${result.revision}).`)
          }).catch(error => {
            console.error('Cloud project sync failed:', error)
            setCloudSyncMessage(
              error instanceof Error ? error.message : 'Cloud sync failed; local changes were retained.',
            )
          })
        }, 1500)
      }).catch(error => {
        console.error('Project could not be saved:', error)
        setEditorMessage('Project changes could not be saved in this browser.')
      })
    }, 300)

    return () => {
      window.clearTimeout(timeout)
      if (cloudTimeout !== undefined) window.clearTimeout(cloudTimeout)
    }
  }, [
    activeProject,
    projectReady,
    cloudUser,
    cloudSyncEnabled,
    mediaSyncEnabled,
    videoFile,
    videoDuration,
    playheadTime,
    musicFile,
    musicAttribution,
    musicDuration,
    musicTimelineStart,
    musicSourceStart,
    musicSourceEnd,
    musicVolume,
    videoVolume,
    timelineClips,
    videoAssets,
    lookPreset,
    titleText,
    titleStyle,
    titlePosition,
    titleColor,
    transitionStyle,
    transitionDuration,
    brightness,
    contrast,
    saturation,
  ])

  async function persistActiveProject() {
    if (!activeProject) return

    const stored: StoredProject = {
      ...activeProject,
      cloudRevision: cloudRevisionsRef.current.get(activeProject.id) || 0,
      videoFile,
      videoDuration,
      playheadTime,
      musicFile,
      musicAttribution,
      musicDuration,
      musicTimelineStart,
      musicSourceStart,
      musicSourceEnd,
      musicVolume,
      videoVolume,
      timelineClips,
      videoAssets,
      lookPreset,
      titleText,
      titleStyle,
      titlePosition,
      titleColor,
      transitionStyle,
      transitionDuration,
      brightness,
      contrast,
      saturation,
    }

    await saveProject(stored)
  }

  async function exitEditor() {
    try {
      await persistActiveProject()
      setActiveProject(null)
      setProjectReady(false)
    } catch (error) {
      console.error('Project could not be saved before closing:', error)
      setEditorMessage('Project could not be saved. Keep editing and try again.')
    }
  }

  useEffect(() => {
    const urls = videoUrlsRef.current
    return () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url)
      }
      urls.clear()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (musicUrl) URL.revokeObjectURL(musicUrl)
    }
  }, [musicUrl])

  useEffect(() => {
    const video = videoElementRef.current
    const audio = audioElementRef.current

    if (video) video.volume = Math.min(1, videoVolume)
    if (audio) audio.volume = Math.min(1, musicVolume)
  }, [videoVolume, musicVolume, videoUrl, musicUrl])

  function resetEditor() {
    videoRevisionRef.current += 1
    generationRequestRef.current += 1
    musicMatchRequestRef.current += 1
    setVideoFile(null)
    setVideoUrl('')
    setVideoName('')
    setVideoDuration(0)
    setVideoAssets([])
    setPlayheadTime(0)
    setMusicFile(null)
    setMusicAttribution(null)
    setMusicUrl('')
    setMusicName('')
    setMusicDuration(0)
    setMusicTimelineStart(0)
    setMusicSourceStart(0)
    setMusicSourceEnd(0)
    setMusicVolume(0.8)
    setVideoVolume(1)
    setMusicRecommendations([])
    setMusicMatchReason('')
    setMusicRecommendationsError('')
    setMusicRecommendationsLoading(false)
    setAiToolResult(null)
    setAiToolError('')
    setAiToolLoading(false)
    setTimelineClips([])
    setSelectedClipId(null)
    setLookPreset('none')
    setTitleText('')
    setTitleStyle('bold')
    setTitlePosition('bottom')
    setTitleColor('#ffffff')
    setTransitionStyle('cut')
    setTransitionDuration(0.35)
    setBrightness(0)
    setContrast(1)
    setSaturation(1)
    setPendingAiPlan(null)
    setGeneratedVideo(null)
    setAiMediaConsent(false)
    setAssistantLoading(false)
    playheadClipIndexRef.current = 0
    setEditorMessage('')
    for (const url of videoUrlsRef.current.values()) {
      URL.revokeObjectURL(url)
    }
    videoUrlsRef.current.clear()
  }

  function openEditor(project?: Project, createNew = false) {
    const isNewProject = !project || createNew
    const nextProject = project ?? {
      id: createProjectId(),
      name: 'Untitled project',
      updated: 'Just now',
    }

    let projectListSaveFailed = false
    if (isNewProject) {
      cloudRevisionsRef.current.set(nextProject.id, 0)
      const nextProjects = [...projects, nextProject]
      setProjects(nextProjects)
      try {
        localStorage.setItem('studiocut-project-list', JSON.stringify(nextProjects))
      } catch (error) {
        console.error('Project list could not be saved:', error)
        projectListSaveFailed = true
      }
    }
    setShowCreate(false)

    if (isNewProject) {
      resetEditor()
      setActiveProject(nextProject)
      setProjectReady(true)
      if (projectListSaveFailed) {
        setEditorMessage('Your project list could not be saved in this browser.')
      }
      return
    }

    setProjectReady(false)
    void loadProject(project.id).then(stored => {
      resetEditor()

      if (stored) {
        cloudRevisionsRef.current.set(project.id, stored.cloudRevision || 0)
        const restoredAssets =
          stored.videoAssets?.length
            ? stored.videoAssets
            : [
                ...new Map(
                  [
                    ...stored.timelineClips.map(clip => ({
                      file: clip.file,
                      duration: stored.videoDuration,
                    })),
                    ...(stored.videoFile
                      ? [{ file: stored.videoFile, duration: stored.videoDuration }]
                      : []),
                  ].map(asset => [asset.file, asset]),
                ).values(),
              ]
        setVideoAssets(restoredAssets)
        const restoredPosition = timelinePositionToSourceTime(
          stored.timelineClips,
          stored.playheadTime,
        )
        const restoredClip = restoredPosition
          ? stored.timelineClips[restoredPosition.clipIndex]
          : stored.timelineClips[0]
        const primaryAsset =
          restoredAssets.find(asset => asset.file === restoredClip?.file) ??
          restoredAssets[0]
        setVideoFile(primaryAsset?.file ?? null)
        setVideoUrl(primaryAsset ? getVideoUrl(primaryAsset.file) : '')
        setVideoName(primaryAsset?.file.name ?? '')
        setVideoDuration(primaryAsset?.duration ?? stored.videoDuration)
        playheadClipIndexRef.current = restoredPosition?.clipIndex ?? 0
        pendingPreviewRef.current = restoredPosition
          ? { time: restoredPosition.sourceTime, resume: false }
          : null
        setPlayheadTime(stored.playheadTime)
        setMusicFile(stored.musicFile)
        setMusicAttribution(stored.musicAttribution ?? null)
        setMusicUrl(stored.musicFile ? URL.createObjectURL(stored.musicFile) : '')
        setMusicName(stored.musicFile?.name ?? '')
        setMusicDuration(stored.musicDuration)
        setMusicTimelineStart(
          Math.min(
            stored.musicTimelineStart,
            Math.max(0, timelineDuration(stored.timelineClips) - 0.1),
          ),
        )
        setMusicSourceStart(stored.musicSourceStart)
        setMusicSourceEnd(stored.musicSourceEnd)
        setMusicVolume(stored.musicVolume)
        setVideoVolume(stored.videoVolume)
        setTimelineClips(stored.timelineClips)
        setSelectedClipId(stored.timelineClips[0]?.id ?? null)
        setLookPreset(
          LOOK_PRESETS.includes(stored.lookPreset ?? 'none')
            ? stored.lookPreset ?? 'none'
            : 'none',
        )
        setTitleText(typeof stored.titleText === 'string' ? stored.titleText : '')
        setTitleStyle(
          stored.titleStyle === 'outline' || stored.titleStyle === 'neon'
            ? stored.titleStyle
            : 'bold',
        )
        setTitlePosition(
          stored.titlePosition === 'top' || stored.titlePosition === 'center'
            ? stored.titlePosition
            : 'bottom',
        )
        setTitleColor(
          typeof stored.titleColor === 'string' &&
            /^#[0-9a-f]{6}$/i.test(stored.titleColor)
            ? stored.titleColor
            : '#ffffff',
        )
        setTransitionStyle(
          VIDEO_TRANSITIONS.includes(stored.transitionStyle ?? 'cut')
            ? stored.transitionStyle ?? 'cut'
            : 'cut',
        )
        setTransitionDuration(
          typeof stored.transitionDuration === 'number' &&
            Number.isFinite(stored.transitionDuration)
            ? Math.max(0.1, Math.min(1.5, stored.transitionDuration))
            : 0.35,
        )
        setBrightness(
          typeof stored.brightness === 'number' &&
            Number.isFinite(stored.brightness)
            ? Math.max(-1, Math.min(1, stored.brightness))
            : 0,
        )
        setContrast(
          typeof stored.contrast === 'number' &&
            Number.isFinite(stored.contrast)
            ? Math.max(0, Math.min(2, stored.contrast))
            : 1,
        )
        setSaturation(
          typeof stored.saturation === 'number' &&
            Number.isFinite(stored.saturation)
            ? Math.max(0, Math.min(3, stored.saturation))
            : 1,
        )
      }

      setActiveProject(project)
      setProjectReady(true)
      setEditorMessage(stored ? 'Project loaded.' : '')
    }).catch(error => {
      console.error('Project could not be loaded:', error)
      resetEditor()
      setActiveProject(project)
      setProjectReady(true)
      setEditorMessage('Project data could not be loaded from this browser.')
    })
  }

  function createProject() {
    const name = projectName.trim()
    if (!name) return

    openEditor({ id: createProjectId(), name, updated: 'Just now' }, true)
    setProjectName('')
  }

  function setCloudSyncPreference(enabled: boolean) {
    setCloudSyncEnabled(enabled)
    localStorage.setItem('studiocut-cloud-sync-enabled', String(enabled))
    if (!enabled) setCloudSyncMessage('Automatic cloud sync is paused. Local changes are still saved.')
  }

  function setMediaSyncPreference(enabled: boolean) {
    setMediaSyncEnabled(enabled)
    localStorage.setItem('studiocut-cloud-media-enabled', String(enabled))
  }

  const syncAllLocalProjects = useCallback(async () => {
    const storedProjects = await listStoredProjects()
    const failures: string[] = []
    for (const project of storedProjects) {
      try {
        const result = await syncProjectToCloud(
          project,
          mediaSyncEnabled,
          (filename, uploaded, total) => {
            const percent = total > 0 ? Math.round((uploaded / total) * 100) : 0
            setCloudSyncMessage(`Uploading ${project.name} · ${filename} · ${percent}%`)
          },
        )
        cloudRevisionsRef.current.set(project.id, result.revision)
        const latest = await loadProject(project.id)
        await saveProject({
          ...(latest || project),
          cloudRevision: result.revision,
          cloudMedia: result.project.cloudMedia,
        })
      } catch (error) {
        failures.push(
          `${project.name}: ${error instanceof Error ? error.message : 'sync failed'}`,
        )
      }
    }
    if (failures.length) throw new Error(failures.join(' · '))
    setCloudSyncMessage(`Synced ${storedProjects.length} local project(s).`)
  }, [mediaSyncEnabled])

  useEffect(() => {
    if (!cloudUser || !cloudSyncEnabled) return
    const syncWhenOnline = () => {
      void syncAllLocalProjects().catch(error => {
        setCloudSyncMessage(
          error instanceof Error ? error.message : 'Cloud sync retry failed.',
        )
      })
    }
    window.addEventListener('online', syncWhenOnline)
    return () => window.removeEventListener('online', syncWhenOnline)
  }, [cloudUser, cloudSyncEnabled, syncAllLocalProjects])

  async function openCloudProject(
    restored: Awaited<ReturnType<typeof restoreCloudProject>>,
  ) {
    const project = restored.project
    const existing = projects.find(item => item.id === project.id)
    if (existing && !window.confirm(
      `A local project named "${existing.name}" already uses this ID. Replace its local copy with cloud revision ${restored.revision}?`,
    )) return
    await saveProject(project)
    const summary = { id: project.id, name: project.name, updated: project.updated }
    const nextProjects = [
      summary,
      ...projects.filter(item => item.id !== project.id),
    ]
    setProjects(nextProjects)
    localStorage.setItem('studiocut-project-list', JSON.stringify(nextProjects))
    cloudRevisionsRef.current.set(project.id, restored.revision)
    openEditor(summary)
  }

  async function importVideos(files: File[], replace = false) {
    if (files.length === 0) return
    videoRevisionRef.current += 1
    const revision = videoRevisionRef.current
    pendingPreviewRef.current = null
    setPendingAiPlan(null)
    setAssistantLoading(false)
    setEditorMessage(`Loading ${files.length} video${files.length === 1 ? '' : 's'}…`)

    try {
      const importedAssets: VideoAsset[] = []
      for (const file of files) {
        if (!file.type.startsWith('video/') || file.size === 0) {
          throw new Error(`${file.name} is not a valid video file.`)
        }
        const url = getVideoUrl(file)
        const duration = await readVideoDuration(url)
        importedAssets.push({ file, duration })
      }
      if (revision !== videoRevisionRef.current) return

      const existingAssets = new Map(
        (replace ? [] : videoAssets).map(asset => [asset.file, asset]),
      )
      const nextAssets = [...existingAssets.values()]
      for (const asset of importedAssets) {
        if (!existingAssets.has(asset.file)) nextAssets.push(asset)
      }
      const appendedClips = importedAssets.map(asset =>
        createTimelineClip(asset.file, asset.duration),
      )
      const firstAsset = importedAssets[0]
      const firstClip = appendedClips[0]
      const nextClips = [...(replace ? [] : timelineClips), ...appendedClips]
      setVideoAssets(nextAssets)
      setTimelineClips(nextClips)
      setVideoFile(replace ? firstAsset.file : videoFile ?? firstAsset.file)
      setVideoUrl(getVideoUrl(firstAsset.file))
      setVideoName(firstAsset.file.name)
      setVideoDuration(firstAsset.duration)
      setSelectedClipId(firstClip.id)
      playheadClipIndexRef.current = nextClips.indexOf(firstClip)
      const position = timelinePositionForClip(nextClips, nextClips.indexOf(firstClip))
      setPlayheadTime(position)
      setMusicTimelineStart(current =>
        Math.min(current, Math.max(0, timelineDuration(nextClips) - 0.1)),
      )
      setEditorMessage(
        `${importedAssets.length} video${importedAssets.length === 1 ? '' : 's'} added to the media library and timeline.`,
      )
    } catch (error) {
      console.error('Video import failed:', error)
      setEditorMessage(
        error instanceof Error ? `Video import failed: ${error.message}` : 'Video import failed.',
      )
    }
  }

  function importVideo(file?: File) {
    if (!file) return
    void importVideos([file], true)
  }

  function addAssetToTimeline(asset: VideoAsset) {
    const clip = createTimelineClip(asset.file, asset.duration)
    const nextClips = [...timelineClips, clip]
    setTimelineClips(nextClips)
    setSelectedClipId(clip.id)
    playheadClipIndexRef.current = nextClips.length - 1
    const nextPosition = timelinePositionForClip(nextClips, nextClips.length - 1)
    setPlayheadTime(nextPosition)
    showClip(clip, clip.sourceStart, false)
    setEditorMessage(`${asset.file.name} added to the timeline.`)
  }

  function sourceDuration(file: File): number {
    return videoAssets.find(asset => asset.file === file)?.duration ??
      (file === videoFile ? videoDuration : 0)
  }

  function showClip(clip: TimelineClip, sourceTime: number, resume: boolean) {
    const url = getVideoUrl(clip.file)
    setVideoName(clip.name)
    setVideoDuration(sourceDuration(clip.file) || clip.sourceEnd)
    if (url !== videoUrl) {
      pendingPreviewRef.current = { time: sourceTime, resume }
      setVideoUrl(url)
      return
    }

    const video = videoElementRef.current
    if (video && Math.abs(video.currentTime - sourceTime) > 0.03) {
      video.currentTime = sourceTime
    }
    if (resume && video?.paused) {
      void video.play().catch(error => {
        console.error('Video preview could not continue:', error)
        setEditorMessage('Press Play to continue previewing the next clip.')
      })
    }
  }

  function importMusic(file?: File) {
    if (!file) return

    setMusicFile(file)
    setMusicAttribution(null)
    setMusicName(file.name)
    setMusicUrl(URL.createObjectURL(file))
    setMusicDuration(0)
    setMusicTimelineStart(0)
    setMusicSourceStart(0)
    setMusicSourceEnd(0)
    setEditorMessage(
      'Music imported. Drag its clip to position it, or drag its edges to trim.',
    )
  }

  function timeFromMouse(
    clientX: number,
    lane: HTMLDivElement | null,
    scale = timelineDuration(timelineClips) || videoDuration,
  ) {
    if (!lane || scale <= 0) return 0

    const rect = lane.getBoundingClientRect()
    if (rect.width <= 0) return 0

    const fraction = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / rect.width),
    )

    return fraction * scale
  }

  function seekTo(time: number) {
    const totalDuration = timelineDuration(timelineClips)
    const safeTime = Math.max(0, Math.min(totalDuration || videoDuration, time))
    setPlayheadTime(safeTime)

    const position = timelinePositionToSourceTime(timelineClips, safeTime)
    if (position) {
      playheadClipIndexRef.current = position.clipIndex
      const clip = timelineClips[position.clipIndex]
      setSelectedClipId(clip.id)
      showClip(
        clip,
        position.sourceTime,
        videoElementRef.current?.paused === false,
      )
    } else if (videoElementRef.current) {
      videoElementRef.current.currentTime = Math.min(videoDuration, safeTime)
    }

    syncMusic(safeTime, videoElementRef.current?.paused === false)
  }

  function startTimelineDrag(
    event: React.PointerEvent<HTMLDivElement | HTMLButtonElement>,
    mode: TimelineDrag['mode'],
    clipId?: string,
  ) {
    event.preventDefault()
    event.stopPropagation()

    const scale = timelineDuration(timelineClips) || videoDuration
    if (scale <= 0) return

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture may not be available in every browser context.
    }

    const pointerStartTime = timeFromMouse(
      event.clientX,
      mode.startsWith('music-') ? musicLaneRef.current : timelineLaneRef.current,
      scale,
    )

    if (mode === 'playhead') {
      dragModeRef.current = { mode }
      const time = pointerStartTime
      seekTo(time)
      return
    }

    if (mode === 'video-start' || mode === 'video-end') {
      if (!clipId) return
      const clip = timelineClips.find(item => item.id === clipId)
      if (!clip) return
      setSelectedClipId(clipId)
      dragModeRef.current = {
        mode,
        clipId,
        pointerStartTime,
        timelineScale: scale,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
      }
      return
    }

    dragModeRef.current = {
      mode,
      pointerStartTime,
      timelineScale: scale,
      timelineStart: musicTimelineStart,
      sourceStart: musicSourceStart,
      sourceEnd: musicSourceEnd,
    }
  }

  function moveTimelineDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragModeRef.current
    if (!drag) return

    if (drag.mode === 'playhead') {
      seekTo(timeFromMouse(event.clientX, timelineLaneRef.current))
      return
    }

    const lane = drag.mode.startsWith('music-')
      ? musicLaneRef.current
      : timelineLaneRef.current
    const time = timeFromMouse(event.clientX, lane, drag.timelineScale)

    if (drag.mode === 'video-start' || drag.mode === 'video-end') {
      const delta = time - drag.pointerStartTime
      const nextClips = timelineClips.map(clip => {
          if (clip.id !== drag.clipId) return clip
          if (drag.mode === 'video-start') {
            return {
              ...clip,
              sourceStart: Math.max(
                0,
                Math.min(drag.sourceStart + delta, drag.sourceEnd - 0.1),
              ),
            }
          }
          return {
            ...clip,
            sourceEnd: Math.min(
              sourceDuration(clip.file),
              Math.max(drag.sourceStart + 0.1, drag.sourceEnd + delta),
            ),
          }
        })
      setTimelineClips(nextClips)
      setMusicTimelineStart(current =>
        Math.min(current, Math.max(0, timelineDuration(nextClips) - 0.1)),
      )
      return
    }

    if (drag.mode === 'music-move') {
      setMusicTimelineStart(
        Math.max(
          0,
          Math.min(
            drag.timelineScale - 0.1,
            drag.timelineStart + time - drag.pointerStartTime,
          ),
        ),
      )
    } else if (drag.mode === 'music-start') {
      const delta = time - drag.pointerStartTime
      const desiredTimelineStart = Math.max(
        0,
        Math.min(
          drag.timelineScale - 0.1,
          drag.timelineStart + delta,
        ),
      )
      const nextSourceStart = Math.max(
        0,
        Math.min(
          drag.sourceStart + desiredTimelineStart - drag.timelineStart,
          drag.sourceEnd - 0.1,
        ),
      )
      setMusicSourceStart(nextSourceStart)
      setMusicTimelineStart(
        Math.max(0, drag.timelineStart + nextSourceStart - drag.sourceStart),
      )
    } else {
      setMusicSourceEnd(
        Math.min(
          musicDuration,
          Math.max(drag.sourceStart + 0.1, drag.sourceEnd + time - drag.pointerStartTime),
        ),
      )
    }
  }

  function stopTimelineDrag() {
    dragModeRef.current = null
  }

  function formatTime(seconds: number) {
    const safe = Math.max(0, seconds || 0)
    const minutes = Math.floor(safe / 60)
    const secs = Math.floor(safe % 60)
    const frames = Math.floor((safe % 1) * 100)

    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(frames).padStart(2, '0')}`
  }

  function syncMusic(timelineTime: number, shouldPlay = false) {
    const audio = audioElementRef.current
    if (!audio || !musicFile || musicSourceEnd <= musicSourceStart) return

    const musicTimelineEnd =
      musicTimelineStart + musicSourceEnd - musicSourceStart

    if (
      timelineTime < musicTimelineStart ||
      timelineTime >= musicTimelineEnd
    ) {
      audio.pause()
      return
    }

    const sourceTime =
      musicSourceStart + timelineTime - musicTimelineStart
    if (Math.abs(audio.currentTime - sourceTime) > 0.35) {
      audio.currentTime = sourceTime
    }

    if (shouldPlay && audio.paused) {
      audio.volume = Math.min(1, musicVolume)
      void audio.play().catch(error => {
        console.error('Music preview could not play:', error)
        setEditorMessage(
          'The music could not start. Press Play again to allow browser audio playback.',
        )
      })
    }
  }

  function handleVideoTimeUpdate(currentTime: number) {
    if (timelineClips.length === 0) {
      setPlayheadTime(currentTime)
      return
    }

    const clipIndex = Math.min(
      playheadClipIndexRef.current,
      timelineClips.length - 1,
    )
    const clip = timelineClips[clipIndex]

    if (currentTime >= clip.sourceEnd - 0.04) {
      if (clipIndex < timelineClips.length - 1) {
        const nextIndex = clipIndex + 1
        const nextClip = timelineClips[nextIndex]
        playheadClipIndexRef.current = nextIndex
        setPlayheadTime(timelinePositionForClip(timelineClips, nextIndex))
        setSelectedClipId(nextClip.id)
        showClip(
          nextClip,
          nextClip.sourceStart,
          videoElementRef.current?.paused === false,
        )
        syncMusic(timelinePositionForClip(timelineClips, nextIndex), true)
        return
      }

      const end = timelineDuration(timelineClips)
      setPlayheadTime(end)
      videoElementRef.current?.pause()
      audioElementRef.current?.pause()
      return
    }

    const timelineTime =
      timelinePositionForClip(timelineClips, clipIndex) +
      Math.max(0, currentTime - clip.sourceStart)
    setPlayheadTime(timelineTime)
    syncMusic(timelineTime, videoElementRef.current?.paused === false)
  }

  function handleVideoMetadata(duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) return

    setVideoDuration(duration)
    const clip = timelineClips[playheadClipIndexRef.current]
    if (clip) {
      setVideoName(clip.name)
      const asset = videoAssets.find(item => item.file === clip.file)
      if (asset && Math.abs(asset.duration - duration) > 0.1) {
        setVideoAssets(current =>
          current.map(item =>
            item.file === clip.file ? { ...item, duration } : item,
          ),
        )
      }
    }
    const pending = pendingPreviewRef.current ??
      (clip ? { time: clip.sourceStart, resume: false } : null)
    if (pending) {
      pendingPreviewRef.current = null
    }
    if (pending && videoElementRef.current) {
      videoElementRef.current.currentTime = Math.min(duration, pending.time)
      if (pending.resume) {
        void videoElementRef.current.play().catch(error => {
          console.error('Video preview could not continue:', error)
          setEditorMessage('Press Play to continue previewing the next clip.')
        })
      }
    }

    setEditorMessage('Video is ready for editing.')
  }

  function handleVideoPlay() {
    const video = videoElementRef.current
    if (!video) return

    const position = timelinePositionToSourceTime(
      timelineClips,
      playheadTime,
    )
    if (position) {
      playheadClipIndexRef.current = position.clipIndex
      const clip = timelineClips[position.clipIndex]
      if (
        video.src !== getVideoUrl(clip.file) ||
        video.currentTime < clip.sourceStart ||
        video.currentTime >= clip.sourceEnd
      ) {
        showClip(clip, position.sourceTime, true)
      }
    }

    syncMusic(playheadTime, true)
  }

  function handleVideoPause() {
    audioElementRef.current?.pause()
  }

  function handleVideoEnded() {
    audioElementRef.current?.pause()
  }

  function splitSelectedClip() {
    if (!selectedClipId || timelineClips.length === 0) {
      setEditorMessage('Select a timeline clip before splitting.')
      return
    }

    const clipIndex = timelineClips.findIndex(
      clip => clip.id === selectedClipId,
    )

    if (clipIndex < 0) {
      setEditorMessage('The selected clip could not be found.')
      return
    }

    let clipTimelineStart = 0
    for (let index = 0; index < clipIndex; index++) {
      clipTimelineStart +=
        timelineClips[index].sourceEnd - timelineClips[index].sourceStart
    }

    const selectedClip = timelineClips[clipIndex]
    const selectedDuration =
      selectedClip.sourceEnd - selectedClip.sourceStart
    const splitTime = playheadTime

    if (
      splitTime <= clipTimelineStart + 0.05 ||
      splitTime >= clipTimelineStart + selectedDuration - 0.05
    ) {
      setEditorMessage(
        'Move the playhead inside the selected clip, away from its edges, and try splitting again.',
      )
      return
    }

    const nextClips = splitClipAt(
      timelineClips,
      selectedClipId,
      splitTime,
    )

    setTimelineClips(nextClips)

    const nextClip =
      nextClips[Math.min(clipIndex + 1, nextClips.length - 1)]

    setSelectedClipId(nextClip?.id ?? null)
    playheadClipIndexRef.current = Math.min(clipIndex + 1, nextClips.length - 1)
    setEditorMessage('Clip split on the timeline.')
  }

  function deleteSelectedClip() {
    if (!selectedClipId) {
      setEditorMessage('Select a timeline clip to delete.')
      return
    }

    const nextClips = deleteClip(timelineClips, selectedClipId)
    setTimelineClips(nextClips)
    setMusicTimelineStart(current =>
      Math.min(current, Math.max(0, timelineDuration(nextClips) - 0.1)),
    )
    setSelectedClipId(nextClips[0]?.id ?? null)
    playheadClipIndexRef.current = Math.max(
      0,
      Math.min(
        timelineClips.findIndex(clip => clip.id === selectedClipId),
        nextClips.length - 1,
      ),
    )
    setEditorMessage(
      nextClips.length
        ? 'Selected timeline clip deleted.'
        : 'Timeline cleared. Import a video to add a clip.',
    )
  }

  function duplicateSelectedClip() {
    if (!selectedClipId) {
      setEditorMessage('Select a timeline clip to duplicate.')
      return
    }

    const nextClips = duplicateClip(timelineClips, selectedClipId)
    setTimelineClips(nextClips)

    const oldIndex = nextClips.findIndex(
      clip => clip.id === selectedClipId,
    )
    const duplicate = nextClips[oldIndex + 1]

    setSelectedClipId(duplicate?.id ?? selectedClipId)
    playheadClipIndexRef.current = Math.max(0, oldIndex + 1)
    setEditorMessage('Timeline clip duplicated.')
  }

  function moveSelectedClip(direction: -1 | 1) {
    if (!selectedClipId) {
      setEditorMessage('Select a timeline clip to move.')
      return
    }

    const fromIndex = timelineClips.findIndex(
      clip => clip.id === selectedClipId,
    )
    const toIndex = fromIndex + direction

    if (fromIndex < 0 || toIndex < 0 || toIndex >= timelineClips.length) {
      setEditorMessage('The clip cannot move any further in that direction.')
      return
    }

    const nextClips = moveClip(timelineClips, fromIndex, toIndex)
    setTimelineClips(nextClips)
    playheadClipIndexRef.current = nextClips.findIndex(
      clip => clip.id === selectedClipId,
    )
    setEditorMessage('Timeline clip order updated.')
  }

  function updateSelectedClipRange(sourceStart: number, sourceEnd: number) {
    const index = timelineClips.findIndex(clip => clip.id === selectedClipId)
    if (index < 0) return

    const clip = timelineClips[index]
    const nextStart = Math.max(
      0,
      Math.min(sourceStart, clip.sourceEnd - 0.1),
    )
    const nextEnd = Math.min(
      sourceDuration(clip.file),
      Math.max(nextStart + 0.1, sourceEnd),
    )

    const nextClips = timelineClips.map(item =>
        item.id === clip.id
          ? { ...item, sourceStart: nextStart, sourceEnd: nextEnd }
          : item,
    )
    setTimelineClips(nextClips)
    setMusicTimelineStart(current =>
      Math.min(current, Math.max(0, timelineDuration(nextClips) - 0.1)),
    )
    playheadClipIndexRef.current = index
    setPlayheadTime(timelinePositionForClip(timelineClips, index))
    if (videoElementRef.current) {
      videoElementRef.current.currentTime = nextStart
    }
  }

  async function handleExport() {
    if (!videoFile) {
      setEditorMessage('Please import a video before exporting.')
      return
    }

    if (timelineClips.length === 0) {
      setEditorMessage('Add at least one video clip to the timeline before exporting.')
      return
    }

    setExporting(true)
    setExportProgress(0)
    setEditorMessage(
      'Loading video renderer. The first export may take a while…',
    )

    try {
      const blob = await exportVideo(videoFile, {
        segments: timelineClips.map(clip => ({
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
          file: clip.file,
        })),
        look: lookPreset,
        transition: transitionStyle,
        transitionDuration,
        brightness,
        contrast,
        saturation,
        titleOverlay: await renderTitleOverlay({
          text: titleText,
          style: titleStyle,
          position: titlePosition,
          color: titleColor,
        }),
        musicFile,
        musicStart: musicTimelineStart,
        musicSourceStart,
        musicSourceEnd,
        videoVolume,
        musicVolume,
        onProgress: progress => {
          setExportProgress(progress)
          setEditorMessage(`Exporting video: ${Math.round(progress)}%`)
        },
      })

      const downloadUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeName = (activeProject?.name || 'studiocut-edit')
        .replace(/[<>:"/\\|?*]/g, '-')

      link.href = downloadUrl
      link.download = `${safeName}.mp4`
      document.body.appendChild(link)
      link.click()
      link.remove()

      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000)
      setEditorMessage('Export finished. Check your Downloads folder.')
    } catch (error) {
      console.error('Video export failed:', error)
      setEditorMessage(
        error instanceof Error
          ? `Export failed: ${error.message}`
          : 'Export failed. Check the browser console for details.',
      )
    } finally {
      setExporting(false)
    }
  }

  async function sendAssistantMessage() {
    const message = assistantPrompt.trim()
    if (!message || assistantLoading) return
    if (!videoFile || !videoUrl || videoDuration <= 0) {
      setEditorMessage('Import a video and wait for its duration before asking AI to edit it.')
      return
    }
    if (!aiServiceStatus.editingEnabled) {
      const detail = aiServiceError ||
        'AI is not configured on the backend. Add GEMINI_API_KEY or GROQ_API_KEY to .env.local, then restart the API server.'
      setAssistantMessages(current => [...current, `StudioCut: ${detail}`])
      setEditorMessage(detail)
      return
    }
    if (!aiMediaConsent) {
      const detail = 'Enable the video-analysis permission above before sending sample frames to the AI provider.'
      setAssistantMessages(current => [...current, `StudioCut: ${detail}`])
      setEditorMessage(detail)
      return
    }
    const videoRevision = videoRevisionRef.current
    pendingAiSourceRef.current =
      timelineClips[playheadClipIndexRef.current]?.file ?? videoFile

    setAssistantMessages(current => [
      ...current,
      `You: ${message}`,
    ])
    setPendingAiPlan(null)
    setAssistantLoading(true)
    try {
      const frames = await captureVideoFrames(videoUrl, videoDuration)
      if (videoRevision !== videoRevisionRef.current) return
      const plan = await requestEditPlan(
        message,
        videoDuration,
        frames,
        aiProviderPreference,
      )
      if (videoRevision !== videoRevisionRef.current) return
      setPendingAiPlan(plan)
      setAssistantPrompt(current => current === message ? '' : current)
      setAssistantMessages(current => [
        ...current,
        `StudioCut (${plan.provider || 'AI'}): ${plan.summary} Review the proposed cuts and apply them when you're ready.`,
      ])
    } catch (error) {
      if (videoRevision !== videoRevisionRef.current) return
      console.error('AI edit request failed:', error)
      const detail =
        error instanceof Error ? error.message : 'AI could not create an edit plan.'
      setAssistantMessages(current => [...current, `StudioCut: ${detail}`])
      setEditorMessage(detail)
    } finally {
      if (videoRevision === videoRevisionRef.current) {
        setAssistantLoading(false)
      }
    }
  }

  async function runAiTool(task: AiToolName) {
    if (!videoFile || !videoUrl || videoDuration <= 0 || aiToolLoading) {
      setAiToolError('Import a video and wait for its duration before using AI tools.')
      return
    }
    if (!aiMediaConsent) {
      setAiToolError('Allow video-content sharing in the AI panel before sending media to a cloud AI provider.')
      return
    }
    const revision = videoRevisionRef.current
    setAiToolLoading(true)
    setAiToolError('')
    setAiToolResult(null)
    try {
      if (task === 'captions') {
        if (videoDuration > 480) {
          throw new Error('Speech captions are limited to videos up to 8 minutes.')
        }
        const audio = await extractAudio(videoFile)
        if (audio.size > 16 * 1024 * 1024) {
          throw new Error('Extracted audio is over the 16 MB free-tier request limit.')
        }
        if (revision !== videoRevisionRef.current) return
        const result = await transcribeAudio(
          audio,
          videoDuration,
          aiProviderPreference,
        )
        if (revision !== videoRevisionRef.current) return
        setAiToolResult({ task, provider: result.provider, captions: result.captions })
      } else {
        const frames = await captureVideoFrames(videoUrl, videoDuration)
        if (revision !== videoRevisionRef.current) return
        const result = await requestAiTool(
          task,
          assistantPrompt.trim(),
          videoDuration,
          frames,
          aiProviderPreference,
        )
        if (revision !== videoRevisionRef.current) return
        if (task === 'summary' && typeof result.summary === 'string') {
          setAiToolResult({ task, provider: result.provider, text: result.summary })
        } else if (task === 'script' && typeof result.script === 'string') {
          setAiToolResult({ task, provider: result.provider, text: result.script })
        } else if (task === 'scenes' && Array.isArray(result.scenes)) {
          const scenes = result.scenes.filter(
            (scene): scene is { timestamp: number; description: string; suggestion: string } =>
              Boolean(scene) &&
              typeof scene === 'object' &&
              'timestamp' in scene &&
              typeof scene.timestamp === 'number' &&
              'description' in scene &&
              typeof scene.description === 'string' &&
              'suggestion' in scene &&
              typeof scene.suggestion === 'string',
          )
          setAiToolResult({ task, provider: result.provider, scenes })
        } else {
          throw new Error('The AI tool returned an incomplete result.')
        }
      }
    } catch (error) {
      if (revision !== videoRevisionRef.current) return
      console.error(`AI ${task} failed:`, error)
      setAiToolError(error instanceof Error ? error.message : `AI ${task} failed.`)
    } finally {
      if (revision === videoRevisionRef.current) setAiToolLoading(false)
    }
  }

  function downloadCaptions(captions: TimedCaption[]) {
    const timestamp = (seconds: number) => {
      const milliseconds = Math.max(0, Math.round(seconds * 1000))
      const hours = Math.floor(milliseconds / 3_600_000)
      const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
      const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000)
      const remainder = milliseconds % 1000
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`
    }
    const srt = captions
      .map((caption, index) =>
        `${index + 1}\n${timestamp(caption.start)} --> ${timestamp(caption.end)}\n${caption.text}`,
      )
      .join('\n\n')
    const url = URL.createObjectURL(new Blob([srt], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${(activeProject?.name || 'studiocut-captions')
      .replace(/[<>:"/\\|?*]/g, '-')
      .slice(0, 100)}.srt`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  async function testConnection(provider: 'gemini' | 'groq' | 'jamendo') {
    setConnectionTestMessages(current => ({ ...current, [provider]: 'Testing…' }))
    try {
      const result = await testApiConnection(provider)
      setConnectionTestMessages(current => ({ ...current, [provider]: result }))
      void loadAiServiceStatus().then(setAiServiceStatus).catch(error => {
        console.error('AI service status refresh failed:', error)
      })
    } catch (error) {
      setConnectionTestMessages(current => ({
        ...current,
        [provider]: error instanceof Error ? error.message : 'Connection test failed.',
      }))
    }
  }

  async function searchMusic() {
    setMusicSearchLoading(true)
    setMusicSearchError('')
    try {
      const tracks = await searchJamendoTracks({
        query: musicSearchQuery.trim(),
        genre: musicSearchGenre,
        mood: musicSearchMood,
      })
      setJamendoTracks(tracks)
      if (!tracks.length) setMusicSearchError('No downloadable licensed tracks matched those filters.')
    } catch (error) {
      console.error('Jamendo search failed:', error)
      setMusicSearchError(error instanceof Error ? error.message : 'Jamendo search failed.')
      setJamendoTracks([])
    } finally {
      setMusicSearchLoading(false)
    }
  }

  function renderMusicTrackCards(
    tracks: Array<MusicRecommendation | JamendoTrack>,
  ) {
    return (
      <div className="music-recommendation-list">
        {tracks.map(track => (
          <article className="music-recommendation" key={track.id}>
            <div>
              <strong>{track.name}</strong>
              <span>{track.artist} · {Math.round(track.duration)}s</span>
            </div>
            <audio controls preload="none" src={track.previewUrl}>
              Audio preview unavailable in this browser.
            </audio>
            {'matchReason' in track && <p>{track.matchReason}</p>}
            <div className="music-recommendation-links">
              <a href={track.licenseUrl} target="_blank" rel="noreferrer">
                {'attributionRequired' in track && track.attributionRequired
                  ? 'License · attribution required'
                  : 'License and terms'}
              </a>
              <a href={track.shareUrl} target="_blank" rel="noreferrer">
                Track page
              </a>
            </div>
            <button
              className="gold-button"
              onClick={() => void addRecommendedTrack(track)}
            >
              Add soundtrack to timeline
            </button>
          </article>
        ))}
      </div>
    )
  }

  function applyAiPlan() {
    if (!pendingAiPlan || !videoFile || videoDuration <= 0) return

    const sourceFile = pendingAiSourceRef.current ?? videoFile
    const assetDuration = sourceDuration(sourceFile) || videoDuration
    const clips = pendingAiPlan.segments.map(segment =>
      createTimelineClip(
        sourceFile,
        assetDuration,
        segment.sourceStart,
        segment.sourceEnd,
      ),
    )
    setTimelineClips(clips)
    setSelectedClipId(clips[0]?.id ?? null)
    setLookPreset(pendingAiPlan.look)
    setMusicVolume(pendingAiPlan.musicVolume)
    if (pendingAiPlan.title) {
      setTitleText(pendingAiPlan.title.text)
      setTitleStyle(pendingAiPlan.title.style)
      setTitlePosition(pendingAiPlan.title.position)
    }
    setPlayheadTime(0)
    playheadClipIndexRef.current = 0
    if (videoElementRef.current && clips[0]) {
      videoElementRef.current.currentTime = clips[0].sourceStart
    }
    setEditorMessage('AI edit applied. Review the timeline before exporting.')
    setPendingAiPlan(null)
    pendingAiSourceRef.current = null
  }

  async function generateVideo() {
    const prompt = videoPrompt.trim()
    if (!prompt || generatedVideo?.status === 'pending' || generatedVideo?.status === 'running') {
      return
    }
    if (!aiServiceStatus.videoGenerationEnabled) {
      setEditorMessage(
        aiServiceStatus.localVideo?.message ||
          'Local video generation is unavailable. Configure a compatible ComfyUI model and workflow on this machine.',
      )
      return
    }

    const requestId = generationRequestRef.current + 1
    generationRequestRef.current = requestId
    musicMatchRequestRef.current += 1
    setGeneratedVideo(null)
    setMusicRecommendations([])
    setMusicMatchReason('')
    setMusicRecommendationsError('')
    setEditorMessage('Starting AI video generation…')
    try {
      const taskId = await createGeneratedVideo(
        prompt,
        videoRatio,
        videoGenerationDuration,
      )
      if (requestId !== generationRequestRef.current) return
      setGeneratedVideo({
        taskId,
        prompt,
        duration: videoGenerationDuration,
        status: 'pending',
        progress: 0,
      })

      for (let attempt = 0; attempt < 240; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 15000))
        if (requestId !== generationRequestRef.current) return
        const task = await readGeneratedVideoTask(taskId)
        if (requestId !== generationRequestRef.current) return
        setGeneratedVideo({
          taskId,
          prompt,
          duration: videoGenerationDuration,
          status: task.status,
          progress: task.progress,
          ...(task.error ? { error: task.error } : {}),
        })
        if (task.status === 'succeeded') {
          setEditorMessage('AI video is ready. Preview it, download it, or use it as this project’s footage.')
          return
        }
        if (task.status === 'failed') {
          throw new Error(task.error || 'The video provider could not complete this generation.')
        }
      }
      throw new Error('Video generation is taking longer than expected. Check back later.')
    } catch (error) {
      if (requestId !== generationRequestRef.current) return
      console.error('AI video generation failed:', error)
      const detail =
        error instanceof Error ? error.message : 'AI video generation failed.'
      setGeneratedVideo(current =>
        current
          ? { ...current, status: 'failed', error: detail }
          : null,
      )
      setEditorMessage(detail)
    }
  }

  async function findMatchingMusic() {
    if (!aiServiceStatus.musicRecommendationsEnabled) {
      setMusicRecommendationsError(
        'AI music matching needs a configured Gemini or Groq provider and JAMENDO_CLIENT_ID.',
      )
      return
    }
    if (!aiMediaConsent) {
      setMusicRecommendationsError('Allow video-content sharing in the AI panel before sending sample frames to a cloud AI provider.')
      return
    }
    const generated = generatedVideo?.status === 'succeeded' ? generatedVideo : null
    const sourceUrl = generated ? generatedVideoUrl : videoUrl
    const sourceDuration = generated?.duration ?? videoDuration
    const sourcePrompt = generated?.prompt || assistantPrompt.trim() ||
      'Recommend music that suits the visual footage.'
    if (!sourceUrl || sourceDuration <= 0) {
      setMusicRecommendationsError('Generate or import a video before matching its soundtrack.')
      return
    }

    const requestId = musicMatchRequestRef.current + 1
    musicMatchRequestRef.current = requestId
    setMusicRecommendations([])
    setMusicMatchReason('')
    setMusicRecommendationsError('')
    setMusicRecommendationsLoading(true)
    try {
      const frames = await captureVideoFrames(
        sourceUrl,
        sourceDuration,
      )
      if (requestId !== musicMatchRequestRef.current) return
      const result = await requestMusicRecommendations(
        sourcePrompt,
        sourceDuration,
        frames,
        aiProviderPreference,
      )
      if (requestId !== musicMatchRequestRef.current) return
      setMusicRecommendations(result.tracks)
      setMusicMatchReason(result.matchReason)
      if (result.tracks.length === 0) {
        setMusicRecommendationsError(
          'No downloadable Creative Commons tracks matched this video. Try again later.',
        )
      }
    } catch (error) {
      if (requestId !== musicMatchRequestRef.current) return
      console.error('Matching music could not be found:', error)
      setMusicRecommendationsError(
        error instanceof Error ? error.message : 'Could not find matching music.',
      )
    } finally {
      if (requestId === musicMatchRequestRef.current) {
        setMusicRecommendationsLoading(false)
      }
    }
  }

  async function addRecommendedTrack(
    track: Pick<MusicRecommendation, 'id' | 'name' | 'artist' | 'licenseUrl' | 'shareUrl'>,
  ) {
    try {
      const response = await authorizedApiFetch(
        `/api/music/tracks/${encodeURIComponent(track.id)}/audio`,
      )
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null)
        const message =
          result && typeof result === 'object' && 'error' in result &&
          typeof result.error === 'string'
            ? result.error
            : `Music download failed (${response.status}).`
        throw new Error(message)
      }
      const safeName = `${track.name} - ${track.artist}`
        .replace(/[<>:"/\\|?*]/g, '-')
        .slice(0, 160)
      const file = new File([await response.blob()], `${safeName}.mp3`, {
        type: 'audio/mpeg',
      })
      importMusic(file)
      setMusicAttribution({
        track: track.name,
        artist: track.artist,
        licenseUrl: track.licenseUrl,
        shareUrl: track.shareUrl,
      })
      setEditorMessage(
        `Added "${track.name}" to the timeline. Check its license terms before publishing.`,
      )
    } catch (error) {
      console.error('Recommended music could not be added:', error)
      setMusicRecommendationsError(
        error instanceof Error ? error.message : 'Could not add this soundtrack.',
      )
    }
  }

  async function importGeneratedVideo() {
    if (!generatedVideo || generatedVideo.status !== 'succeeded') return
    if (
      videoFile &&
      !window.confirm(
        'Replace this project’s current footage, timeline, and edits with the generated video? Export or download anything you want to keep first.',
      )
    ) {
      return
    }
    const videoRevision = videoRevisionRef.current

    try {
      const response = await authorizedApiFetch(
        `/api/ai/generate/${encodeURIComponent(generatedVideo.taskId)}/content`,
      )
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null)
        const message =
          result && typeof result === 'object' && 'error' in result &&
          typeof result.error === 'string'
            ? result.error
            : `Generated video download failed (${response.status}).`
        throw new Error(message)
      }
      const blob = await response.blob()
      const generatedType = blob.type.startsWith('video/') ? blob.type : 'video/mp4'
      const extension = generatedType === 'video/webm'
        ? 'webm'
        : generatedType === 'video/quicktime'
          ? 'mov'
          : 'mp4'
      const file = new File(
        [blob],
        `studiocut-ai-generated.${extension}`,
        { type: generatedType },
      )
      if (videoRevision !== videoRevisionRef.current) return
      importVideo(file)
      setEditorMessage('AI-generated footage added to this project.')
    } catch (error) {
      if (videoRevision !== videoRevisionRef.current) return
      console.error('Generated video could not be imported:', error)
      setEditorMessage(
        error instanceof Error
          ? `Generated video could not be imported: ${error.message}`
          : 'Generated video could not be imported.',
      )
    }
  }

  if (activeProject) {
    const sequenceDuration = timelineDuration(timelineClips)
    const timelineScale = sequenceDuration || videoDuration || 1
    const selectedClip = timelineClips.find(
      clip => clip.id === selectedClipId,
    )
    const playheadLeft = (playheadTime / timelineScale) * 100
    const musicTimelineDuration = Math.max(
      0,
      musicSourceEnd - musicSourceStart,
    )
    const musicLeft = (musicTimelineStart / timelineScale) * 100
    const musicWidth = (musicTimelineDuration / timelineScale) * 100

    return (
      <main
        className="studio"
        onKeyDown={event => {
          const target = event.target
          if (
            target instanceof HTMLElement &&
            (target.isContentEditable ||
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
          ) {
            return
          }
          if (event.code === 'Space') {
            event.preventDefault()
            const video = videoElementRef.current
            if (!video) return
            if (video.paused) void video.play()
            else video.pause()
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            deleteSelectedClip()
          } else if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === 'b'
          ) {
            event.preventDefault()
            splitSelectedClip()
          }
        }}
      >
        <header className="studio-topbar">
          <button
            className="brand-button"
            onClick={exitEditor}
          >
            <span className="brand-mark">S</span>
            <span>StudioCut <em>AI</em></span>
          </button>

          <div className="project-title">
            <span className="live-dot" />
            <span>{activeProject.name}</span>
            <small>{cloudUser && cloudSyncEnabled ? 'Cloud sync on' : 'Local project'}</small>
          </div>

          <div className="topbar-actions">
            <button
              className="quiet-button"
              onClick={exitEditor}
            >
              Save &amp; exit
            </button>
            <button
              className="gold-button"
              onClick={handleExport}
              disabled={exporting || !videoFile}
            >
              {exporting
                ? `Exporting ${Math.round(exportProgress)}%`
                : 'Export video'}
            </button>
          </div>
        </header>

        {editorMessage && (
          <div
            role="status"
            className="editor-notice"
            style={{ padding: '12px 20px' }}
          >
            {editorMessage}
          </div>
        )}

        <div className="editor-layout">
          <aside className="tool-rail">
            <button
              className={selectedTool === 'Select' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => setSelectedTool('Select')}
            >
              <span>↖</span><small>Select</small>
            </button>
            <button
              className={selectedTool === 'Media' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('Media')
                document.getElementById('video-upload')?.click()
              }}
            >
              <span>▧</span><small>Media</small>
            </button>
            <button
              className={selectedTool === 'Text' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('Text')
                document.getElementById('title-style-controls')?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                })
              }}
            >
              <span>T</span><small>Text</small>
            </button>
            <button
              className={selectedTool === 'Captions' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('Captions')
                document.getElementById('title-text-control')?.focus()
              }}
            >
              <span>CC</span><small>Captions</small>
            </button>
            <button
              className={selectedTool === 'Audio' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('Audio')
                document.getElementById('music-upload')?.click()
              }}
            >
              <span>♫</span><small>Audio</small>
            </button>
            <button
              className={selectedTool === 'Effects' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('Effects')
                document.getElementById('title-style-controls')?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                })
              }}
            >
              <span>✧</span><small>Effects</small>
            </button>
            <button
              className={selectedTool === 'Transitions' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('Transitions')
                document.getElementById('transition-options')?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                })
              }}
            >
              <span>◫</span><small>Transitions</small>
            </button>
            <button
              className={selectedTool === 'AI' ? 'rail-tool selected' : 'rail-tool'}
              onClick={() => {
                setSelectedTool('AI')
                setActiveTab('AI Edit')
                document.querySelector('.assistant-panel')?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                })
              }}
            >
              <span>✦</span><small>AI</small>
            </button>
          </aside>

          <section className="editor-main">
            <div className="editor-heading">
              <div>
                <p className="eyebrow">CREATIVE WORKSPACE</p>
                <h1>Make something unforgettable.</h1>
              </div>
              <div className="editor-heading-right">
                <span className="status-pill">● Workspace ready</span>
                <button
                  className="outline-button"
                  onClick={() => document.getElementById('video-upload')?.click()}
                >
                  + Import media
                </button>
              </div>
            </div>

            <div className="editor-columns">
              <section className="preview-column">
                <div className="panel preview-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Preview monitor</h2>
                      <p>See your footage as you work</p>
                    </div>
                    <span className="tiny-pill">PREVIEW</span>
                  </div>

                  <div className="video-stage">
                    {videoUrl ? (
                      <video
                        ref={videoElementRef}
                        src={videoUrl}
                        controls
                        style={{
                          width: '100%',
                          maxHeight: '100%',
                          filter: `${LOOK_FILTERS[lookPreset]} brightness(${Math.round((1 + brightness) * 100)}%) contrast(${Math.round(contrast * 100)}%) saturate(${Math.round(saturation * 100)}%)`,
                        }}
                        onPlay={handleVideoPlay}
                        onPause={handleVideoPause}
                        onEnded={handleVideoEnded}
                        onVolumeChange={event => {
                          const volume = event.currentTarget.volume
                          setVideoVolume(volume)
                        }}
                        onTimeUpdate={event => {
                          handleVideoTimeUpdate(event.currentTarget.currentTime)
                        }}
                        onLoadedMetadata={event =>
                          handleVideoMetadata(event.currentTarget.duration)
                        }
                      />
                    ) : (
                      <div className="empty-preview">
                        <div className="play-orb">▶</div>
                        <h3>Your story starts here</h3>
                        <p>Import a video to see it in the preview monitor.</p>
                        <button
                          className="gold-button"
                          onClick={() => document.getElementById('video-upload')?.click()}
                        >
                          Import footage
                        </button>
                      </div>
                    )}
                  </div>

                  {musicUrl && (
                    <audio
                      ref={audioElementRef}
                      src={musicUrl}
                      preload="auto"
                      onLoadedMetadata={event => {
                        const duration = event.currentTarget.duration
                        if (!Number.isFinite(duration) || duration <= 0) return
                        setMusicDuration(duration)
                        setMusicSourceEnd(current =>
                          current > 0 ? Math.min(current, duration) : duration,
                        )
                      }}
                      onError={() =>
                        setEditorMessage(
                          'The browser could not load this music file. Try an MP3 or WAV file.',
                        )
                      }
                    />
                  )}

                  <div className="preview-footer">
                    <span>{videoName || 'No footage imported'}</span>
                    <span>
                      {videoDuration > 0
                        ? `${videoDuration.toFixed(1)} seconds`
                        : 'Preview monitor'}
                    </span>
                  </div>

                  {videoUrl && (
                    <div className="trim-controls">
                      <h3>Trim video</h3>
                      <label>
                        Selected clip start (seconds)
                        <input
                          type="number"
                          min="0"
                          max={videoDuration || undefined}
                          step="0.1"
                          value={selectedClip?.sourceStart ?? 0}
                          disabled={!selectedClip}
                          onChange={event => {
                            updateSelectedClipRange(
                              Number(event.target.value) || 0,
                              selectedClip?.sourceEnd ?? videoDuration,
                            )
                          }}
                        />
                        {titleText.trim() && (
                          <div
                            className={`title-preview title-preview-${titlePosition} title-style-${titleStyle}`}
                            style={{ color: titleColor }}
                            aria-hidden="true"
                          >
                            {titleText}
                          </div>
                        )}
                      </label>
                      <label>
                        Selected clip end (seconds)
                        <input
                          type="number"
                          min="0"
                          max={videoDuration || undefined}
                          step="0.1"
                          value={selectedClip?.sourceEnd ?? videoDuration}
                          disabled={!selectedClip}
                          onChange={event => {
                            updateSelectedClipRange(
                              selectedClip?.sourceStart ?? 0,
                              Number(event.target.value) || 0,
                            )
                          }}
                        />
                      </label>
                      <p>
                        Trim the selected clip. The timeline order and trims are included in export.
                      </p>
                    </div>
                  )}

                  <div className="trim-controls">
                    <h3>Audio mixer</h3>
                    <label>
                      Original video volume: {Math.round(videoVolume * 100)}%
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={Math.min(1, videoVolume)}
                        onChange={event => {
                          const value = Number(event.target.value)
                          setVideoVolume(value)
                          if (videoElementRef.current) {
                            videoElementRef.current.volume = value
                          }
                        }}
                      />
                    </label>
                    <label>
                      Music volume: {Math.round(musicVolume * 100)}%
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={Math.min(1, musicVolume)}
                        onChange={event => {
                          const value = Number(event.target.value)
                          setMusicVolume(value)
                          if (audioElementRef.current) {
                            audioElementRef.current.volume = value
                          }
                        }}
                      />
                    </label>
                    <p>
                      {musicName
                        ? `Soundtrack: ${musicName}. Drag its timeline clip to move it and its handles to trim it.`
                        : 'Import a music file to add a soundtrack.'}
                    </p>
                    {musicAttribution && (
                      <p className="music-attribution">
                        Music by {musicAttribution.artist}:{' '}
                        <a
                          href={musicAttribution.shareUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {musicAttribution.track}
                        </a>
                        {' · '}
                        <a
                          href={musicAttribution.licenseUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          license
                        </a>
                      </p>
                    )}
                    {musicName && (
                      <div className="audio-edit-fields">
                        <label>
                          Timeline position (seconds)
                          <input
                            type="number"
                            min="0"
                            max={Math.max(0, timelineScale - 0.1)}
                            step="0.1"
                            value={musicTimelineStart}
                            onChange={event =>
                              setMusicTimelineStart(Math.max(
                                0,
                                Math.min(
                                  timelineScale - 0.1,
                                  Number(event.target.value) || 0,
                                ),
                              ))
                            }
                          />
                        </label>
                        <label>
                          Music in (seconds)
                          <input
                            type="number"
                            min="0"
                            max={musicDuration || undefined}
                            step="0.1"
                            value={musicSourceStart}
                            onChange={event =>
                              setMusicSourceStart(
                                Math.max(
                                  0,
                                  Math.min(
                                    Number(event.target.value) || 0,
                                    Math.max(0, musicSourceEnd - 0.1),
                                  ),
                                ),
                              )
                            }
                          />
                        </label>
                        <label>
                          Music out (seconds)
                          <input
                            type="number"
                            min={musicSourceStart + 0.1}
                            max={musicDuration || undefined}
                            step="0.1"
                            value={musicSourceEnd}
                            onChange={event =>
                              setMusicSourceEnd(
                                Math.max(
                                  musicSourceStart + 0.1,
                                  Math.min(
                                    musicDuration || Infinity,
                                    Number(event.target.value) || 0,
                                  ),
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </div>

                <div className="trim-controls style-controls" id="title-style-controls">
                  <div className="style-controls-heading">
                    <div>
                      <h3>Looks &amp; titles</h3>
                      <p>Preview effects here; your choices are included in export.</p>
                    </div>
                    <span className="tiny-pill">STYLE</span>
                  </div>
                  <div className="look-grid" aria-label="Video look presets">
                    {LOOK_PRESETS.map(preset => (
                      <button
                        key={preset}
                        type="button"
                        className={lookPreset === preset ? 'look-button selected' : 'look-button'}
                        onClick={() => setLookPreset(preset)}
                        aria-pressed={lookPreset === preset}
                      >
                        <span className={`look-swatch look-swatch-${preset}`}>◈</span>
                        {LOOK_LABELS[preset]}
                      </button>
                    ))}
                  </div>
                  <div className="effect-adjustments">
                    <label>
                      Brightness <span>{Math.round(brightness * 100)}%</span>
                      <input
                        type="range"
                        min="-1"
                        max="1"
                        step="0.05"
                        value={brightness}
                        onChange={event => setBrightness(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      Contrast <span>{Math.round(contrast * 100)}%</span>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.05"
                        value={contrast}
                        onChange={event => setContrast(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      Saturation <span>{Math.round(saturation * 100)}%</span>
                      <input
                        type="range"
                        min="0"
                        max="3"
                        step="0.05"
                        value={saturation}
                        onChange={event => setSaturation(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <label>
                    On-screen title
                    <input
                      id="title-text-control"
                      type="text"
                      maxLength={100}
                      value={titleText}
                      onChange={event => setTitleText(event.target.value)}
                      placeholder="Add a title or caption"
                    />
                  </label>
                  <div className="title-options">
                    <label>
                      Style
                      <select
                        value={titleStyle}
                        onChange={event => setTitleStyle(event.target.value as TitleStyle)}
                      >
                        <option value="bold">Bold</option>
                        <option value="outline">Outline</option>
                        <option value="neon">Glow</option>
                      </select>
                    </label>
                    <label>
                      Position
                      <select
                        value={titlePosition}
                        onChange={event => setTitlePosition(event.target.value as TitlePosition)}
                      >
                        <option value="top">Top</option>
                        <option value="center">Center</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </label>
                    <label className="title-color-label">
                      Color
                      <input
                        type="color"
                        value={titleColor}
                        onChange={event => setTitleColor(event.target.value)}
                        aria-label="Title color"
                      />
                    </label>
                  </div>
                  <div className="transition-options" id="transition-options">
                    <label>
                      Clip transition
                      <select
                        value={transitionStyle}
                        onChange={event =>
                          setTransitionStyle(event.target.value as TransitionStyle)
                        }
                      >
                        {VIDEO_TRANSITIONS.map(transition => (
                          <option key={transition} value={transition}>
                            {TRANSITION_LABELS[transition]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {transitionStyle !== 'cut' && (
                      <label>
                        Duration · {transitionDuration.toFixed(2)}s
                        <input
                          type="range"
                          min="0.1"
                          max="1.5"
                          step="0.05"
                          value={transitionDuration}
                          onChange={event =>
                            setTransitionDuration(Number(event.target.value))
                          }
                        />
                      </label>
                    )}
                  </div>
                </div>

                <div className="panel media-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Media library</h2>
                      <p>Your source files for this project</p>
                    </div>
                    <span className="media-count">
                      {videoAssets.length + (musicName ? 1 : 0)} files
                    </span>
                  </div>

                  <div className="media-actions">
                    <button
                      className="media-drop"
                      onClick={() => document.getElementById('video-upload')?.click()}
                    >
                      <span className="media-icon">▧</span>
                      <strong>Import video</strong>
                      <small>{videoName || 'MP4, MOV, WebM'}</small>
                    </button>
                    <button
                      className="media-drop"
                      onClick={() => document.getElementById('music-upload')?.click()}
                    >
                      <span className="media-icon audio-icon">♫</span>
                      <strong>Import music</strong>
                      <small>{musicName || 'MP3, WAV, M4A'}</small>
                    </button>
                  </div>
                  {videoAssets.length > 0 && (
                    <div className="asset-list">
                      {videoAssets.map((asset, index) => (
                        <div className="asset-row" key={`${asset.file.name}-${index}`}>
                          <span className="asset-preview">▶</span>
                          <span className="asset-info">
                            <strong>{asset.file.name}</strong>
                            <small>{asset.duration.toFixed(1)} sec</small>
                          </span>
                          <button
                            className="asset-add-button"
                            onClick={() => addAssetToTimeline(asset)}
                            title={`Add ${asset.file.name} to timeline`}
                          >
                            ＋
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <input
                    id="video-upload"
                    className="hidden-input"
                    type="file"
                    accept="video/*"
                    multiple
                    onChange={event => {
                      void importVideos(Array.from(event.target.files ?? []))
                      event.target.value = ''
                    }}
                  />
                  <input
                    id="music-upload"
                    className="hidden-input"
                    type="file"
                    accept="audio/*"
                    onChange={event => {
                      importMusic(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                </div>
              </section>

              <aside className="assistant-column">
                <div className="panel assistant-panel">
                  <div className="assistant-heading">
                    <div className="assistant-symbol">✦</div>
                    <div>
                      <h2>StudioCut AI</h2>
                      <p>Your creative co-pilot</p>
                    </div>
                    <span className="ai-badge">AI</span>
                  </div>

                  <div className="assistant-tabs">
                    {['AI Edit', 'AI Tools', 'Jamendo', 'Generate Video', 'Edit plan'].map(tab => (
                      <button
                        key={tab}
                        className={activeTab === tab ? 'assistant-tab active' : 'assistant-tab'}
                        onClick={() => setActiveTab(tab)}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  <label className="ai-media-consent">
                    <input
                      type="checkbox"
                      checked={aiMediaConsent}
                      onChange={event => setAiMediaConsent(event.target.checked)}
                    />
                    <span>
                      Allow the selected cloud AI provider to receive sampled video frames or extracted speech audio when I request analysis. This permission resets when I open another project.
                    </span>
                  </label>

                  {activeTab === 'AI Edit' ? (
                    <>
                      <div className="assistant-chat">
                        {assistantMessages.map((message, index) => (
                          <div
                            className={message.startsWith('You:') ? 'chat-message user-message' : 'chat-message'}
                            key={`${index}-${message}`}
                          >
                            {message}
                          </div>
                        ))}
                        {assistantLoading && (
                          <div className="chat-message" role="status">
                            Analyzing sample frames and building your edit…
                          </div>
                        )}
                      </div>
                      <div className="prompt-suggestions">
                        <button onClick={() => setAssistantPrompt('Make a cinematic highlight edit with quick pacing, a bold title, and a dramatic look.')}>
                          Gaming montage
                        </button>
                        <button onClick={() => setAssistantPrompt('Create a warm, upbeat travel edit. Keep the best moments and add a short title.')}>
                          Travel reel
                        </button>
                        <button onClick={() => setAssistantPrompt('Make a short, energetic social clip using the strongest moments.')}>
                          Short social edit
                        </button>
                        <button onClick={() => setAssistantPrompt('Make a music-ready edit with steady, energetic pacing. Add a short title and keep the soundtrack clear.')}>
                          Music-ready edit
                        </button>
                      </div>
                      <div className="assistant-input">
                        <textarea
                          value={assistantPrompt}
                          onChange={event => setAssistantPrompt(event.target.value)}
                          placeholder="Describe the edit you want…"
                          rows={3}
                          onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey && !assistantLoading) {
                              event.preventDefault()
                              void sendAssistantMessage()
                            }
                          }}
                        />
                        <button
                          className="send-button"
                          onClick={() => void sendAssistantMessage()}
                          disabled={assistantLoading || !assistantPrompt.trim()}
                          aria-label="Create AI edit plan"
                        >
                          {assistantLoading ? '…' : '↑'}
                        </button>
                      </div>
                      <p className="assistant-note">
                        {!aiServiceStatus.editingEnabled
                          ? aiServiceError || 'AI is not configured. Add GEMINI_API_KEY or GROQ_API_KEY to the backend .env.local file, then restart the API server.'
                          : !aiMediaConsent
                            ? 'Enable the permission above to send your prompt and five low-resolution sample frames to the selected AI provider. The full video stays in this browser.'
                            : `Your prompt and five low-resolution sample frames will be sent to ${aiProviderPreference === 'auto' ? 'Gemini (Groq fallback)' : aiProviderPreference}. The full video stays in this browser.`}
                      </p>
                      <div className="ai-connection-controls">
                        <label>
                          AI provider
                          <select
                            value={aiProviderPreference}
                            onChange={event =>
                              setAiProviderPreference(event.target.value as AiProviderPreference)
                            }
                          >
                            <option value="auto">Auto · Gemini, then Groq</option>
                            <option value="gemini">Gemini primary · Groq fallback</option>
                            <option value="groq">Groq only</option>
                          </select>
                        </label>
                        <div className="connection-tests">
                          {(['gemini', 'groq'] as const).map(provider => {
                            const detail = provider === 'gemini'
                              ? aiServiceStatus.providers?.primary
                              : aiServiceStatus.providers?.fallback
                            return (
                              <div key={provider} className="connection-test-row">
                                <span>
                                  {provider === 'gemini' ? 'Gemini' : 'Groq'} ·{' '}
                                  {detail?.configured ? 'configured' : 'not configured'}
                                  {detail?.cooldownSeconds
                                    ? ` · retry in ${Math.ceil(detail.cooldownSeconds / 60)}m`
                                    : ''}
                                </span>
                                <button
                                  onClick={() => void testConnection(provider)}
                                  disabled={!detail?.configured}
                                >
                                  Test
                                </button>
                              </div>
                            )
                          })}
                          {Object.entries(connectionTestMessages)
                            .filter(([provider]) => provider !== 'jamendo')
                            .map(([provider, message]) => (
                              <p className="connection-test-message" key={provider}>
                                {message}
                              </p>
                            ))}
                        </div>
                      </div>
                      <button
                        className="outline-button"
                        onClick={() => void findMatchingMusic()}
                        disabled={!aiServiceStatus.musicRecommendationsEnabled || musicRecommendationsLoading}
                      >
                        {musicRecommendationsLoading
                          ? 'Finding matching music…'
                          : '♫ Recommend music for this video'}
                      </button>
                      {!aiServiceStatus.musicRecommendationsEnabled && (
                        <p className="assistant-note">
                          Music matching needs a working Gemini/Groq key and your Jamendo client ID configured on the server.
                        </p>
                      )}
                      {musicMatchReason && (
                        <p className="music-match-reason">{musicMatchReason}</p>
                      )}
                      {musicRecommendationsError && (
                        <p className="music-recommendation-error" role="alert">
                          {musicRecommendationsError}
                        </p>
                      )}
                      {musicRecommendations.length > 0 &&
                        renderMusicTrackCards(musicRecommendations)}
                      {pendingAiPlan && (
                        <div className="ai-plan-preview">
                          <strong>Ready to apply</strong>
                          <span>
                            {pendingAiPlan.segments.length} cuts ·{' '}
                            {pendingAiPlan.segments
                              .reduce((total, segment) =>
                                total + segment.sourceEnd - segment.sourceStart, 0)
                              .toFixed(1)}s · {LOOK_LABELS[pendingAiPlan.look]}
                            {pendingAiPlan.title ? ' · title included' : ''}
                          </span>
                          <button
                            className="gold-button"
                            onClick={applyAiPlan}
                            disabled={!videoFile}
                          >
                            Apply edit to timeline
                          </button>
                        </div>
                      )}
                    </>
                  ) : activeTab === 'AI Tools' ? (
                    <div className="ai-tools-panel">
                      <span className="generation-kicker">VIDEO INTELLIGENCE</span>
                      <h3>Analyze, write, and caption your footage.</h3>
                      <p>
                        Scene analysis uses low-resolution stills. Speech subtitles extract audio in your browser and send compressed audio for transcription.
                      </p>
                      <div className="ai-tool-buttons">
                        <button
                          className="outline-button"
                          disabled={!aiServiceStatus.editingEnabled || aiToolLoading}
                          onClick={() => void runAiTool('summary')}
                        >
                          Video summary
                        </button>
                        <button
                          className="outline-button"
                          disabled={!aiServiceStatus.editingEnabled || aiToolLoading}
                          onClick={() => void runAiTool('script')}
                        >
                          Write a script
                        </button>
                        <button
                          className="outline-button"
                          disabled={!aiServiceStatus.editingEnabled || aiToolLoading}
                          onClick={() => void runAiTool('scenes')}
                        >
                          Analyze scenes
                        </button>
                        <button
                          className="gold-button"
                          disabled={!aiServiceStatus.editingEnabled || aiToolLoading}
                          onClick={() => void runAiTool('captions')}
                        >
                          Generate speech subtitles
                        </button>
                      </div>
                      {aiToolLoading && (
                        <p role="status" className="assistant-note">
                          Extracting media and asking {aiProviderPreference === 'auto' ? 'Gemini, with Groq fallback' : aiProviderPreference}…
                        </p>
                      )}
                      {aiToolError && (
                        <p className="music-recommendation-error" role="alert">
                          {aiToolError}
                        </p>
                      )}
                      {aiToolResult && (
                        <div className="ai-tool-result">
                          <strong>
                            {aiToolResult.task === 'summary'
                              ? 'Video summary'
                              : aiToolResult.task === 'script'
                                ? 'Suggested script'
                                : aiToolResult.task === 'captions'
                                  ? 'Speech subtitles'
                                  : 'Scene analysis'}
                            {' · '}{aiToolResult.provider}
                          </strong>
                          {aiToolResult.text && <p>{aiToolResult.text}</p>}
                          {aiToolResult.scenes?.map((scene, index) => (
                            <article key={`${scene.timestamp}-${index}`}>
                              <span>{formatTime(scene.timestamp)}</span>
                              <p>{scene.description}</p>
                              <small>{scene.suggestion}</small>
                            </article>
                          ))}
                          {aiToolResult.captions && (
                            <>
                              <div className="generated-captions">
                                {aiToolResult.captions.map((caption, index) => (
                                  <p key={`${caption.start}-${index}`}>
                                    <time>{formatTime(caption.start)}</time>
                                    {caption.text}
                                  </p>
                                ))}
                              </div>
                              <button
                                className="outline-button"
                                onClick={() => downloadCaptions(aiToolResult.captions || [])}
                              >
                                Download .SRT subtitles
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      <div className="ai-connection-controls">
                        <p>
                          Gemini configured: {aiServiceStatus.providers?.primary.configured ? 'yes' : 'no'}
                          {' · '}Groq fallback: {aiServiceStatus.providers?.fallback.configured ? 'yes' : 'no'}
                        </p>
                        <p className="assistant-note">
                          API free quotas can change. Requests stop on quota errors; no automatic paid-tier upgrade is attempted.
                        </p>
                      </div>
                    </div>
                  ) : activeTab === 'Jamendo' ? (
                    <div className="jamendo-panel">
                      <span className="generation-kicker">JAMENDO MUSIC LIBRARY</span>
                      <h3>Search tracks to use in your edit.</h3>
                      <p>
                        Previews and downloads are filtered to tracks marked downloadable by Jamendo. Review the license and attribution terms before publishing.
                      </p>
                      <label htmlFor="jamendo-search">Track, artist, or keyword</label>
                      <input
                        id="jamendo-search"
                        value={musicSearchQuery}
                        maxLength={100}
                        onChange={event => setMusicSearchQuery(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void searchMusic()
                        }}
                        placeholder="Search music…"
                      />
                      <div className="generation-options">
                        <label>
                          Genre
                          <select
                            value={musicSearchGenre}
                            onChange={event => setMusicSearchGenre(event.target.value)}
                          >
                            <option value="">All genres</option>
                            {['pop', 'rock', 'electronic', 'ambient', 'classical', 'jazz', 'hiphop', 'folk', 'metal', 'soundtrack', 'reggae', 'blues'].map(tag => (
                              <option value={tag} key={tag}>{tag}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Mood
                          <select
                            value={musicSearchMood}
                            onChange={event => setMusicSearchMood(event.target.value)}
                          >
                            <option value="">Any mood</option>
                            {['upbeat', 'calm', 'dramatic', 'happy', 'sad', 'energetic', 'romantic', 'inspiring', 'dark', 'chill', 'cinematic'].map(tag => (
                              <option value={tag} key={tag}>{tag}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <button
                        className="gold-button"
                        onClick={() => void searchMusic()}
                        disabled={!aiServiceStatus.jamendoEnabled || musicSearchLoading}
                      >
                        {musicSearchLoading ? 'Searching…' : 'Search Jamendo'}
                      </button>
                      {!aiServiceStatus.jamendoEnabled && (
                        <p className="assistant-note">
                          Add your own JAMENDO_CLIENT_ID to the server environment to enable music search.
                        </p>
                      )}
                      <div className="connection-tests">
                        <button
                          onClick={() => void testConnection('jamendo')}
                          disabled={!aiServiceStatus.jamendoEnabled}
                        >
                          Test Jamendo connection
                        </button>
                        {connectionTestMessages.jamendo && (
                          <p className="connection-test-message">
                            {connectionTestMessages.jamendo}
                          </p>
                        )}
                      </div>
                      {musicSearchError && (
                        <p className="music-recommendation-error" role="alert">
                          {musicSearchError}
                        </p>
                      )}
                      {jamendoTracks.length > 0 && renderMusicTrackCards(jamendoTracks)}
                    </div>
                  ) : activeTab === 'Generate Video' ? (
                    <div className="video-generation-panel">
                      <span className="generation-kicker">TEXT TO VIDEO</span>
                      <h3>Make a new clip from an idea.</h3>
                      <p>
                        Describe the subject, movement, camera, lighting, and mood. Generated clips are short and can be added to your project.
                      </p>
                      <label htmlFor="generated-video-prompt">Video prompt</label>
                      <textarea
                        id="generated-video-prompt"
                        value={videoPrompt}
                        maxLength={1000}
                        onChange={event => setVideoPrompt(event.target.value)}
                        placeholder="A golden-hour aerial shot drifting over a quiet coastline…"
                        rows={5}
                      />
                      <div className="generation-options">
                        <label>
                          Aspect ratio
                          <select
                            value={videoRatio}
                            onChange={event =>
                              setVideoRatio(event.target.value as '1280:720' | '720:1280')
                            }
                          >
                            <option value="1280:720">Landscape · 16:9</option>
                            <option value="720:1280">Portrait · 9:16</option>
                          </select>
                        </label>
                        <label>
                          Duration
                          <select
                            value={videoGenerationDuration}
                            onChange={event =>
                              setVideoGenerationDuration(Number(event.target.value))
                            }
                          >
                            <option value={5}>5 seconds</option>
                            <option value={10}>10 seconds</option>
                          </select>
                        </label>
                      </div>
                      <button
                        className="gold-button generate-button"
                        onClick={() => void generateVideo()}
                        disabled={
                          !videoPrompt.trim() ||
                          !aiServiceStatus.videoGenerationEnabled ||
                          generatedVideo?.status === 'pending' ||
                          generatedVideo?.status === 'running'
                        }
                      >
                        {generatedVideo?.status === 'pending' ||
                        generatedVideo?.status === 'running'
                          ? 'Generating locally…'
                          : '✦ Generate video'}
                      </button>
                      {!aiServiceStatus.videoGenerationEnabled && (
                        <p className="assistant-note">
                          {aiServiceStatus.localVideo?.message ||
                            'Configure local ComfyUI, an API workflow, and a compatible installed video model. No paid video API is used.'}
                        </p>
                      )}
                      <p className="assistant-note">
                        Video generation runs on your own ComfyUI installation. No compatible local model is reported as available until the workflow and installed model pass checks.
                      </p>
                      {generatedVideo && (
                        <div className="generated-video-result">
                          {generatedVideo.status === 'succeeded' ? (
                            <>
                              <video
                                src={generatedVideoUrl}
                                controls
                                playsInline
                                aria-label="Generated AI video"
                              />
                              <div className="generated-video-actions">
                                <a
                                  className="outline-button"
                                  href={generatedVideoUrl}
                                  download="studiocut-ai-generated.mp4"
                                >
                                  Download MP4
                                </a>
                                <button
                                  className="gold-button"
                                  onClick={() => void importGeneratedVideo()}
                                >
                                  Use in project
                                </button>
                              </div>
                              <button
                                className="outline-button"
                                onClick={() => void findMatchingMusic()}
                                disabled={
                                  !aiServiceStatus.musicRecommendationsEnabled ||
                                  musicRecommendationsLoading
                                }
                              >
                                {musicRecommendationsLoading
                                  ? 'Finding matching music…'
                                  : '♫ Find matching music'}
                              </button>
                              {!aiServiceStatus.musicRecommendationsEnabled && (
                                <p className="assistant-note">
                                  Matching uses video frames and prompt. Configure a Gemini or Groq server key plus JAMENDO_CLIENT_ID.
                                </p>
                              )}
                              {musicMatchReason && (
                                <p className="music-match-reason">{musicMatchReason}</p>
                              )}
                              {musicRecommendationsError && (
                                <p className="music-recommendation-error" role="alert">
                                  {musicRecommendationsError}
                                </p>
                              )}
                              {musicRecommendations.length > 0 &&
                                renderMusicTrackCards(musicRecommendations)}
                            </>
                          ) : generatedVideo.status === 'failed' ? (
                            <p role="alert">{generatedVideo.error}</p>
                          ) : (
                            <p role="status">
                              Your clip is rendering. This can take a few minutes.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="edit-plan">
                      <h3>Your editing plan</h3>
                      {[
                        ['01', 'Import footage', 'Add a video, then describe the result you want in AI Edit.'],
                        ['02', 'Apply the AI cut', 'Review suggested cuts, pacing, title, and look before applying.'],
                        ['03', 'Style your edit', 'Add an on-screen title, choose a look, or mix in music.'],
                        ['04', 'Export your edit', 'Render the timeline, selected look, title, and soundtrack.'],
                      ].map(([number, title, description]) => (
                        <div className="plan-step" key={number}>
                          <span>{number}</span>
                          <div>
                            <strong>{title}</strong>
                            <p>{description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </aside>
            </div>

            <section className="panel timeline-panel">
              <div className="timeline-heading">
                <div>
                  <h2>Editing timeline</h2>
                  <p>Drag clips to reorder, or select one to trim and split.</p>
                </div>
                <div className="timeline-controls">
                  <button onClick={() => setSelectedTool('Select')}>↖ Select</button>
                  <button onClick={() => document.getElementById('music-upload')?.click()}>
                    ♫ Add audio
                  </button>
                </div>
              </div>

              <div className="timeline-time-readout">
                <span>PLAYHEAD: {formatTime(playheadTime)}</span>
                <span>
                  IN: {formatTime(selectedClip?.sourceStart ?? 0)}　 OUT:{' '}
                  {formatTime(selectedClip?.sourceEnd ?? 0)}
                </span>
                <span>DURATION: {formatTime(sequenceDuration)}</span>
              </div>

              <div className="timeline-ruler interactive-ruler">
                {(sequenceDuration > 0
                  ? Array.from({ length: 7 }, (_, index) => sequenceDuration * index / 6)
                  : [0, 5, 10, 15, 20, 25, 30]
                ).map((time, index) => (
                  <span key={index}>{formatTime(time).split('.')[0]}</span>
                ))}
              </div>

              <div
                className="interactive-timeline"
                onPointerMove={moveTimelineDrag}
                onPointerUp={stopTimelineDrag}
                onPointerCancel={stopTimelineDrag}
                onLostPointerCapture={stopTimelineDrag}
              >
                <div className="track-row">
                  <div className="track-label">
                    <span className="track-color video-color" />VIDEO
                  </div>
                  <div
                    className="track-lane interactive-track-lane"
                    ref={timelineLaneRef}
                    onPointerDown={event => {
                      const target = event.target as HTMLElement
                      if (target.closest('.trim-handle')) return
                      startTimelineDrag(event, 'playhead')
                    }}
                    onDoubleClick={event =>
                      seekTo(
                        timeFromMouse(
                          event.clientX,
                          timelineLaneRef.current,
                          timelineScale,
                        ),
                      )
                    }
                    title="Click or drag to seek"
                  >
                    {videoName && timelineClips.length > 0 ? (
                      timelineClips.map((clip, index) => {
                        const clipStart = timelinePositionForClip(timelineClips, index)
                        const clipWidth = (clipDuration(clip) / timelineScale) * 100

                        return (
                          <div
                            key={clip.id}
                            draggable
                            className={`clip video-clip draggable-video-clip${selectedClipId === clip.id ? ' selected-timeline-clip' : ''}`}
                            style={{
                              left: `${(clipStart / timelineScale) * 100}%`,
                              width: `${clipWidth}%`,
                            }}
                            onPointerDown={event => {
                              event.stopPropagation()
                              setSelectedClipId(clip.id)
                            }}
                            onDragStart={event => {
                              draggedClipIndexRef.current = index
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', clip.id)
                            }}
                            onDragOver={event => {
                              event.preventDefault()
                              event.dataTransfer.dropEffect = 'move'
                            }}
                            onDrop={event => {
                              event.preventDefault()
                              const fromIndex = draggedClipIndexRef.current
                              draggedClipIndexRef.current = null
                              if (fromIndex === null || fromIndex === index) return
                              const nextClips = moveClip(timelineClips, fromIndex, index)
                              setTimelineClips(nextClips)
                              setSelectedClipId(clip.id)
                              playheadClipIndexRef.current = nextClips.findIndex(
                                item => item.id === clip.id,
                              )
                              setEditorMessage('Timeline clip order updated.')
                            }}
                            onDragEnd={() => {
                              draggedClipIndexRef.current = null
                            }}
                            onClick={() =>
                              seekTo(timelinePositionForClip(timelineClips, index))
                            }
                            title={`${clip.name}: ${formatTime(clip.sourceStart)}–${formatTime(clip.sourceEnd)}`}
                          >
                            <button
                              type="button"
                              className="trim-handle trim-handle-start"
                              aria-label={`Drag to change ${clip.name} start`}
                              title="Drag to change clip start"
                              onPointerDown={event =>
                                startTimelineDrag(event, 'video-start', clip.id)
                              }
                            />
                            <span className="clip-name">
                              {timelineClips.length > 1
                                ? `${index + 1}. ${clip.name}`
                                : clip.name}
                            </span>
                            <button
                              type="button"
                              className="trim-handle trim-handle-end"
                              aria-label={`Drag to change ${clip.name} end`}
                              title="Drag to change clip end"
                              onPointerDown={event =>
                                startTimelineDrag(event, 'video-end', clip.id)
                              }
                            />
                            {transitionStyle !== 'cut' &&
                              index < timelineClips.length - 1 && (
                                <span
                                  className="clip-transition-marker"
                                  title={`${TRANSITION_LABELS[transitionStyle]} · ${transitionDuration.toFixed(2)}s`}
                                >
                                  ✦
                                </span>
                              )}
                          </div>
                        )
                      })
                    ) : (
                      <span className="track-placeholder">
                        {videoName ? 'Loading video duration…' : 'Import footage to start building your edit'}
                      </span>
                    )}

                    {sequenceDuration > 0 && (
                      <div className="timeline-playhead" style={{ left: `${playheadLeft}%` }}>
                        <div className="playhead-cap" />
                        <div className="playhead-line" />
                      </div>
                    )}
                  </div>
                </div>

                <div className="track-row">
                  <div className="track-label">
                    <span className="track-color audio-color" />AUDIO
                  </div>
                  <div
                    className="track-lane audio-track-lane"
                    ref={musicLaneRef}
                    onPointerDown={event => {
                      const target = event.target as HTMLElement
                      if (target.closest('.trim-handle')) return
                      if (musicName) {
                        startTimelineDrag(event, 'music-move')
                      }
                    }}
                  >
                    {musicName
                      ? (
                        <div
                          className="clip audio-clip editable-audio-clip"
                          style={{
                            left: `${musicLeft}%`,
                            width: `${musicWidth}%`,
                          }}
                          title="Drag to move the music; drag either edge to trim"
                        >
                          <button
                            type="button"
                            className="trim-handle trim-handle-start"
                            aria-label="Drag to trim the beginning of the music"
                            title="Trim music start"
                            onPointerDown={event =>
                              startTimelineDrag(event, 'music-start')
                            }
                          />
                          <span className="clip-name">♫ {musicName}</span>
                          <button
                            type="button"
                            className="trim-handle trim-handle-end"
                            aria-label="Drag to trim the end of the music"
                            title="Trim music end"
                            onPointerDown={event =>
                              startTimelineDrag(event, 'music-end')
                            }
                          />
                        </div>
                      )
                      : <span className="track-placeholder">Add a soundtrack for your video</span>}
                  </div>
                </div>

                <div className="track-row">
                  <div className="track-label">
                    <span className="track-color text-color" />TEXT
                  </div>
                  <div className="track-lane">
                    {titleText.trim() ? (
                      <span className="timeline-style-chip">
                        T　{titleText} · {titleStyle} · {titlePosition}
                      </span>
                    ) : (
                      <span className="track-placeholder">
                        Add a title in Looks &amp; titles
                      </span>
                    )}
                  </div>
                </div>

                <div className="track-row">
                  <div className="track-label">
                    <span className="track-color effect-color" />EFFECTS
                  </div>
                  <div className="track-lane">
                    <span className={lookPreset === 'none' ? 'track-placeholder' : 'timeline-style-chip effect-style-chip'}>
                      {lookPreset === 'none'
                        ? 'Choose a look in Looks & titles'
                        : `✦ ${LOOK_LABELS[lookPreset]} look`}
                    </span>
                  </div>
                </div>
              </div>

              <div className="trim-controls">
                <h3>Timeline clip tools</h3>
                <p>
                  Select a video clip to trim, split, duplicate, delete, or reorder it.
                </p>
                <div className="timeline-controls">
                  <button onClick={splitSelectedClip} disabled={!selectedClipId}>
                    ✂ Split at playhead
                  </button>
                  <button onClick={duplicateSelectedClip} disabled={!selectedClipId}>
                    Duplicate
                  </button>
                  <button onClick={deleteSelectedClip} disabled={!selectedClipId}>
                    Delete
                  </button>
                  <button onClick={() => moveSelectedClip(-1)} disabled={!selectedClipId}>
                    ← Move left
                  </button>
                  <button onClick={() => moveSelectedClip(1)} disabled={!selectedClipId}>
                    Move right →
                  </button>
                </div>

                {timelineClips.length === 0 ? (
                  <p>No timeline clips yet. Import a video to begin.</p>
                ) : (
                  <div className="timeline-clip-list">
                    {timelineClips.map((clip, index) => (
                      <button
                        key={clip.id}
                        className={selectedClipId === clip.id ? 'outline-button' : 'quiet-button'}
                        onClick={() => {
                          setSelectedClipId(clip.id)
                          seekTo(timelinePositionForClip(timelineClips, index))
                        }}
                        style={{ margin: '4px' }}
                      >
                        {index + 1}. {clip.name} (
                        {(clip.sourceEnd - clip.sourceStart).toFixed(1)}s)
                        {selectedClipId === clip.id ? ' ✓' : ''}
                      </button>
                    ))}
                  </div>
                )}
                <p>
                  Video clip order, trims, and the positioned soundtrack are included in export.
                </p>
              </div>

              <div className="timeline-bottom">
                <span>Tool selected: {selectedTool}</span>
                <span>Space: play/pause · Ctrl/⌘+B: split · Delete: remove · Drag clip edges to trim.</span>
              </div>
            </section>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <button className="brand-button" onClick={() => setActiveProject(null)}>
          <span className="brand-mark">S</span>
          <span>StudioCut <em>AI</em></span>
        </button>
        <p className="sidebar-caption">WORKSPACE</p>
        <button className="sidebar-link current"><span>▦</span> Dashboard</button>
        <button className="sidebar-link" onClick={() => setShowCreate(true)}>
          <span>＋</span> New project
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-orb">✦</div>
          <strong>Your creative space</strong>
          <p>Bring your footage, music, and ideas together.</p>
        </div>
      </aside>

      <section className="dashboard-content">
        <header className="dashboard-topbar">
          <div className="welcome-user">
            <span className="eyebrow">YOUR CREATIVE STUDIO</span>
            <h1>Make something unforgettable.</h1>
            <p>One workspace for your footage, music, manual editing, and AI ideas.</p>
          </div>
          <button className="gold-button" onClick={() => setShowCreate(true)}>
            ＋ Create project
          </button>
        </header>

        <section className="dashboard-hero">
          <div className="hero-copy">
            <span className="hero-kicker"><span /> YOUR NEXT EDIT STARTS HERE</span>
            <h2>From raw footage<br />to <span>something extraordinary.</span></h2>
            <p>Build your story manually and use AI as your creative co-pilot — all in one place.</p>
            <button className="gold-button hero-button" onClick={() => openEditor()}>
              Open editing studio <span>↗</span>
            </button>
            <div className="hero-benefits">
              <span>✦ Manual editing</span>
              <span>♫ Music-led workflow</span>
              <span>◈ AI assistance</span>
            </div>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <div className="visual-ring ring-one" />
            <div className="visual-ring ring-two" />
            <div className="visual-orb"><span>▶</span></div>
            <div className="floating-card floating-top">
              <span className="floating-icon">✦</span>
              <div><strong>AI Co-pilot</strong><small>Ideas for your next edit</small></div>
            </div>
            <div className="floating-card floating-bottom">
              <span className="waveform">▂▅▃▇▅▂▆▃</span>
              <div><strong>Music + Motion</strong><small>Shape the rhythm</small></div>
            </div>
          </div>
        </section>

        <section className="dashboard-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">YOUR WORKFLOW</span>
              <h2>Everything works together.</h2>
            </div>
            <span className="section-note">One studio. Multiple ways to create.</span>
          </div>
          <div className="workflow-grid">
            <button className="workflow-card" onClick={() => openEditor()}>
              <span className="workflow-icon purple">▧</span>
              <span className="workflow-number">01 / CREATE</span>
              <strong>Manual editing</strong>
              <p>Import your footage, preview clips, and trim your video.</p>
              <span className="card-link">Open editor ↗</span>
            </button>
            <button
              className="workflow-card"
              onClick={() => {
                setAssistantMessages(current => [
                  ...current,
                  'StudioCut: Tell me the mood, pacing, and style you want, and I’ll help plan the edit.',
                ])
                openEditor()
              }}
            >
              <span className="workflow-icon gold">✦</span>
              <span className="workflow-number">02 / ASSIST</span>
              <strong>Prompt-driven AI editing</strong>
              <p>Describe the result you want, review AI cuts and styling, then apply them to your timeline.</p>
              <span className="card-link">Work with AI ↗</span>
            </button>
            <button className="workflow-card" onClick={() => openEditor()}>
              <span className="workflow-icon teal">♫</span>
              <span className="workflow-number">03 / SYNC</span>
              <strong>Music &amp; reference</strong>
              <p>Bring in a soundtrack or reference video to guide your ideas.</p>
              <span className="card-link">Start a project ↗</span>
            </button>
          </div>
        </section>

        <CloudWorkspace
          localProjects={projects}
          cloudSyncEnabled={cloudSyncEnabled}
          mediaSyncEnabled={mediaSyncEnabled}
          syncMessage={cloudSyncMessage}
          onCloudSyncEnabledChange={setCloudSyncPreference}
          onMediaSyncEnabledChange={setMediaSyncPreference}
          onUserChange={handleCloudUserChange}
          onSyncLocalProjects={syncAllLocalProjects}
          onRestoreProject={openCloudProject}
        />

        <section className="dashboard-section projects-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
              <h2>Recent projects</h2>
            </div>
            <button className="text-button" onClick={() => setShowCreate(true)}>
              ＋ New project
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="projects-empty">
              <div className="empty-project-icon">▱</div>
              <div>
                <strong>Your first great edit is waiting.</strong>
                <p>Create a project to open the unified editing studio.</p>
              </div>
              <button className="outline-button" onClick={() => setShowCreate(true)}>
                Create project
              </button>
            </div>
          ) : (
            <div className="recent-project-list">
              {projects.map(project => (
                <button
                  className="recent-project"
                  key={project.id}
                  onClick={() => openEditor(project)}
                >
                  <span className="project-thumb">▶</span>
                  <span className="recent-project-info">
                    <strong>{project.name}</strong>
                    <small>Video project · {project.updated}</small>
                  </span>
                  <span className="open-project">Open ↗</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <footer className="dashboard-footer">
          <span>StudioCut AI</span>
          <span>Designed for the stories only you can tell.</span>
        </footer>
      </section>

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <section className="create-modal" onClick={event => event.stopPropagation()}>
            <button className="close-button" onClick={() => setShowCreate(false)}>×</button>
            <span className="eyebrow">NEW PROJECT</span>
            <h2>Start your next edit.</h2>
            <p>Give your project a name. You can import your footage in the studio.</p>
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              autoFocus
              value={projectName}
              onChange={event => setProjectName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') createProject()
              }}
              placeholder="e.g. Cinematic gaming montage"
            />
            <button
              className="gold-button modal-submit"
              onClick={createProject}
              disabled={!projectName.trim()}
            >
              Create and open studio ↗
            </button>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
