import { createClient } from '@supabase/supabase-js'
import { Upload } from 'tus-js-client'
import type { TimelineClip } from './timeline'
import type { StoredProject } from './projectStorage'

const bucket = 'project-media'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
let configError = ''
if (supabaseUrl) {
  try {
    const parsed = new URL(supabaseUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
      configError = 'VITE_SUPABASE_URL must use HTTPS except for local development.'
    }
  } catch {
    configError = 'VITE_SUPABASE_URL must be a valid Supabase project URL.'
  }
}
export const supabaseClient = supabaseUrl && publishableKey && !configError
  ? createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

type CloudMedia = NonNullable<StoredProject['cloudMedia']>[number]
type CloudAsset = {
  key: string
  name: string
  size: number
  lastModified: number
  type: string
  path: string | null
  duration?: number
}
export type CloudUploadProgress = (filename: string, uploaded: number, total: number) => void
type SerializedProject = Omit<StoredProject, 'videoFile' | 'musicFile' | 'videoAssets' | 'timelineClips' | 'cloudMedia'> & {
  videoFile: null
  musicFile: null
  videoAssets: Array<Omit<NonNullable<StoredProject['videoAssets']>[number], 'file'> & { name: string }>
  timelineClips: Array<Omit<TimelineClip, 'file'> & { assetPath: string | null }>
  cloudMedia: CloudAsset[]
}

export type CloudProjectSummary = {
  client_id: string
  name: string
  revision: number
  updated_at: string
}
const projectSyncQueues = new Map<string, Promise<unknown>>()

function requireCloud() {
  if (!supabaseClient) {
    throw new Error('Cloud sync is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.')
  }
  return supabaseClient
}

export function cloudConfigurationStatus() {
  return {
    configured: Boolean(supabaseClient),
    url: supabaseUrl || '',
    error: configError || (!publishableKey && supabaseUrl
      ? 'VITE_SUPABASE_PUBLISHABLE_KEY is missing.'
      : ''),
  }
}

