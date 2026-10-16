import { createId } from './shared/ids'
import { BUILD_VERSION, RECORDER_PROTOCOL } from './shared/protocol'
import { getAudioChunks, getSession, listSessions, saveEvent, saveFrame, saveSession } from './shared/database'
import type { ActiveTab, FeedbackNote, PageContext, RecordingSession, RuntimeMessage, RuntimeResponse } from './shared/types'

const POINTER = 'vibe-iter-current-id'
let session: RecordingSession | null = null
let loading: Promise<void> | undefined
let lastFrameAt = 0
let queue = Promise.resolve()
let eventIds = new Set<string>()

async function recorderMessage(message: object) {
  return chrome.runtime.sendMessage({ target: 'recorder', ...message })
}

async function ensureRecorder() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
  if (!contexts.length) await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Continuously record playtest microphone audio independently of the side panel.',
  })
}

async function loadSession() {
  loading ||= (async () => {
    const stored = await chrome.storage.local.get([POINTER, 'vibe-iter-session'])
    const old = stored['vibe-iter-session'] as RecordingSession | undefined
    if (old) {
      await saveSession(old)
      for (const event of old.events) await saveEvent(old.id, event)
      await chrome.storage.local.set({ [POINTER]: old.id })
      await chrome.storage.local.remove('vibe-iter-session')
    }
    const id = old?.id || stored[POINTER]
    session = id ? await getSession(id) : null
    eventIds = new Set(session?.events.map((event) => event.id))
    const state = await recorderMessage({ type: 'RECORDER_STATUS' }).catch(() => undefined)
    if (session?.status === 'recording' || session?.status === 'paused') {
      if (state?.recording && state.sessionId === session.id) session.audio = state.audio
      else {
        const chunks = await getAudioChunks(session.id)
        session.status = 'finished'
        session.endedAt = chunks.at(-1)?.at || session.startedAt
        session.audio = {
          status: 'interrupted', chunks: chunks.length, bytes: chunks.reduce((sum, chunk) => sum + chunk.blob.size, 0),
          savedThrough: session.endedAt, mimeType: chunks[0]?.blob.type || 'audio/webm',
          error: '上次录制意外中断，已恢复落盘音频和操作。可导出或重新转录。',
        }
      }
      await saveSession(session)
      await badge()
    }
    // A browser exit also ends offscreen polling. Make every interrupted job retryable,
    // including archives that are no longer the current-session pointer.
    for (const metadata of await listSessions()) {
      if (metadata.transcription?.status !== 'running' || state?.jobs?.includes(metadata.id)) continue
      const current = metadata.id === session?.id ? session : await getSession(metadata.id)
      if (current) {
        current.transcription = { status: 'error', error: '转录任务已中断。原始录音仍在，可点击“转录整场 / 重试”。' }
        await saveSession(current)
      }
    }
  })()
  await loading
  return session
}

function broadcast(value = session) {
  // Do not copy megabytes of history to every extension context each second.
  void chrome.runtime.sendMessage({ type: 'SESSION_UPDATED', sessionId: value?.id }).catch(() => undefined)
}

function summary(current: RecordingSession): RecordingSession {
  return { ...current, events: [], frames: [], notes: [], transcript: [], eventCount: current.events.length, frameCount: current.frames?.length || 0 }
}

async function badge() {
  const bad = session?.audio?.status === 'error' || session?.audio?.status === 'interrupted'
  await chrome.action.setBadgeText({ text: bad ? 'ERR' : session?.status === 'recording' ? 'REC' : '' })
  await chrome.action.setBadgeBackgroundColor({ color: bad ? '#b83b35' : '#257b60' })
}

async function activeTab(): Promise<ActiveTab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id !== undefined ? { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title } : undefined
}

async function recordedTab(): Promise<ActiveTab | undefined> {
  if (session?.tabId === undefined) return undefined
  return chrome.tabs.get(session.tabId).then((tab) => ({ id: tab.id!, windowId: tab.windowId, url: tab.url, title: tab.title })).catch(() => undefined)
}

async function sendToTab<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined) as Promise<T | undefined>
}

async function sendWithInjection<T>(tabId: number, message: unknown): Promise<T | undefined> {
  const response = await sendToTab<T>(tabId, message)
  if (response) return response
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }) } catch { return undefined }
  return sendToTab<T>(tabId, message)
}

function fallback(tab: ActiveTab): PageContext {
  return { url: tab.url || '', title: tab.title || '', origin: '', path: '', viewport: { width: 0, height: 0, dpr: 1 }, scroll: { x: 0, y: 0 }, visibleLandmarks: [], visibleText: '', capturedAt: Date.now() }
}

async function contextFor(tab: ActiveTab): Promise<PageContext> {
  const response = await sendWithInjection<{ context?: PageContext }>(tab.id, { type: 'GET_CONTEXT' })
  return response?.context || fallback(tab)
}

