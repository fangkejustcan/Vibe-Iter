import type { FeedbackNote, InteractionEvent, RecordingSession, TargetDescriptor, TranscriptSegment } from './types'
import { zip, strToU8, type Zippable } from 'fflate'
import { getAudioBlob } from './database'

function quote(value: string): string {
  return value.replace(/`/g, "'").replace(/\r?\n/g, ' ')
}

function targetLine(target: TargetDescriptor | undefined): string {
  if (!target) return '未识别具体元素'
  const label = target.ariaLabel || target.text || target.title || target.id || target.tag
  const coordinate = target.isCanvas && target.canvasPoint
    ? `，Canvas 相对坐标 (${target.canvasPoint.x}, ${target.canvasPoint.y})`
    : ''
  return `\`${quote(label)}\` (${target.tag}, selector: \`${quote(target.selector)}\`${coordinate})`
}

function eventLine(event: InteractionEvent, startedAt: number): string {
  const relative = ((event.at - startedAt) / 1000).toFixed(1)
  const target = event.target ? `，目标 ${targetLine(event.target)}` : ''
  const point = event.x !== undefined && event.y !== undefined ? `，坐标 (${event.x}, ${event.y})` : ''
  const value = event.value ? `，值 ${quote(event.value)}` : ''
  const key = event.key ? `，按键 ${quote(event.key)}` : ''
  return `- +${relative}s **${event.type}**${target}${point}${value}${key}${event.detail ? `，${quote(event.detail)}` : ''}`
}

function noteMarkdown(note: FeedbackNote, index: number, session: RecordingSession): string {
  const relative = ((note.at - session.startedAt) / 1000).toFixed(1)
  const recent = note.nearbyEvents
  const image = note.screenshot ? `\n\n截图已内嵌在 JSON 导出中（${Math.round(note.screenshot.length / 1024)} KB）。` : ''
  return [
    `## ${index + 1}. ${quote(note.text)}`,
    '',
    `- 时间：+${relative}s`,
    `- 页面：\`${quote(note.page.title)}\``,
    `- URL：${note.page.url}`,
    `- 视口：${note.page.viewport.width}×${note.page.viewport.height} @ ${note.page.viewport.dpr}x，滚动 (${note.page.scroll.x}, ${note.page.scroll.y})`,
    `- 当前指针目标：${targetLine(note.target)}`,
    `- 页面可见文本摘要：${quote(note.page.visibleText || '无')}`,
    image,
    '',
    '### 发生前后的操作',
    recent.length ? recent.map((event) => eventLine(event, session.startedAt)).join('\n') : '- 没有捕获到附近操作',
  ].join('\n')
}

export function sessionToMarkdown(session: RecordingSession): string {
  const duration = ((session.endedAt || Date.now()) - session.startedAt) / 1000
  const transcript = session.transcript.filter((item) => item.final && item.text.trim())
  return [
    `# Vibe Iter 试玩迭代记录：${quote(session.projectName)}`,
    '',
    '> 先核对当前对话任务、实际项目 / worktree 与下方测试页 URL、端口。URL / 端口可能被复用，不能单凭相同就确认归属。不匹配或无法确认时停止修改，提醒用户可能粘贴错会话，等待确认。确认匹配后，把这份记录作为一次完整迭代综合处理。',
    '',
    `- Session：\`${session.id}\``,
    `- 项目 / worktree：${session.projectPath ? quote(session.projectPath) : '未提供，需核对当前对话与工作目录'}`,
    `- 开始页 URL：${session.startPage?.url || '未知，需核实'}`,
    `- 开始：${new Date(session.startedAt).toLocaleString()}`,
    `- 时长：${duration.toFixed(1)} 秒`,
    `- 事件：${session.events.length} 条`,
    `- 意见：${session.notes.length} 条`,
    `- 原始音频：${session.audio?.bytes ? `已保存 ${session.audio.bytes} 字节` : '没有可用的整场录音；无法从操作事件还原语音'}`,
    '',
    '## 执行要求',
    '',
    '1. 把下面的录音、反馈、截图和操作时间线视为同一次完整迭代，综合判断并完成整体修改；不要把反馈拆成互不相关的任务后只做一部分。',
    '2. 页面是 Canvas 时，优先使用截图、Canvas 相对坐标和可见文本定位；DOM selector 只代表 Canvas 容器。',
    '3. 修改前后运行项目已有的构建或测试命令，并在完成后说明无法确定的定位。',
    '',
    '## 反馈清单',
    '',
    session.notes.length ? session.notes.map((note, index) => noteMarkdown(note, index, session)).join('\n\n') : '还没有捕获反馈。',
    '',
    '## 完整语音转录',
    '',
    transcript.length ? transcript.map((item) => `- +${((item.at - session.startedAt) / 1000).toFixed(1)}s：${quote(item.text)}`).join('\n') : '没有最终语音转录。',
    '',
    '## 完整操作时间线',
    '',
    session.events.map((event) => eventLine(event, session.startedAt)).join('\n') || '没有捕获事件。',
    '',
  ].join('\n')
}

export function sessionFileName(session: RecordingSession, extension: 'md' | 'json' | 'zip' | 'webm'): string {
  const slug = session.projectName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').replace(/^-|-$/g, '') || 'playtest'
  return `vibe-iter-${slug}-${new Date(session.startedAt).toISOString().slice(0, 10)}.${extension}`
}

export function downloadText(filename: string, value: string, mime = 'text/plain;charset=utf-8'): Promise<number> {
  return downloadBlob(filename, new Blob([value], { type: mime }))
}

export async function downloadBlob(filename: string, blob: Blob, saveAs = true): Promise<number> {
  if (!blob.size) throw new Error('文件内容为空，未创建下载。')
  const url = URL.createObjectURL(blob)
  try {
    if (!chrome.downloads?.download) throw new Error('扩展缺少下载权限，请在 chrome://extensions 刷新插件后重试。')
    return await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' })
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 60_000) }
}

