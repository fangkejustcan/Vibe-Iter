import type { RecordingSession } from './types'
import { createSessionZip, downloadBlob } from './export'
import { HANDOFF_FOLDER, handoffContext, handoffFileName, handoffPrompt, type HandoffContext } from './handoff'

export interface HandoffReceipt {
  downloadId: number
  exportId: string
  relativePath: string
  context: HandoffContext
}

export interface HandoffDownload {
  receipt: HandoffReceipt
  state: 'pending' | 'complete' | 'error'
  path?: string
  error?: string
}

const key = (sessionId: string) => `vibe-iter-handoff:${sessionId}`

export async function saveHandoff(session: RecordingSession): Promise<HandoffReceipt> {
  if (session.status !== 'finished') throw new Error('请先结束这场测试，再保存反馈。')
  const context = handoffContext(session, Date.now())
  const exportId = crypto.randomUUID()
  const relativePath = `${HANDOFF_FOLDER}/${handoffFileName(context, exportId)}`
  const blob = await createSessionZip(session, {
    'HANDOFF.json': JSON.stringify(context, null, 2),
    'HANDOFF.md': handoffPrompt(context, relativePath),
  })
  const downloadId = await downloadBlob(relativePath, blob, false)
  const receipt = { downloadId, exportId, relativePath, context }
  await chrome.storage.local.set({ [key(session.id)]: receipt })
  return receipt
}

export async function loadHandoff(sessionId: string): Promise<HandoffReceipt | undefined> {
  return (await chrome.storage.local.get(key(sessionId)))[key(sessionId)]
}

export async function inspectHandoff(receipt: HandoffReceipt): Promise<HandoffDownload> {
  const [item] = await chrome.downloads.search({ id: receipt.downloadId })
  if (!item) return { receipt, state: 'error', error: '下载记录已清除，无法确认文件位置；请重新保存反馈。' }
  if (item.state === 'interrupted') return { receipt, state: 'error', error: item.error === 'USER_CANCELED'
    ? 'Chrome 取消了保存。请重试；若开启了「下载前询问每个文件的保存位置」，需确认保存，或在 Chrome 下载设置中关闭该选项。'
    : `文件未保存完成：${item.error || '下载已中断'}。请重试。` }
  if (item.state !== 'complete') return { receipt, state: 'pending' }
  if (item.exists === false) return { receipt, state: 'error', error: '导出文件已删除或移动；请重新保存反馈。' }
  if (!item.filename) return { receipt, state: 'error', error: 'Chrome 没有返回实际文件地址；请重新保存反馈。' }
  return { receipt, state: 'complete', path: item.filename }
}