async function captureFrame(reason: string) {
  const current = session
  const tab = await recordedTab()
  if (!current || !tab) return
  lastFrameAt = Date.now()
  const page = await contextFor(tab)
  let screenshot: string | undefined
  const [visible] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
  if (visible?.id === tab.id) {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 65 }).catch(() => undefined)
  }
  const frame = { id: createId('frame'), at: page.capturedAt, page, screenshot, reason }
  await saveFrame(current.id, frame)
  ;(current.frames ||= []).push(frame)
}

function automaticNotes(current: RecordingSession) {
  current.notes = current.notes.filter((note) => note.source !== 'automatic')
  for (const segment of current.transcript) {
    if (!segment.final || !segment.text.trim()) continue
    const frame = current.frames?.reduce<(NonNullable<RecordingSession['frames']>[number]) | undefined>((nearest, item) =>
      !nearest || Math.abs(item.at - segment.at) < Math.abs(nearest.at - segment.at) ? item : nearest, undefined)
    const page = frame?.page || current.startPage
    if (!page) continue
    const nearbyEvents = current.events.filter((event) => event.at >= segment.at - 8000 && event.at <= (segment.endAt || segment.at) + 3000)
    const target = nearbyEvents.filter((event) => event.at <= segment.at && event.target).at(-1)?.target || page.target
    current.notes.push({ id: `${segment.id}-note`, at: segment.at, source: 'automatic', text: segment.text, page, target,
      screenshot: frame?.screenshot, nearbyEvents, transcriptIds: [segment.id] })
  }
  current.notes.sort((a, b) => a.at - b.at)
}

async function startRecording(projectName: string): Promise<RuntimeResponse> {
  if (session?.status === 'recording') return { ok: false, error: '测试正在进行，请先结束本场。' }
  const tab = await activeTab()
  if (!tab || !/^https?:/.test(tab.url || '')) return { ok: false, error: '请先切换到要试玩的 HTTP/HTTPS 游戏页面。' }
  const context = await contextFor(tab)
  await ensureRecorder()
  const id = createId('session')
  const result = await recorderMessage({ type: 'RECORDER_START', sessionId: id })
  if (!result?.ok) {
    await chrome.tabs.create({ url: `${chrome.runtime.getURL('microphone.html')}?returnTab=${tab.id}` })
    return { ok: false, error: `无法开始录音：${result?.error || '录音器未响应'}。请在已打开的麦克风页面授权，然后回到游戏重试。` }
  }
  session = { id, projectName: projectName.trim() || 'Playtest', tabId: tab.id, startedAt: result.startedAt,
    status: 'recording', startPage: context, events: [], frames: [], transcript: [], notes: [], audio: result.audio,
    transcription: { status: 'pending' } }
  eventIds.clear()
  await saveSession(session)
  await chrome.storage.local.set({ [POINTER]: id })
  const response = await sendWithInjection<{ ok: boolean }>(tab.id, { type: 'START' })
  if (!response?.ok) {
    const stopped = await recorderMessage({ type: 'RECORDER_STOP', sessionId: id })
    session.audio = stopped.audio
    session.status = 'finished'
    session.endedAt = stopped.endedAt
    await saveSession(session)
    return { ok: false, error: '无法记录这个页面的交互，请检查扩展的网站访问权限。' }
  }
  await captureFrame('start')
  await badge()
  broadcast()
  return { ok: true, session }
}

async function transcribe(current: RecordingSession) {
  if (current.status !== 'finished') throw new Error('请先结束测试，原始音频会先完整保存，再进行整场转录。')
  await ensureRecorder()
  current.transcription = { status: 'running' }
  await saveSession(current)
  await recorderMessage({ type: 'RECORDER_TRANSCRIBE', sessionId: current.id, startedAt: current.startedAt })
  broadcast(current)
}