function fileFingerprint(file: File) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`
}

async function createObjectPath(userId: string, projectId: number, key: string, file: File) {
  const fingerprint = new TextEncoder().encode(fileFingerprint(file))
  const digest = await crypto.subtle.digest('SHA-256', fingerprint)
  const suffix = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `${userId}/${projectId}/${key}-${suffix}`
}

async function uploadResumable(path: string, file: File, onProgress?: CloudUploadProgress) {
  const client = requireCloud()
  const { data: { session }, error } = await client.auth.getSession()
  if (error) throw error
  if (!session) throw new Error('Sign in before syncing project media.')
  const headers = {
    authorization: `Bearer ${session.access_token}`,
    apikey: publishableKey!,
    'x-upsert': 'true',
  }

  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      fingerprint: async () => `studiocut:${path}:${file.size}:${file.lastModified}`,
      headers,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      onProgress: (uploaded, total) => onProgress?.(file.name, uploaded, total),
      onError: reject,
      onSuccess: () => resolve(),
    })
    void upload.findPreviousUploads().then(previousUploads => {
      if (previousUploads.length > 0) upload.resumeFromPreviousUpload(previousUploads[0])
      upload.start()
    }).catch(reject)
  })
}

function collectFiles(project: StoredProject) {
  const files = new Map<string, { file: File; duration?: number }>()
  project.videoAssets?.forEach((asset, index) => {
    files.set(`asset-${index}`, { file: asset.file, duration: asset.duration })
  })
  if (project.videoFile && ![...files.values()].some(entry => entry.file === project.videoFile)) {
    files.set('primary-video', { file: project.videoFile, duration: project.videoDuration })
  }
  if (project.musicFile) files.set('music', { file: project.musicFile, duration: project.musicDuration })
  return files
}

async function resolveCloudMedia(
  project: StoredProject,
  includeMedia: boolean,
  userId: string,
  onProgress?: CloudUploadProgress,
): Promise<CloudAsset[]> {
  const previous = new Map((project.cloudMedia || []).map(media => [media.key, media]))
  const files = collectFiles(project)
  const media: CloudAsset[] = []

  for (const [key, { file, duration }] of files) {
    const fingerprint = fileFingerprint(file)
    const existing = previous.get(key)
    let path = existing?.fingerprint === fingerprint ? existing.path : null
    if (!path && includeMedia) {
      path = await createObjectPath(userId, project.id, key, file)
      await uploadResumable(path, file, onProgress)
    }
    media.push({
      key,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      path,
      duration,
    })
  }
  return media
}

function serializeProject(project: StoredProject, cloudMedia: CloudAsset[]): SerializedProject {
  const assets = project.videoAssets || []
  const assetPaths = assets.map((asset, index) =>
    cloudMedia.find(media =>
      media.key === `asset-${index}` &&
      media.name === asset.file.name &&
      media.size === asset.file.size &&
      media.lastModified === asset.file.lastModified,
    )?.path || null,
  )
  const filePath = (file: File) => {
    const assetIndex = assets.findIndex(asset => asset.file === file)
    if (assetIndex >= 0) return assetPaths[assetIndex]
    return cloudMedia.find(media =>
      media.key === 'primary-video' &&
      media.name === file.name &&
      media.size === file.size &&
      media.lastModified === file.lastModified,
    )?.path || null
  }
  const { videoAssets: _videoAssets, timelineClips, cloudMedia: _cloudMedia, ...rest } = project
  return {
    ...rest,
    videoFile: null,
    musicFile: null,
    videoAssets: assets.map(asset => ({
      name: asset.file.name,
      duration: asset.duration,
    })),
    musicAttribution: project.musicAttribution,
    timelineClips: timelineClips.map(({ file, ...clip }) => ({
      ...clip,
      assetPath: filePath(file),
    })),
    cloudMedia,
  }
}

async function syncProject(
  project: StoredProject,
  includeMedia: boolean,
  onProgress?: CloudUploadProgress,
): Promise<{ revision: number; updatedAt: string; project: StoredProject }> {
  const client = requireCloud()
  const { data: { user }, error: authError } = await client.auth.getUser()
  if (authError) throw authError
  if (!user) throw new Error('Sign in before syncing projects.')

  const media = await resolveCloudMedia(project, includeMedia, user.id, onProgress)
  const serialized = serializeProject(project, media)
  const { data, error } = await client.rpc('sync_studiocut_project', {
    p_client_id: String(project.id),
    p_name: project.name,
    p_project_data: serialized,
    p_expected_revision: project.cloudRevision || 0,
  })
  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result || typeof result !== 'object') {
    throw new Error('Cloud sync returned an invalid response.')
  }
  if (result.status === 'conflict') {
    throw new Error(
      `Cloud conflict: this project is at revision ${result.revision}. Your local edits were kept; restore or reconcile the cloud copy before syncing again.`,
    )
  }
  if (result.status !== 'synced' || !Number.isInteger(result.revision)) {
    throw new Error('Cloud sync did not confirm the project revision.')
  }
  const cloudMedia: CloudMedia[] = media
    .filter(item => item.path)
    .map(item => {
      const file = filesForProjectKey(project, item.key)
      if (!file) throw new Error(`Local media "${item.name}" disappeared during cloud sync.`)
      return { ...item, path: item.path!, fingerprint: fileFingerprint(file) }
    })

  return {
    revision: result.revision,
    updatedAt: result.updated_at,
    project: { ...project, cloudRevision: result.revision, cloudMedia },
  }
}

export function syncProjectToCloud(
  project: StoredProject,
  includeMedia: boolean,
  onProgress?: CloudUploadProgress,
): Promise<{ revision: number; updatedAt: string; project: StoredProject }> {
  const key = String(project.id)
  const previous = projectSyncQueues.get(key) || Promise.resolve()
  const next = previous.catch(() => undefined).then(() => syncProject(project, includeMedia, onProgress))
  projectSyncQueues.set(key, next)
  void next.finally(() => {
    if (projectSyncQueues.get(key) === next) projectSyncQueues.delete(key)
  }).catch(() => undefined)
  return next
}

function filesForProjectKey(project: StoredProject, key: string) {
  if (key === 'music') return project.musicFile
  if (key === 'primary-video') return project.videoFile
  const index = Number(key.replace('asset-', ''))
  return Number.isInteger(index) ? project.videoAssets?.[index]?.file || null : null
}

export async function listCloudProjects(): Promise<CloudProjectSummary[]> {
  const client = requireCloud()
  const { data, error } = await client
    .from('studiocut_projects')
    .select('client_id,name,revision,updated_at')
    .order('updated_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return (data || []) as CloudProjectSummary[]
}

export async function testCloudConnection() {
  const client = requireCloud()
  const { data: { user }, error: authError } = await client.auth.getUser()
  if (authError) throw authError
  if (!user) throw new Error('Sign in before testing cloud connectivity.')
  const [projectCheck, storageCheck] = await Promise.all([
    client.from('studiocut_projects').select('client_id').limit(1),
    client.storage.from(bucket).list(user.id, { limit: 1 }),
  ])
  if (projectCheck.error) throw projectCheck.error
  if (storageCheck.error) throw storageCheck.error
  return {
    user: user.email || user.id,
    postgres: 'connected',
    storage: 'connected',
  }
}

export async function restoreCloudProject(
  clientId: string,
  revision?: number,
): Promise<{ project: StoredProject; revision: number }> {
  const client = requireCloud()
  const { data, error } = revision === undefined
    ? await client
        .from('studiocut_projects')
        .select('name,revision,project_data')
        .eq('client_id', clientId)
        .single()
    : await client
        .from('studiocut_project_versions')
        .select('name,revision,project_data')
        .eq('client_id', clientId)
        .eq('revision', revision)
        .single()
  if (error) throw error

  const source = data.project_data as SerializedProject
  const assets: Array<{ file: File; duration: number }> = []
  const fileCache = new Map<string, File>()
  for (const item of source.cloudMedia || []) {
    if (!item.path) continue
    const { data: blob, error: downloadError } = await client.storage.from(bucket).download(item.path)
    if (downloadError) throw new Error(`Could not restore ${item.name}: ${downloadError.message}`)
    fileCache.set(item.path, new File([blob], item.name, {
      type: item.type || blob.type,
      lastModified: item.lastModified,
    }))
  }
  const getFile = (path: string | null, name: string) => {
    if (!path) return null
    const file = fileCache.get(path)
    if (!file) throw new Error(`Cloud media "${name}" is not available. Enable media sync on the original device before restoring this project.`)
    return file
  }
  const mediaForKey = (key: string) => source.cloudMedia?.find(item => item.key === key)
  for (let index = 0; index < (source.videoAssets || []).length; index++) {
    const asset = source.videoAssets[index]
    const media = mediaForKey(`asset-${index}`)
    const file = getFile(media?.path || null, asset.name)
    if (!file) {
      throw new Error(`"${asset.name}" has not been uploaded. On the original device, enable media sync and sync this project first.`)
    }
    assets.push({ file, duration: asset.duration })
  }
  const assetByPath = new Map<string, File>()
  assets.forEach((asset, index) => {
    const path = mediaForKey(`asset-${index}`)?.path
    if (path) assetByPath.set(path, asset.file)
  })
  const videoFile = source.videoFile
    ? null
    : (() => {
        const media = mediaForKey('primary-video')
        return media?.path ? getFile(media.path, media.name) : null
      })()
  const musicMedia = mediaForKey('music')
  const musicFile = musicMedia?.path ? getFile(musicMedia.path, musicMedia.name) : null
  const timelineClips = source.timelineClips.map(({ assetPath, ...clip }) => {
    const file = assetPath ? assetByPath.get(assetPath) || fileCache.get(assetPath) : null
    if (!file) throw new Error(`Timeline media "${clip.name}" is unavailable in cloud storage.`)
    return { ...clip, file }
  })
  const { cloudMedia: serializedMedia, ...projectData } = source

  return {
    revision: data.revision,
    project: {
      ...projectData,
      id: Number(clientId),
      name: data.name,
      updated: new Date().toISOString(),
      videoFile,
      musicFile,
      videoAssets: assets,
      timelineClips,
      cloudRevision: data.revision,
      cloudMedia: (serializedMedia || [])
        .filter(media => media.path)
        .map(media => ({
          ...media,
          path: media.path!,
          fingerprint: `${media.name}\u0000${media.size}\u0000${media.lastModified}\u0000${media.type}`,
        })),
    },
  }
}

export async function listCloudProjectVersions(clientId: string) {
  const client = requireCloud()
  const { data, error } = await client
    .from('studiocut_project_versions')
    .select('revision,name,created_at')
    .eq('client_id', clientId)
    .order('revision', { ascending: false })
    .limit(25)
  if (error) throw error
  return data || []
}
