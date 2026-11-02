import type { TimelineClip } from './timeline'
import type {
  LookPreset,
  TitlePosition,
  TitleStyle,
  TransitionStyle,
} from './videoStyle'

export type MusicAttribution = {
  track: string
  artist: string
  licenseUrl: string
  shareUrl: string
}

export type StoredProject = {
  id: number
  name: string
  updated: string
  cloudRevision?: number
  cloudMedia?: Array<{
    key: string
    name: string
    size: number
    lastModified: number
    type: string
    path: string
    fingerprint: string
    duration?: number
  }>
  videoFile: File | null
  videoDuration: number
  playheadTime: number
  musicFile: File | null
  musicAttribution?: MusicAttribution | null
  musicDuration: number
  musicTimelineStart: number
  musicSourceStart: number
  musicSourceEnd: number
  musicVolume: number
  videoVolume: number
  timelineClips: TimelineClip[]
  videoAssets?: Array<{ file: File; duration: number }>
  lookPreset?: LookPreset
  titleText?: string
  titleStyle?: TitleStyle
  titlePosition?: TitlePosition
  titleColor?: string
  transitionStyle?: TransitionStyle
  transitionDuration?: number
  brightness?: number
  contrast?: number
  saturation?: number
}

const DATABASE_NAME = 'studiocut-projects'
const STORE_NAME = 'projects'

function openProjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)

    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open project storage.'))
  })
}

export async function saveProject(project: StoredProject): Promise<void> {
  const database = await openProjectDatabase()

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(project)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save project.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Project save was aborted.'))
  }).finally(() => database.close())
}

export async function loadProject(id: number): Promise<StoredProject | null> {
  const database = await openProjectDatabase()

  return new Promise<StoredProject | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(id)

    request.onsuccess = () =>
      resolve((request.result as StoredProject | undefined) ?? null)
    request.onerror = () =>
      reject(request.error ?? new Error('Could not load project.'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Could not load project.'))
    }
  })
}

export async function listStoredProjects(): Promise<StoredProject[]> {
  const database = await openProjectDatabase()

  return new Promise<StoredProject[]>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).getAll()

    request.onsuccess = () => resolve(request.result as StoredProject[])
    request.onerror = () =>
      reject(request.error ?? new Error('Could not list saved projects.'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Could not list saved projects.'))
    }
  })
}
