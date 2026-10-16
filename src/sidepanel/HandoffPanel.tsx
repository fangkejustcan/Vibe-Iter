import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Copy, Download, FolderOpen } from 'lucide-react'
import type { RecordingSession } from '../shared/types'
import { getSession } from '../shared/database'
import { HANDOFF_FOLDER, handoffContext, handoffPrompt, pageAddress } from '../shared/handoff'
import { inspectHandoff, loadHandoff, saveHandoff, type HandoffDownload, type HandoffReceipt } from '../shared/handoffDownload'

interface Props {
  session: RecordingSession
  disabled: boolean
  run: (label: string, work: () => Promise<void>) => Promise<void>
}

export default function HandoffPanel({ session, disabled, run }: Props) {
  const [download, setDownload] = useState<HandoffDownload>()
  const [copied, setCopied] = useState(false)
  const current = useRef<HandoffReceipt>()
  const preview = useRef<HTMLTextAreaElement>(null)
  const context = useMemo(() => download?.receipt.context || handoffContext(session, Date.now()), [download?.receipt.context, session])
  const address = pageAddress(context.url)
  const prompt = download?.state === 'complete' && download.path ? handoffPrompt(context, download.path) : ''

  useEffect(() => {
    let active = true
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      const receipt = current.current
      try {
        if (receipt) {
          const result = await inspectHandoff(receipt)
          if (active && current.current?.exportId === receipt.exportId) setDownload(result)
        }
      } catch (error) {
        if (active && receipt && current.current?.exportId === receipt.exportId) {
          setDownload({ receipt, state: 'error', error: `无法核对下载：${String(error)}` })
        }
      } finally { checking = false }
    }
    void loadHandoff(session.id).then((receipt) => {
      if (!active || current.current) return
      current.current = receipt
      void check()
    }).catch(() => undefined)
    const timer = window.setInterval(() => { void check() }, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [session.id])

  useEffect(() => { setCopied(false) }, [download?.receipt.exportId, download?.state, download?.path])

  const save = () => run('正在保存反馈 ZIP…', async () => {
    const full = await getSession(session.id) || session
    const receipt = await saveHandoff(full)
    current.current = receipt
    setDownload({ receipt, state: 'pending' })
    setDownload(await inspectHandoff(receipt))
  })

  const copy = () => run('正在复制交接提示词…', async () => {
    if (!current.current) throw new Error('请先保存本场反馈。')
    const latest = await inspectHandoff(current.current)
    setDownload(latest)
    if (latest.state !== 'complete' || !latest.path) throw new Error(latest.error || '文件尚未保存完成。')
    try { await navigator.clipboard.writeText(handoffPrompt(latest.receipt.context, latest.path)) }
    catch {
      preview.current?.focus(); preview.current?.select()
      throw new Error('无法写入剪贴板，已选中提示词；请按 Ctrl+C（Mac：⌘C）复制。')
    }
    setCopied(true)
  })

  return <section className="control-panel handoff-panel" aria-label="反馈交接">
    <div className="panel-heading"><div><p className="section-kicker">SAVE. COPY. ITERATE.</p><h2>交给 Agent</h2></div><Archive size={18} /></div>
    <dl className="handoff-context">
      <div><dt>项目</dt><dd>{context.projectName}</dd></div>
      <div><dt>测试页</dt><dd data-testid="handoff-url">{context.url || '尚无测试页 URL'}</dd></div>
      <div><dt>端口</dt><dd data-testid="handoff-port">{address.port}</dd></div>
      <div><dt>录制时间</dt><dd>{new Date(context.startedAt).toLocaleString()}</dd></div>
      {context.projectPath && <div><dt>Worktree</dt><dd>{context.projectPath}</dd></div>}
    </dl>
    <button className="button button-primary" disabled={disabled || session.status !== 'finished' || download?.state === 'pending'} onClick={() => void save()}><Download size={14} />{download?.state === 'pending' ? '正在写入下载目录…' : download?.state === 'complete' ? '重新保存反馈 ZIP' : '保存反馈 ZIP'}</button>
    <p className="helper">自动保存到 Chrome 下载目录的 {HANDOFF_FOLDER} 文件夹，每次生成独立文件。</p>
    {!session.audio?.bytes && <p className="speech-error">本场缺少完整原音，ZIP 仅保留现有记录，并附缺失说明。</p>}
    {download?.state === 'pending' && <button className="text-button" onClick={() => void run('正在打开下载列表…', async () => { await chrome.tabs.create({ url: 'chrome://downloads' }) })}>查看 Chrome 下载进度</button>}
    {download?.state === 'error' && <p className="speech-error" role="status">{download.error}</p>}
    {download?.state === 'complete' && <>
      <p className="speech-status" data-testid="handoff-saved">文件已保存 · {new Date(context.exportedAt).toLocaleString()}</p>
      <p className="handoff-path" data-testid="handoff-path">{download.path}</p>
      <button className="text-button" disabled={disabled} onClick={() => void run('正在定位文件…', async () => { if (current.current) await chrome.downloads.show(current.current.downloadId) })}><FolderOpen size={13} />在文件夹中显示</button>
      {context.transcriptionStatus !== (session.transcription?.status || 'unavailable') && <p className="helper">转录状态已变化；重新保存可更新这份导出快照。</p>}
    </>}
    <div className="handoff-copy-row"><button className="button button-quiet" disabled={disabled || !prompt} onClick={() => void copy()}><Copy size={14} />{copied ? '已复制提示词' : '复制交接提示词'}</button></div>
    {prompt ? <><label className="field-label" htmlFor="handoff-prompt">粘贴到对应项目 / worktree 的 Agent 对话</label><textarea id="handoff-prompt" className="handoff-prompt" ref={preview} readOnly value={prompt} rows={10} spellCheck={false} /></> : <p className="helper">保存完成后显示提示词和实际文件地址，可一键复制。</p>}
    <p className="helper">提示词要求 Agent 先核对项目、worktree 与 URL / 端口；不匹配或无法确认时暂停修改并提醒你。</p>
  </section>
}
