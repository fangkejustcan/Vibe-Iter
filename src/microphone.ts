import './sidepanel/styles.css'
import { captureLocalVoice, localVoiceHealth } from './sidepanel/localVoice'

const allow = document.querySelector<HTMLButtonElement>('#allow')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const back = document.querySelector<HTMLButtonElement>('#return')!
const test = document.querySelector<HTMLButtonElement>('#test')!
const result = document.querySelector<HTMLParagraphElement>('#result')!
const service = document.querySelector<HTMLParagraphElement>('#service')!
const meter = document.querySelector<HTMLMeterElement>('#meter')!
let stream: MediaStream | null = null
let audio: AudioContext | null = null
let stopTest: (() => void) | undefined
let frame = 0

async function checkService() {
  try { service.textContent = await localVoiceHealth(); return true } catch (cause) {
    service.textContent = cause instanceof Error ? cause.message : String(cause)
    return false
  }
}
void checkService()

allow.addEventListener('click', () => {
  void (async () => {
    allow.disabled = true
    status.textContent = '请在 Chrome 提示中允许麦克风…'
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audio = new AudioContext()
      await audio.resume()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(512)
      const updateMeter = () => {
        analyser.getByteTimeDomainData(samples)
        meter.value = Math.min(100, Math.round(Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length) * 400))
        frame = requestAnimationFrame(updateMeter)
      }
      updateMeter()
      status.textContent = '麦克风已授权。请说话检查音量条；可以先测试转录，再返回游戏开始听写。'
      allow.hidden = true
      back.hidden = false
      test.disabled = false
      await chrome.runtime.sendMessage({ type: 'MICROPHONE_GRANTED' }).catch(() => undefined)
    } catch (cause) {
      const code = cause instanceof DOMException ? cause.name : 'unknown'
      const errors: Record<string, string> = {
        NotAllowedError: '麦克风被拒绝或被系统阻止。请展开下面的说明，解除阻止后重试。',
        NotFoundError: '没有检测到麦克风。请连接麦克风并检查 Windows 输入设备。',
        NotReadableError: '无法读取麦克风。请检查它是否被其他应用占用。',
      }
      status.textContent = `${errors[code] || '授权失败，请检查麦克风设置。'}（${code}）`
      allow.disabled = false
    }
  })()
})

test.addEventListener('click', () => {
  void (async () => {
    if (!audio || !stream) return
    test.disabled = true
    if (!await checkService()) { test.disabled = false; return }
    result.textContent = '正在录音，请说：“这个岛屿的标签太小了，请把文字放大一点。”'
    let received = false
    stopTest = captureLocalVoice(audio, stream, 'zh-CN', (text) => {
      received = true
      result.textContent = `识别结果：${text}`
    }, (count) => {
      if (count) result.textContent = '录音完成，正在本机转录…'
      else {
        if (!received && !result.textContent?.startsWith('转录失败')) result.textContent = '没有识别到语音。请检查音量条是否随说话变化，并重试。'
        test.disabled = false
      }
    }, (error) => { result.textContent = error })
    window.setTimeout(() => {
      stopTest?.()
      stopTest = undefined
      if (result.textContent?.startsWith('正在录音')) {
        result.textContent = '没有检测到声音，请检查输入设备和音量条。'
        test.disabled = false
      }
    }, 5000)
  })()
})

window.addEventListener('pagehide', () => {
  stopTest?.()
  cancelAnimationFrame(frame)
  stream?.getTracks().forEach((track) => track.stop())
  if (audio) void audio.close()
})

back.addEventListener('click', () => {
  void (async () => {
    let returnTab = Number(new URL(location.href).searchParams.get('returnTab'))
    try {
      const tab = await chrome.tabs.getCurrent()
      if (!returnTab && tab) {
        const tabs = await chrome.tabs.query({ windowId: tab.windowId })
        // A normal target=_blank link opens the setup page next to the game.
        returnTab = tabs.find((candidate) => candidate.index === tab.index - 1 && /^https?:/.test(candidate.url || ''))?.id || 0
      }
      if (returnTab) await chrome.tabs.update(returnTab, { active: true })
      if (tab?.id && returnTab) await chrome.tabs.remove(tab.id)
      else status.textContent = '请切换回游戏标签页，在侧栏点击“开始测试”。'
    } catch {
      status.textContent = '原游戏页面已关闭，请重新打开游戏后开始测试。'
    }
  })()
})
