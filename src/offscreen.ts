import { getAudioBlob, saveAudioChunk } from './shared/database'
import type { AudioState, TranscriptSegment } from './shared/types'

const SERVICE = 'http://127.0.0.1:4318'
let recorder: MediaRecorder | undefined
let stream: MediaStream | undefined
let sessionId = ''
let startedAt = 0
let sequence = 0
let audio: AudioState | undefined
let writes = Promise.resolve()
let meterContext: AudioContext | undefined
let analyser: AnalyserNode | undefined
let meterTimer: ReturnType<typeof setInterval> | undefined
const jobs = new Set<string>()

function notify(type: string, value: object): void {
  void chrome.runtime.sendMessage({ type, ...value }).catch(() => undefined)
}

async function start(id: string) {
  if (recorder && recorder.state !== 'inactive') throw new Error('已有测试正在录音，请先结束。')
  sessionId = id
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
  meterContext = new AudioContext()
  analyser = meterContext.createAnalyser()
  analyser.fftSize = 1024
  meterContext.createMediaStreamSource(stream).connect(analyser)
  await meterContext.resume()
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
  recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 })
  sessionId = id
  sequence = 0
  writes = Promise.resolve()
  startedAt = Date.now()
  audio = { status: 'recording', bytes: 0, chunks: 0, savedThrough: startedAt, mimeType: recorder.mimeType }
  let resolveFirst: () => void = () => undefined
  let rejectFirst: (error: unknown) => void = () => undefined
  const firstChunk = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
  const samples = new Float32Array(analyser.fftSize)
  meterTimer = setInterval(() => {
    analyser!.getFloatTimeDomainData(samples)
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    if (audio) audio.inputLevel = Math.min(100, Math.round(rms * 600))
  }, 250)
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return
    const at = Date.now()
    const index = sequence++
    writes = writes.then(async () => {
      await saveAudioChunk({ id: `${id}-${index}`, sessionId: id, sequence: index, at, blob: event.data })
      audio = { ...audio!, bytes: audio!.bytes + event.data.size, chunks: index + 1, savedThrough: at }
      resolveFirst()
      notify('AUDIO_PROGRESS', { sessionId: id, audio })
    }).catch((error: unknown) => {
      audio = { ...audio!, status: 'error', error: `录音保存失败：${String(error)}` }
      notify('AUDIO_PROGRESS', { sessionId: id, audio })
      rejectFirst(error)
      throw error
    })
    // Keep errors observed while retaining the rejected chain for stop().
    void writes.catch(() => undefined)
  }
  recorder.onerror = () => {
    audio = { ...audio!, status: 'error', error: '录音设备发生错误，已保存的音频仍可导出。' }
    notify('AUDIO_PROGRESS', { sessionId: id, audio })
  }
  stream.getAudioTracks()[0].onended = () => {
    audio = { ...audio!, status: 'interrupted', error: '麦克风连接中断，请结束测试并检查设备。' }
    notify('AUDIO_PROGRESS', { sessionId: id, audio })
  }
  recorder.start(1000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([firstChunk, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('12 秒内没有音频落盘，测试未启动。请检查麦克风和本地存储。')), 12_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
  return { ok: true, startedAt, audio }
}

async function stop(id: string) {
  if (id !== sessionId || !recorder) throw new Error('没有找到本场测试的录音器。已落盘的音频可在历史记录中导出。')
  const endedAt = Date.now()
  if (recorder.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      recorder!.addEventListener('stop', () => resolve(), { once: true })
      recorder!.stop()
    })
  }
  stream?.getTracks().forEach((track) => { track.onended = null; track.stop() })
  if (meterTimer) clearInterval(meterTimer)
  await meterContext?.close()
  await writes
  audio = { ...audio!, status: audio?.status === 'recording' ? 'saved' : audio!.status, savedThrough: endedAt }
  return { ok: true, endedAt, audio }
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch(`${SERVICE}${path}`, { ...options, signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`本机转录服务 ${response.status}：${(await response.text()).slice(0, 200)}`)
  return response.json()
}

async function transcribe(id: string, startTime: number) {
  if (jobs.has(id)) return
  jobs.add(id)
  const status = (value: object, segments?: TranscriptSegment[]) => notify('TRANSCRIPTION_STATUS', { sessionId: id, transcription: value, segments })
  try {
    status({ status: 'running' })
    const blob = await getAudioBlob(id)
    if (!blob.size) throw new Error('本场没有已保存的音频。')
    await request(`/sessions/${id}/audio`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
    await request(`/sessions/${id}/transcribe`, { method: 'POST' })
    for (;;) {
      const result = await request(`/sessions/${id}/transcription`)
      if (result.status === 'error') throw new Error(result.error)
      if (result.status === 'complete') {
        const segments: TranscriptSegment[] = result.segments.map((item: { start: number; end: number; text: string }, index: number) => ({
          id: `${id}-speech-${index}`, at: startTime + item.start * 1000, endAt: startTime + item.end * 1000, text: item.text, final: true,
        }))
        status({ status: 'complete' }, segments)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  } catch (error) {
    status({ status: 'error', error: `录音已保存，转录未完成。运行 npm run voice 后重试。${String(error)}` })
  } finally {
    jobs.delete(id)
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'recorder') return
  if (message.type === 'RECORDER_STATUS') {
    sendResponse({ ok: true, sessionId, recording: recorder?.state === 'recording', audio, startedAt, jobs: [...jobs] })
    return
  }
  if (message.type === 'RECORDER_TRANSCRIBE') {
    void transcribe(message.sessionId, message.startedAt)
    sendResponse({ ok: true })
    return
  }
  const work = message.type === 'RECORDER_START' ? start(message.sessionId) : stop(message.sessionId)
  void work.then(sendResponse).catch((error: unknown) => {
    if (message.type === 'RECORDER_START' && sessionId === message.sessionId) {
      if (recorder?.state === 'recording') recorder.stop()
      stream?.getTracks().forEach((track) => { track.onended = null; track.stop() })
      if (meterTimer) clearInterval(meterTimer)
      void meterContext?.close()
    }
    sendResponse({ ok: false, error: String(error) })
  })
  return true
})
