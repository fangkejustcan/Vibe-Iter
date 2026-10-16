import type { InteractionEvent, RecordingSession, SessionFrame } from './types'

let database: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('vibe-iter-recordings', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('sessions', { keyPath: 'id' })
      for (const name of ['events', 'frames', 'chunks']) {
        const store = db.createObjectStore(name, { keyPath: 'id' })
        store.createIndex('sessionId', 'sessionId')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function write(store: string, value: unknown): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('本地存储事务中止'))
  })
}

async function read<T>(store: string, id?: string, all = false): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const objectStore = db.transaction(store).objectStore(store)
    const request = all ? (id ? objectStore.index('sessionId').getAll(id) : objectStore.getAll()) : objectStore.get(id!)
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error)
  })
}

type StoredSession = Omit<RecordingSession, 'events' | 'frames'>
export async function saveSession(session: RecordingSession): Promise<void> {
  const { events: _events, frames: _frames, ...metadata } = session
  await write('sessions', { ...metadata, eventCount: session.events.length, frameCount: session.frames?.length || 0 })
}

export async function getSession(id: string): Promise<RecordingSession | null> {
  const metadata = await read<StoredSession | undefined>('sessions', id)
  if (!metadata) return null
  const [events, frames] = await Promise.all([
    read<(InteractionEvent & { sessionId: string })[]>('events', id, true),
    read<(SessionFrame & { sessionId: string })[]>('frames', id, true),
  ])
  return { ...metadata, events: events.sort((a, b) => a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : a.at - b.at), frames: frames.sort((a, b) => a.at - b.at) }
}

export const saveEvent = (sessionId: string, event: InteractionEvent) => write('events', { ...event, sessionId })
export const saveFrame = (sessionId: string, frame: SessionFrame) => write('frames', { ...frame, sessionId })
export const listSessions = () => read<StoredSession[]>('sessions', undefined, true).then((sessions) => sessions.sort((a, b) => b.startedAt - a.startedAt))

export type AudioChunk = { id: string; sessionId: string; sequence: number; at: number; blob: Blob }
export const saveAudioChunk = (chunk: AudioChunk) => write('chunks', chunk)
export const getAudioChunks = (sessionId: string) => read<AudioChunk[]>('chunks', sessionId, true).then((chunks) => chunks.sort((a, b) => a.sequence - b.sequence))

export async function getAudioBlob(sessionId: string): Promise<Blob> {
  const chunks = await getAudioChunks(sessionId)
  return new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0]?.blob.type || 'audio/webm' })
}