async function stopRecording(): Promise<RuntimeResponse> {
  if (!session || session.status === 'finished') return { ok: false, error: '当前没有正在进行的测试。' }
  const current = session
  const tab = await recordedTab()
  // Establish the same stop boundary for audio and event filtering; flush the tail before success.
  const cutoff = Date.now()
  if (tab) await sendToTab(tab.id, { type: 'STOP' })
  current.endedAt = cutoff
  const result = await recorderMessage({ type: 'RECORDER_STOP', sessionId: current.id }).catch(() => undefined)
  current.status = 'finished'
  if (result?.ok) current.audio = result.audio
  else current.audio = { ...current.audio!, status: 'interrupted', error: result?.error || '录音器中断，已落盘音频仍可导出。' }
  await captureFrame('stop')
  await saveSession(current)
  await badge()
  broadcast()
  void transcribe(current).catch(async (error: unknown) => {
    current.transcription = { status: 'error', error: String(error) }
    await saveSession(current)
    broadcast(current)
  })
  return { ok: true, session: summary(current) }
}

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  await loadSession()
  switch (message.type) {
    case 'START_RECORDING': return startRecording(message.projectName)
    case 'STOP_RECORDING': return stopRecording()
    case 'PAUSE_RECORDING': return { ok: false, error: '全程记录模式不暂停；请用结束测试保存整场。' }
    case 'GET_SESSION': {
      const current = message.sessionId && message.sessionId !== session?.id ? await getSession(message.sessionId) : session
      return { ok: true, session: current ? (message.summary ? summary(current) : current) : undefined }
    }
    case 'LIST_SESSIONS': return { ok: true, sessions: (await listSessions()).map((item) => ({ ...item, notes: [], transcript: [] })) }
    case 'CONTENT_HELLO': return { ok: true, session: sender.tab?.id === session?.tabId && session ? summary(session) : undefined }
    case 'CONTENT_EVENT': {
      if (session && sender.tab?.id === session.tabId && message.event.at >= session.startedAt &&
        (session.status === 'recording' || (session.endedAt !== undefined && message.event.at <= session.endedAt))) {
        if (eventIds.has(message.event.id)) return { ok: true }
        message.event.sequence = session.events.length
        await saveEvent(session.id, message.event)
        session.events.push(message.event)
        eventIds.add(message.event.id)
        if (session.status === 'recording' && ['click', 'change', 'navigation'].includes(message.event.type) && Date.now() - lastFrameAt > 1200) await captureFrame(message.event.type)
      }
      return { ok: true }
    }
    case 'AUDIO_PROGRESS': {
      if (session?.id === message.sessionId && session.status === 'recording') {
        session.audio = message.audio
        await saveSession(session)
        await badge()
        if (Date.now() - lastFrameAt >= 5000) await captureFrame('periodic')
        broadcast()
      }
      return { ok: true }
    }
    case 'TRANSCRIBE_SESSION': {
      const current = session?.id === message.sessionId ? session : await getSession(message.sessionId)
      if (!current) throw new Error('没有找到这场记录。')
      await transcribe(current)
      return { ok: true, session: summary(current) }
    }
    case 'TRANSCRIPTION_STATUS': {
      const current = session?.id === message.sessionId ? session : await getSession(message.sessionId)
      if (!current) throw new Error('没有找到这场记录。')
      current.transcription = message.transcription
      if (message.segments) { current.transcript = message.segments; automaticNotes(current) }
      await saveSession(current)
      broadcast(current)
      return { ok: true }
    }
    case 'ADD_NOTE': {
      if (!session) throw new Error('请先开始测试。')
      await captureFrame('manual-marker')
      const frame = session.frames?.at(-1)
      if (!frame) throw new Error('无法获取游戏画面。')
      const note: FeedbackNote = { id: createId('note'), at: Date.now(), source: 'manual', text: message.text.trim() || '手动标记',
        page: frame.page, target: frame.page.target, screenshot: frame.screenshot,
        nearbyEvents: session.events.filter((event) => event.at >= Date.now() - 15000), transcriptIds: [] }
      session.notes.push(note)
      await saveSession(session)
      broadcast()
      return { ok: true, session: summary(session) }
    }
    case 'GET_CONTEXT': {
      const tab = await recordedTab() || await activeTab()
      return tab ? { ok: true, context: await contextFor(tab), activeTab: tab } : { ok: false, error: '没有找到游戏页面。' }
    }
    case 'EXPORT_SESSION': return { ok: true, session: session || undefined }
    case 'CLEAR_SESSION': throw new Error('记录会保留在本地历史中，开始新测试不会覆盖。')
    case 'TRANSCRIPT_SEGMENT': return { ok: false, error: '请在结束测试后使用整场转录。' }
    case 'MICROPHONE_GRANTED': return { ok: true }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'recorder' || message.type === 'SESSION_UPDATED') return
  // Serialize mutations; IndexedDB commits finish before acknowledging each interaction.
  queue = queue.then(async () => {
    try { sendResponse({ ...await handleMessage(message, sender), recorderProtocol: RECORDER_PROTOCOL, buildVersion: BUILD_VERSION }) }
    catch (error) { sendResponse({ ok: false, error: String(error) }) }
  })
  return true
})

chrome.commands.onCommand.addListener((command) => {
  queue = queue.then(async () => {
    await loadSession()
    if (command === 'toggle-recording') {
      if (session?.status === 'recording') await stopRecording()
      else await startRecording(session?.projectName || 'Playtest')
    }
    if (command === 'add-note') await handleMessage({ type: 'ADD_NOTE', text: '' }, {})
  }).catch(console.error)
})
chrome.action.onClicked.addListener((tab) => { void chrome.sidePanel.open({ windowId: tab.windowId }) })
chrome.runtime.onInstalled.addListener(() => { void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }) })
