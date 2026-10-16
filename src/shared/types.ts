export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'finished'

export type InteractionType =
  | 'pointermove'
  | 'click'
  | 'dblclick'
  | 'input'
  | 'change'
  | 'keydown'
  | 'keyup'
  | 'pointerdown'
  | 'pointerup'
  | 'wheel'
  | 'visibility'
  | 'scroll'
  | 'focus'
  | 'navigation'
  | 'page-context'

export interface Point {
  x: number
  y: number
}

export interface Rect extends Point {
  width: number
  height: number
}

export interface TargetDescriptor {
  tag: string
  role?: string
  ariaLabel?: string
  text?: string
  title?: string
  id?: string
  classes?: string[]
  selector: string
  rect: Rect
  isCanvas: boolean
  canvasPoint?: Point
}

export interface PageContext {
  url: string
  title: string
  origin: string
  path: string
  viewport: { width: number; height: number; dpr: number }
  scroll: Point
  target?: TargetDescriptor
  activeElement?: TargetDescriptor
  visibleLandmarks: TargetDescriptor[]
  visibleText: string
  capturedAt: number
}

export interface InteractionEvent {
  id: string
  sequence?: number
  at: number
  type: InteractionType
  x?: number
  y?: number
  key?: string
  value?: string
  target?: TargetDescriptor
  page?: Pick<PageContext, 'url' | 'title' | 'path'>
  detail?: string
}

export interface TranscriptSegment {
  id: string
  at: number
  text: string
  final: boolean
  confidence?: number
  endAt?: number
}

export interface AudioState {
  status: 'recording' | 'saved' | 'error' | 'interrupted'
  bytes: number
  chunks: number
  savedThrough: number
  mimeType: string
  error?: string
  inputLevel?: number
}

export interface SessionFrame {
  id: string
  at: number
  page: PageContext
  screenshot?: string
  reason: string
}

export interface FeedbackNote {
  id: string
  at: number
  text: string
  page: PageContext
  target?: TargetDescriptor
  screenshot?: string
  nearbyEvents: InteractionEvent[]
  transcriptIds: string[]
  source?: 'manual' | 'automatic'
}

export interface RecordingSession {
  id: string
  projectName: string
  startedAt: number
  endedAt?: number
  status: RecorderStatus
  startPage?: PageContext
  events: InteractionEvent[]
  eventCount?: number
  frameCount?: number
  transcript: TranscriptSegment[]
  notes: FeedbackNote[]
  frames?: SessionFrame[]
  tabId?: number
  audio?: AudioState
  transcription?: { status: 'pending' | 'running' | 'complete' | 'error'; error?: string }
}

export interface ActiveTab {
  id: number
  windowId: number
  url?: string
  title?: string
}

export type RuntimeMessage =
  | { type: 'START_RECORDING'; projectName: string }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'ADD_NOTE'; text: string; tabId?: number }
  | { type: 'GET_SESSION'; sessionId?: string; summary?: boolean }
  | { type: 'LIST_SESSIONS' }
  | { type: 'TRANSCRIBE_SESSION'; sessionId: string }
  | { type: 'AUDIO_PROGRESS'; sessionId: string; audio: AudioState }
  | { type: 'TRANSCRIPTION_STATUS'; sessionId: string; transcription: NonNullable<RecordingSession['transcription']>; segments?: TranscriptSegment[] }
  | { type: 'CLEAR_SESSION' }
  | { type: 'GET_CONTEXT'; tabId?: number }
  | { type: 'CONTENT_EVENT'; event: InteractionEvent }
  | { type: 'CONTENT_HELLO' }
  | { type: 'TRANSCRIPT_SEGMENT'; segment: TranscriptSegment; sessionId?: string }
  | { type: 'EXPORT_SESSION' }
  | { type: 'MICROPHONE_GRANTED' }

export type RuntimeResponse =
  | { ok: true; recorderProtocol?: number; buildVersion?: string; session?: RecordingSession; context?: PageContext; activeTab?: ActiveTab; sessions?: Omit<RecordingSession, 'events' | 'frames'>[] }
  | { ok: false; error: string }

