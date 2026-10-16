const SERVICE = 'http://127.0.0.1:4318'

export async function localVoiceHealth(): Promise<string> {
  try {
    const response = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(2500) })
    const health = await response.json() as { service: string; ready: boolean; model: string; error: string }
    if (health.service !== 'vibe-iter-whisper') throw new Error('端口上不是 Vibe Iter 服务')
    if (!health.ready) throw new Error(health.error || '本地模型正在加载，请稍后重试')
    return `本机 Whisper ${health.model} 已连接`
  } catch (cause) {
    throw new Error(`本机转录未就绪：${cause instanceof Error ? cause.message : String(cause)}。请在项目目录运行 npm run voice。`)
  }
}

export function encodeWav(samples: Float32Array, sourceRate: number): ArrayBuffer {
  const rate = 16000
  const ratio = sourceRate / rate
  const length = Math.floor(samples.length / ratio)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, length * 2, true)
  for (let index = 0; index < length; index += 1) {
    const begin = Math.floor(index * ratio)
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let offset = begin; offset < end; offset += 1) sum += samples[offset]
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - begin)))
    view.setInt16(44 + index * 2, value * (value < 0 ? 32768 : 32767), true)
  }
  return buffer
}

export function captureLocalVoice(
  context: AudioContext,
  stream: MediaStream,
  language: string,
  onText: (text: string, at: number) => void,
  onPending: (count: number) => void,
  onError: (error: string) => void,
): () => void {
  const source = context.createMediaStreamSource(stream)
  // ScriptProcessor gives us raw PCM without remote code or a CSP exception.
  // The node is silent; audio is never played back through the speakers.
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silent = context.createGain()
  silent.gain.value = 0
  source.connect(processor)
  processor.connect(silent)
  silent.connect(context.destination)
  let buffers: Float32Array[] = []
  let size = 0
  let hasVoice = false
  let at = Date.now()
  let stopped = false
  let pending = 0
  let queue = Promise.resolve()
  const flush = () => {
    if (!size) return
    const count = size
    const start = at
    at = Date.now()
    const voiced = hasVoice
    const samples = new Float32Array(size)
    let offset = 0
    for (const buffer of buffers) { samples.set(buffer, offset); offset += buffer.length }
    buffers = []
    size = 0
    hasVoice = false
    if (!voiced || count < context.sampleRate * 0.15) return
    const body = encodeWav(samples, context.sampleRate)
    pending += 1
    onPending(pending)
    queue = queue.then(async () => {
      try {
        const query = new URLSearchParams({ language: language === 'zh-CN' ? 'zh' : 'en', at: String(start) })
        const response = await fetch(`${SERVICE}/transcribe?${query}`, {
          method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body,
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) throw new Error(`本机转录返回 ${response.status}`)
        const result = await response.json() as { text: string }
        if (result.text) onText(result.text, start)
      } catch (cause) {
        // Retain a failed chunk in extension storage for retry/export.
        const bytes = new Uint8Array(body)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        const key = `vibe-voice-retry-${start}`
        try {
          await chrome.storage.local.set({ [key]: { at: start, language, wav: btoa(binary) } })
          onError(`转录失败，原始音频已保存在扩展存储（${key}）。${cause instanceof Error ? cause.message : String(cause)}`)
        } catch {
          onError(`转录失败，音频备份也未成功，请停止并检查服务。${cause instanceof Error ? cause.message : String(cause)}`)
        }
      } finally {
        pending -= 1
        onPending(pending)
      }
    })
  }
  processor.onaudioprocess = (event) => {
    if (stopped) return
    const input = event.inputBuffer.getChannelData(0)
    const copy = new Float32Array(input)
    buffers.push(copy)
    size += copy.length
    const energy = copy.reduce((sum, sample) => sum + sample * sample, 0) / copy.length
    if (energy > 0.000025) hasVoice = true
    if (size >= context.sampleRate * 6) flush()
  }
  return () => {
    if (stopped) return
    stopped = true
    processor.onaudioprocess = null
    flush()
    source.disconnect()
    processor.disconnect()
    silent.disconnect()
  }
}
