import { useEffect, useRef, useState } from 'react'
import { Activity, Archive, CirclePlay, Download, FileJson, FileText, Flag, Mic, Square, Waves } from 'lucide-react'
import type { RecordingSession, RuntimeResponse } from '../shared/types'
import { formatDuration } from '../shared/ids'
import { getAudioBlob, getSession, listSessions } from '../shared/database'
import { downloadBlob, downloadSessionZip, downloadText, sessionFileName, sessionToMarkdown } from '../shared/export'
import { BUILD_VERSION, RECORDER_PROTOCOL, RELOAD_MESSAGE } from '../shared/protocol'

async function message(value: unknown): Promise<RuntimeResponse> { return chrome.runtime.sendMessage(value) }
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

function App() {
  const [session, setSession] = useState<RecordingSession | null>(null)
  const [history, setHistory] = useState<Awaited<ReturnType<typeof listSessions>>>([])
  const [projectName, setProjectName] = useState('my-playtest')
  const [noteText, setNoteText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [now, setNow] = useState(Date.now())
  const [audioUrl, setAudioUrl] = useState('')
  const [live, setLive] = useState(false)
  const [compatible, setCompatible] = useState(false)
  const [notice, setNotice] = useState('')
  const selected = useRef('')
  const loadedVersion = useRef('')
  const refreshing = useRef(false)

  const refresh = async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const response = await message({ type: 'GET_SESSION', summary: true })
      if (!response.ok) throw new Error(response.error)
      const matches = response.recorderProtocol === RECORDER_PROTOCOL && response.buildVersion === BUILD_VERSION
      setCompatible(matches)
      if (!matches) {
        setError(RELOAD_MESSAGE)
        const legacy = await message({ type: 'EXPORT_SESSION' })
        if (legacy.ok && legacy.session) setSession(legacy.session)
        setLive(false)
        return
      }
      setLive(response.session?.status === 'recording')
      if (response.session?.status === 'recording') selected.current = response.session.id
      const all = await listSessions()
      setHistory(all)
      const id = selected.current || response.session?.id || all[0]?.id
      const metadata = all.find((item) => item.id === id)
      if (!metadata) return
      if (metadata.status === 'recording') setSession({ ...metadata, events: [], frames: [] })
      else {
        const version = `${id}-${metadata.transcription?.status}-${metadata.notes.length}-${metadata.audio?.bytes}`
        if (loadedVersion.current !== version) {
          setSession(await getSession(id!))
          loadedVersion.current = version
        }
      }
    } catch (cause) { setError(String(cause)) }
    finally { refreshing.current = false }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh() }, 2000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    let url = ''
    setAudioUrl('')
    if (session?.status === 'finished' && session.audio?.bytes) {
      void getAudioBlob(session.id).then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setAudioUrl(url)
      }).catch((cause: unknown) => setError(String(cause)))
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [session?.id, session?.status, session?.audio?.bytes])

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError(''); setNotice('')
    try { await work(); await refresh() } catch (cause) { setError(String(cause)) }
    finally { setBusy('') }
  }
  const send = async (value: unknown) => {
    const result = await message(value)
    if (!result.ok) throw new Error(result.error)
    if (result.recorderProtocol !== RECORDER_PROTOCOL || result.buildVersion !== BUILD_VERSION) throw new Error(RELOAD_MESSAGE)
    return result
  }
  const start = () => act('正在启动麦克风…', async () => {
    const ready = await send({ type: 'GET_SESSION', summary: true })
    if (!ready.ok) throw new Error(RELOAD_MESSAGE)
    const result = await send({ type: 'START_RECORDING', projectName })
    if (!result.session?.audio?.bytes || result.session.audio.status !== 'recording') throw new Error('没有音频落盘，无法确认录制已启动，请结束测试并检查麦克风。')
    selected.current = result.session?.id || ''; loadedVersion.current = ''
    setSession(result.session || null)
  })
  const stop = () => act('正在保存最后一段录音…', async () => {
    const result = await send({ type: 'STOP_RECORDING' })
    selected.current = result.session?.id || ''; loadedVersion.current = ''
    setSession(result.session || null)
  })

  const recording = session?.status === 'recording'
  const duration = session ? formatDuration(session.startedAt, session.endedAt || now) : '00:00'
  const audio = session?.audio
  const audioBad = audio?.status === 'error' || audio?.status === 'interrupted'
  const stale = recording && (!audio?.savedThrough || now - audio.savedThrough > 8000)
  const verified = !!audio?.bytes && !audioBad && !stale
  const transcription = session?.transcription
  const voiceLabel = recording ? verified ? '录音已验证 · 音频持续落盘' : '尚未确认音频持续保存，请检查设备' : transcription?.status === 'running' ? '原始录音已保存 · 正在本机整场转录' : transcription?.status === 'complete' ? '整场转录完成 · 已自动关联操作和画面' : audio?.bytes ? '原始录音已保存 · 可稍后转录' : '本场没有保存整场录音，只有现存操作记录。'
  const exportFile = (kind: 'zip' | 'md' | 'json') => act('正在准备下载…', async () => {
    if (!session) throw new Error('没有可导出的记录。')
    const full = await getSession(session.id) || session
    if (kind === 'zip') await downloadSessionZip(full)
    else if (kind === 'md') await downloadText(sessionFileName(full, 'md'), sessionToMarkdown(full))
    else await downloadText(sessionFileName(full, 'json'), JSON.stringify(full, null, 2), 'application/json')
    setNotice(full.audio?.bytes ? '下载已提交给 Chrome，请查看下载列表。' : `已导出现存记录。本场没有完整原始录音。${kind === 'zip' ? 'ZIP 中附有 AUDIO-MISSING.txt 说明。' : ''}`)
  })

  return <main className="shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Waves size={17} /></div><div><p className="eyebrow">PLAYTEST LOGGER</p><h1>Vibe Iter <small className="build-version">v{BUILD_VERSION} 全程记录版</small></h1></div></div><div className={`status-chip ${recording && verified && compatible ? 'recording' : 'idle'}`}><span className="status-dot" />{!compatible ? '后台待更新' : audioBad || stale ? '录音异常' : recording ? verified ? '录音已验证' : '等待音频' : session ? audio?.bytes ? '录音已保存' : '无完整录音' : '等待开始'}</div></header>
    {error && <div className="error-toast" role="alert">{error}</div>}
    {notice && <p className="speech-status" role="status">{notice}</p>}
    {!!session && !recording && !audio?.bytes && <p className="speech-error" role="status">这场没有可播放的整场录音。操作事件不代表声音已录下；导出仅能保留现有操作和文字。</p>}
    <section className="hero-panel"><div className="hero-copy"><p className="section-kicker">PRESS START. PLAY. TALK.</p><p className="hero-title">专心玩，随时说。<br /><em>整场都会留下。</em></p><p className="hero-subtitle">开始后持续保存语音、操作和关键画面；结束后自动转录，整理为 Codex 可读的反馈。</p></div><Activity size={22} color="var(--aqua)" /></section>
    <section className="control-panel">
      <label className="field-label" htmlFor="project-name">项目名称</label><input id="project-name" className="project-input" value={projectName} disabled={live} onChange={(event) => setProjectName(event.target.value)} />
      <div className="control-row">{live ? <button className="button button-accent stop" onClick={() => void stop()} disabled={!!busy}><Square size={14} />结束测试</button> : <button className="button button-primary" onClick={() => void start()} disabled={!!busy || !compatible}><CirclePlay size={15} />开始测试</button>}<span className="duration">{duration}</span></div>
      <p className="speech-status">{busy || (recording ? '侧栏可以关闭，录音与交互继续保存。' : '只需开始与结束，无需手动保存语音意见。')}</p>
      <a className="microphone-link" href={chrome.runtime.getURL('microphone.html')} target="_blank" rel="noreferrer">麦克风授权与设备测试 ↗</a><p className="helper">快捷键 Ctrl + Shift + Y 开始 / 结束测试</p>
    </section>
    {session && <>
      <section className="context-panel"><div className="panel-heading"><div><p className="section-kicker">DURABLE CAPTURE</p><h2>整场记录</h2></div><Mic size={18} /></div>
        <p className="speech-status" data-testid="audio-status">{audioBad ? audio?.error : voiceLabel}</p>
        {recording && <div className="mic-meter"><span>麦克风输入</span><meter aria-label="麦克风输入音量" min="0" max="100" value={audio?.inputLevel || 0} /><span>{audio?.inputLevel || 0}%</span></div>}
        {recording && verified && (audio?.inputLevel || 0) === 0 && <p className="helper">正在保存音频，目前未检测到声音；说话时音量条应有变化。</p>}
        <div className="context-grid"><div><span>音频落盘</span><strong>{audio ? size(audio.bytes) : '—'}</strong></div><div><span>交互事件</span><strong data-testid="event-count">{session.eventCount ?? session.events.length}</strong></div><div><span>关键画面</span><strong>{session.frameCount ?? session.frames?.length ?? 0}</strong></div></div>
        {audio && <p className="helper">已保存 {formatDuration(session.startedAt, audio.savedThrough)} · {audio.chunks} 段 · 包含静音</p>}<div className="context-url"><span>{session.startPage?.url}</span></div>
        {audioUrl && <><audio controls src={audioUrl} className="session-audio" preload="metadata" /><button className="text-button" onClick={() => void act('准备录音…', async () => { await downloadBlob(sessionFileName(session, 'webm'), await getAudioBlob(session.id)); setNotice('录音下载已提交给 Chrome。') })}><Download size={13} />下载完整原始录音</button></>}
        {transcription?.error && <p className="speech-error">{transcription.error}</p>}
        {!recording && audio?.bytes ? <button className="button button-quiet" disabled={!!busy || transcription?.status === 'running'} onClick={() => void act('提交整场转录…', async () => { await send({ type: 'TRANSCRIBE_SESSION', sessionId: session.id }) })}>{transcription?.status === 'running' ? '整场转录中…' : transcription?.status === 'complete' ? '重新转录整场' : '转录整场 / 重试'}</button> : null}
      </section>
      {recording && <section className="note-panel"><div className="panel-heading"><div><p className="section-kicker">OPTIONAL MARKER</p><h2>文字标记（可选）</h2></div><Flag size={17} /></div><textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="说出来的意见会整场录下；这里仅用于额外文字标记。" /><div className="note-actions"><button className="button button-quiet" disabled={!!busy} onClick={() => void act('保存标记…', async () => { await send({ type: 'ADD_NOTE', text: noteText }); setNoteText('') })}>添加文字标记</button></div></section>}
      <section className="timeline-panel"><div className="panel-heading"><div><p className="section-kicker">AUTO-LINKED FEEDBACK</p><h2>语音与反馈</h2></div><span className="count-badge">{session.transcript.length} 段</span></div>
        {recording ? <p className="speech-status">{verified ? '音频正在持续保存，结束测试后自动转录。' : '尚未确认音频持续保存，请检查录音状态。'}</p> : session.notes.length ? <div className="notes-list">{session.notes.map((note) => <article className="note-row" key={note.id}><span className="note-marker" /><div className="note-content"><div className="note-meta"><time>+{formatDuration(session.startedAt, note.at)}</time><span>{note.source === 'automatic' ? '自动关联画面与操作' : '文字标记'}</span></div><p>{note.text}</p><small>{note.target?.selector || note.page.path} · {note.nearbyEvents.length} 条附近操作</small></div></article>)}</div> : <div className="empty-state compact"><Archive size={18} /><p>{!audio?.bytes ? '没有完整原始录音，也没有已保存的语音文字。' : transcription?.status === 'complete' ? '转录未识别到语音，可播放原始录音核对。' : '原始录音可以直接播放和导出；转录完成后会自动出现带时间的反馈。'}</p></div>}
      </section>
      <section className="control-panel"><div className="panel-heading"><h2>交给 Codex</h2><Archive size={18} /></div><button className="button button-primary" disabled={recording || !!busy} onClick={() => void exportFile('zip')}><Download size={14} />{audio?.bytes ? '导出完整包 ZIP' : '导出现存记录 ZIP'}</button><p className="helper">{audio?.bytes ? '包含完整录音、全部操作、截图、转录和反馈报告。' : '本场缺少完整录音，仅导出已存在的操作、文字和截图。'}</p><div className="control-row"><button className="button export-button" disabled={recording || !!busy} onClick={() => void exportFile('md')}><FileText size={13} />Markdown</button><button className="button export-button" disabled={recording || !!busy} onClick={() => void exportFile('json')}><FileJson size={13} />JSON</button></div></section>
    </>}
    {!!history.length && <section className="control-panel"><label className="field-label" htmlFor="session-history">本地历史 · 新测试不会覆盖旧记录</label><select id="session-history" className="session-history" value={session?.id || ''} disabled={live || !!busy} onChange={(event) => { selected.current = event.target.value; loadedVersion.current = ''; void refresh() }}>{history.map((item) => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {item.projectName}</option>)}</select></section>}
    <p className="privacy-note">本地保存 · 鼠标移动约 100ms 采样 · 画面约 5s 及关键操作采样</p>
  </main>
}

export default App
