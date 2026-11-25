import { useSyncExternalStore } from 'react'
import { isDemo } from '@/api/mode'
import * as demo from './auth-demo'

export const MIN_PASSWORD_LENGTH = demo.MIN_PASSWORD_LENGTH

type Session = {
  status: 'loading' | 'signed-out' | 'signed-in' | 'unavailable'
  error?: string
}

const sessionPath = '/api/panel/session'
const listeners = new Set<() => void>()
let session: Session = { status: 'loading' }
let operation = 0

function publish(next: Session) {
  if (session.status === next.status && session.error === next.error) return
  session = next
  for (const listener of listeners) listener()
}

function listen(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

async function requestSession(path = sessionPath, method = 'GET', body?: object): Promise<Session> {
  const response = await fetch(path, {
    method, cache: 'no-store', credentials: 'same-origin',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json() as Session
  if (!response.ok) throw new Error(payload.error ?? `Ошибка доступа (${response.status})`)
  return payload
}

async function refresh() {
  const before = operation
  try {
    const next = await requestSession()
    if (before === operation) publish(next)
  } catch {
    if (before === operation && session.status === 'loading') {
      publish({ status: 'unavailable', error: 'Не удалось проверить доступ к RouteHub.' })
    }
  }
}

async function update(path: string, method: string, body?: object) {
  const id = ++operation
  const next = await requestSession(path, method, body)
  if (id === operation) publish(next)
}

if (!isDemo) {
  void refresh()
  window.addEventListener('pageshow', () => { void refresh() })
  window.addEventListener('routehub-session-expired', () => { void refresh() })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh()
  })
  window.setInterval(() => {
    if (!document.hidden && session.status === 'signed-in') void refresh()
  }, 45_000)
}

const useLiveSession = () => useSyncExternalStore(listen, () => session)
export const usePanelAuth = isDemo ? demo.usePanelAuth : useLiveSession
export const signIn = isDemo ? demo.signIn : (password: string) => update(sessionPath, 'POST', { password })
export const initializePassword = demo.initializePassword
export const signOut = isDemo ? async () => { demo.signOut() } : () => update(sessionPath, 'DELETE')
export const changePassword = isDemo ? demo.changePassword : (currentPassword: string, newPassword: string) =>
  update('/api/panel/password', 'PUT', { currentPassword, newPassword })