export async function createSessionZip(session: RecordingSession, extraFiles: Record<string, string> = {}): Promise<Blob> {
  const audio = await getAudioBlob(session.id)
  const files: Zippable = {
    'session.json': strToU8(JSON.stringify(session, null, 2)),
    'report.md': strToU8(sessionToMarkdown(session)),
  }
  for (const [name, text] of Object.entries(extraFiles)) files[name] = strToU8(text)
  if (audio.size) files['audio.webm'] = [new Uint8Array(await audio.arrayBuffer()), { level: 0 }]
  else files['AUDIO-MISSING.txt'] = strToU8('这场记录没有保存整场原始音频。包中仅包含现存操作、文字和截图，不能从中还原未录下的声音。请刷新扩展并重新开始测试，确认“录音已验证”及音量条随说话变化。')
  for (const frame of session.frames || []) {
    if (!frame.screenshot) continue
    const data = await fetch(frame.screenshot).then((response) => response.arrayBuffer())
    files[`screenshots/${frame.id}.jpg`] = [new Uint8Array(data), { level: 0 }]
  }
  files['README.txt'] = strToU8([
    '先核对当前对话任务、项目 / worktree 与测试页 URL、端口。不匹配或无法确认时停止修改，提醒用户可能粘贴错会话，等待确认；相同端口不等于同一项目或 worktree。',
    '本场所有录音、操作、截图和反馈属于一次完整迭代，需要综合分析、完成整体修改并统一验证；不要拆成互不相关的任务后只做一部分。',
    'audio.webm 是完整原始录音，包含静音；session.json 是完整结构化记录；report.md 包含反馈。请结合原音分析，没有转录不等于没有意见。',
    '若有 HANDOFF.json / HANDOFF.md，先读取本次导出快照与交接说明，其中 ZIP 地址相对于 Chrome 下载目录，复制提示词会提供实际完整地址。',
    '所有时间均以 session.startedAt 为基准。screenshots/ 文件名对应 frames[].id。鼠标移动采样约 100ms，自动截图约 5 秒及关键操作触发；不是逐帧录像。',
  ].join('\n\n'))
  // Store entries without worker-based compression, which extension CSP can block.
  const result = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data)))
  return new Blob([result as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
}

export async function downloadSessionZip(session: RecordingSession): Promise<void> {
  await downloadBlob(sessionFileName(session, 'zip'), await createSessionZip(session))
}

export function transcriptPreview(transcript: TranscriptSegment[]): string {
  return transcript.filter((item) => item.final).slice(-3).map((item) => item.text).join(' ')
}
