import type { Point, Rect, TargetDescriptor, PageContext, InteractionType, InteractionEvent } from './shared/types'

(() => {
const scope = window as Window & { __vibeIterInstalled?: boolean }
if (scope.__vibeIterInstalled) return
scope.__vibeIterInstalled = true

let recording = false
let lastPointer: { x: number; y: number; target: Element | null } = {
  x: Math.round(window.innerWidth / 2),
  y: Math.round(window.innerHeight / 2),
  target: null,
}
let lastMoveAt = 0
let lastMoveSelector = ''
let lastScrollAt = 0

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

function textOf(element: Element | null): string {
  if (!element) return ''
  return (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function cssEscape(value: string): string {
  const escape = (window as Window & { CSS?: { escape?: (value: string) => string } }).CSS?.escape
  return escape ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

function selectorFor(element: Element): string {
  const html = element as HTMLElement
  if (html.id) return `#${cssEscape(html.id)}`
  const testId = html.getAttribute('data-testid') || html.getAttribute('data-test')
  if (testId) return `[data-testid="${cssEscape(testId)}"]`

  const parts: string[] = []
  let current: Element | null = element
  for (let depth = 0; current && depth < 4 && current !== document.body; depth += 1) {
    const tag = current.tagName.toLowerCase()
    const classes = Array.from(current.classList).filter(Boolean).slice(0, 2)
    let part = tag
    if (classes.length) part += classes.map((name) => `.${cssEscape(name)}`).join('')
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    current = current.parentElement
  }
  return parts.join(' > ') || element.tagName.toLowerCase()
}

function rectOf(element: Element): Rect {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function describe(element: Element | null, point?: Point): TargetDescriptor | undefined {
  if (!element || !(element instanceof Element)) return undefined
  const rect = rectOf(element)
  const html = element as HTMLElement
  const descriptor: TargetDescriptor = {
    tag: element.tagName.toLowerCase(),
    role: html.getAttribute('role') || undefined,
    ariaLabel: html.getAttribute('aria-label') || undefined,
    text: textOf(element) || undefined,
    title: html.getAttribute('title') || undefined,
    id: html.id || undefined,
    classes: Array.from(html.classList).filter(Boolean).slice(0, 3),
    selector: selectorFor(element),
    rect,
    isCanvas: element instanceof HTMLCanvasElement,
  }

  if (descriptor.isCanvas && point && rect.width > 0 && rect.height > 0) {
    descriptor.canvasPoint = {
      x: Math.round(((point.x - rect.x) / rect.width) * 1000) / 1000,
      y: Math.round(((point.y - rect.y) / rect.height) * 1000) / 1000,
    }
  }
  return descriptor
}

function visible(element: Element): boolean {
  const html = element as HTMLElement
  const rect = html.getBoundingClientRect()
  const style = window.getComputedStyle(html)
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth
}

function visibleLandmarks(): TargetDescriptor[] {
  const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input, select, textarea, h1, h2, h3, [aria-label]'))
  return elements
    .filter(visible)
    .slice(0, 28)
    .map((element) => describe(element))
    .filter((value): value is TargetDescriptor => Boolean(value))
}

function pageContext(): PageContext {
  const point = { x: lastPointer.x, y: lastPointer.y }
  const pointTarget = document.elementFromPoint(point.x, point.y)
  const activeTarget = document.activeElement
  const visibleText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900)
  return {
    url: window.location.href,
    title: document.title,
    origin: window.location.origin,
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    target: describe(pointTarget, point),
    activeElement: describe(activeTarget),
    visibleLandmarks: visibleLandmarks(),
    visibleText,
    capturedAt: Date.now(),
  }
}

function emit(type: InteractionType, detail: Partial<InteractionEvent> = {}): void {
  if (!recording) return
  const now = Date.now()
  const event: InteractionEvent = {
    id: createId('event'),
    at: now,
    type,
    page: { url: window.location.href, title: document.title, path: window.location.pathname },
    ...detail,
  }
  deliver(event)
}

function deliver(event: InteractionEvent): void {
  // A worker can restart between receipt and acknowledgement. Retry the same
  // ID; the worker deduplicates so a committed action is never counted twice.
  try {
    void chrome.runtime.sendMessage({ type: 'CONTENT_EVENT', event }).then((response) => {
      if (!response?.ok) window.setTimeout(() => deliver(event), 1000)
    }).catch(() => window.setTimeout(() => deliver(event), 1000))
  } catch {
    // Extension reload invalidates this page's old isolated context. A page
    // refresh installs the new content script; it cannot use the old runtime.
    recording = false
  }
}

function eventTarget(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null
}

function safeInputValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (element instanceof HTMLInputElement && element.type === 'password') return '[redacted]'
  return element.value.slice(0, 160)
}

function startListeners(): void {
  document.addEventListener('pointermove', (event) => {
    lastPointer = { x: Math.round(event.clientX), y: Math.round(event.clientY), target: event.target instanceof Element ? event.target : null }
    const now = Date.now()
    const target = describe(lastPointer.target, lastPointer)
    if (now - lastMoveAt > 100 || target?.selector !== lastMoveSelector) {
      lastMoveAt = now
      lastMoveSelector = target?.selector || ''
      emit('pointermove', { x: lastPointer.x, y: lastPointer.y, target, detail: JSON.stringify({ movementX: event.movementX, movementY: event.movementY, buttons: event.buttons, pointerLock: Boolean(document.pointerLockElement) }) })
    }
  }, true)

  document.addEventListener('click', (event) => {
    lastPointer = { x: Math.round(event.clientX), y: Math.round(event.clientY), target: eventTarget(event) }
    emit('click', { x: lastPointer.x, y: lastPointer.y, target: describe(lastPointer.target, lastPointer) })
  }, true)

  document.addEventListener('dblclick', (event) => {
    lastPointer = { x: Math.round(event.clientX), y: Math.round(event.clientY), target: eventTarget(event) }
    emit('dblclick', { x: lastPointer.x, y: lastPointer.y, target: describe(lastPointer.target, lastPointer) })
  }, true)

  document.addEventListener('input', (event) => {
    const target = eventTarget(event)
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      emit('input', { target: describe(target), value: safeInputValue(target) })
    }
  }, true)

  document.addEventListener('change', (event) => {
    const target = eventTarget(event)
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      emit('change', { target: describe(target), value: safeInputValue(target) })
    }
  }, true)

  for (const type of ['keydown', 'keyup'] as const) {
    document.addEventListener(type, (event) => {
      const target = eventTarget(event)
      const secret = target instanceof HTMLInputElement && target.type === 'password'
      emit(type, { key: secret ? '[redacted]' : event.key, target: describe(target),
        detail: secret ? undefined : JSON.stringify({ code: event.code, repeat: event.repeat, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey }) })
    }, true)
  }
  for (const type of ['pointerdown', 'pointerup'] as const) {
    document.addEventListener(type, (event) => {
      lastPointer = { x: Math.round(event.clientX), y: Math.round(event.clientY), target: eventTarget(event) }
      emit(type, { x: lastPointer.x, y: lastPointer.y, target: describe(lastPointer.target, lastPointer),
        detail: JSON.stringify({ button: event.button, buttons: event.buttons, pointerType: event.pointerType }) })
    }, true)
  }
  document.addEventListener('wheel', (event) => {
    emit('wheel', { x: event.clientX, y: event.clientY, target: describe(eventTarget(event)),
      detail: JSON.stringify({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode }) })
  }, { capture: true, passive: true })
  document.addEventListener('visibilitychange', () => emit('visibility', { detail: document.visibilityState }))
  window.addEventListener('blur', () => emit('visibility', { detail: 'window-blur' }))
  window.addEventListener('focus', () => emit('visibility', { detail: 'window-focus' }))

  document.addEventListener('focusin', (event) => {
    emit('focus', { target: describe(eventTarget(event)) })
  }, true)

  window.addEventListener('scroll', () => {
    const now = Date.now()
    if (now - lastScrollAt > 100) {
      lastScrollAt = now
      emit('scroll', { x: Math.round(window.scrollX), y: Math.round(window.scrollY) })
    }
  }, true)

  let lastUrl = location.href
  window.setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      emit('navigation', { detail: lastUrl })
    }
  }, 250)
  window.addEventListener('pagehide', () => emit('navigation', { detail: 'pagehide' }))

}

startListeners()
void chrome.runtime.sendMessage({ type: 'CONTENT_HELLO' }).then((response: { session?: { status?: string } } | undefined) => {
  if (response?.session?.status === 'recording') {
    recording = true
    emit('page-context', { target: pageContext().target })
  }
}).catch(() => undefined)

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message.type === 'START') {
    recording = true
    const context = pageContext()
    emit('page-context', { target: context.target })
    sendResponse({ ok: true, context })
  } else if (message.type === 'PAUSE') {
    recording = false
    sendResponse({ ok: true })
  } else if (message.type === 'RESUME') {
    recording = true
    sendResponse({ ok: true })
  } else if (message.type === 'STOP') {
    recording = false
    sendResponse({ ok: true, context: pageContext() })
  } else if (message.type === 'GET_CONTEXT') {
    sendResponse({ ok: true, context: pageContext() })
  }
  return false
})

})()
