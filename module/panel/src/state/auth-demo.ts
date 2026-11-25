import { useSyncExternalStore } from 'react'

export const MIN_PASSWORD_LENGTH = 8

const PASSWORD_KEY = 'routehub-auth-v1'
const SESSION_KEY = 'routehub-auth-session-v1'
const ITERATIONS = 600_000

interface Credential {
  version: 1
  salt: string
  verifier: string
}

interface AuthSnapshot {
  status: 'setup' | 'signed-out' | 'signed-in' | 'unavailable'
  error?: string
}

const listeners = new Set<() => void>()
let operation = 0
let logoutPending = false
let snapshot = readSnapshot()

function browserCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Браузер не поддерживает проверку пароля здесь. Откройте панель через localhost или HTTPS.')
  }
  return globalThis.crypto
}

function accessStorage<T>(name: 'localStorage' | 'sessionStorage', action: (storage: Storage) => T): T {
  try {
    return action(window[name])
  } catch {
    throw new Error('Хранилище браузера недоступно. Разрешите хранение данных для панели.')
  }
}

function readCredential(): Credential | undefined {
  const raw = accessStorage('localStorage', (storage) => storage.getItem(PASSWORD_KEY))
  if (raw === null) return undefined

  try {
    const value = JSON.parse(raw) as Partial<Credential> | null
    if (value?.version === 1 && typeof value.salt === 'string' && /^[a-f0-9]{32}$/.test(value.salt)
      && typeof value.verifier === 'string' && /^[a-f0-9]{64}$/.test(value.verifier)) {
      return { version: 1, salt: value.salt, verifier: value.verifier }
    }
  } catch {
    // Keep the panel locked if the stored credentials cannot be decoded.
  }
  throw new Error('Сохранённые данные для входа повреждены.')
}

function readSession() {
  return accessStorage('sessionStorage', (storage) => storage.getItem(SESSION_KEY))
}

function writeSession(salt: string | null) {
  accessStorage('sessionStorage', (storage) => {
    if (salt === null) storage.removeItem(SESSION_KEY)
    else storage.setItem(SESSION_KEY, salt)
  })
}

function readSnapshot(): AuthSnapshot {
  try {
    if (logoutPending) {
      writeSession(null)
      logoutPending = false
    }
    browserCrypto()
    const credential = readCredential()
    const session = readSession()
    if (session !== null && session !== credential?.salt) writeSession(null)
    if (!credential) return { status: 'setup' }
    return { status: session === credential.salt ? 'signed-in' : 'signed-out' }
  } catch (error) {
    return { status: 'unavailable', error: (error as Error).message }
  }
}

function refresh() {
  const next = readSnapshot()
  if (next.status === snapshot.status && next.error === snapshot.error) return
  snapshot = next
  for (const listener of listeners) listener()
}

window.addEventListener('storage', (event) => {
  if (event.key === PASSWORD_KEY || event.key === SESSION_KEY || event.key === null) refresh()
})
window.addEventListener('pageshow', refresh)

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot() {
  return snapshot
}

export function usePanelAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function readHex(value: string) {
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

async function deriveVerifier(password: string, salt: string): Promise<string> {
  const { subtle } = browserCrypto()
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const result = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: readHex(salt), iterations: ITERATIONS }, key, 256)
  return hex(new Uint8Array(result))
}

function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH || !password.trim()) {
    throw new Error(`Введите пароль длиной от ${MIN_PASSWORD_LENGTH} символов.`)
  }
}

async function newCredential(password: string): Promise<Credential> {
  const salt = hex(browserCrypto().getRandomValues(new Uint8Array(16)))
  return { version: 1, salt, verifier: await deriveVerifier(password, salt) }
}

async function verifyPassword(password: string, credential: Credential) {
  const actual = await deriveVerifier(password, credential.salt)
  let difference = 0
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ credential.verifier.charCodeAt(i)
  if (difference) throw new Error('Неверный пароль.')
}

function ensureCurrent(id: number, expected?: Credential) {
  if (id !== operation) throw new Error('Действие отменено. Повторите попытку.')
  if (readCredential()?.salt !== expected?.salt) throw new Error('Пароль панели изменился. Войдите с актуальным паролем.')
}

function writeCredential(credential: Credential) {
  const previousSession = readSession()
  writeSession(credential.salt)
  try {
    accessStorage('localStorage', (storage) => storage.setItem(PASSWORD_KEY, JSON.stringify(credential)))
  } catch (error) {
    writeSession(previousSession)
    throw error
  }
}

async function runOperation(act: (id: number) => Promise<void>) {
  const id = ++operation
  try {
    await act(id)
  } finally {
    refresh()
  }
}

async function withCredentialLock(act: () => void) {
  const locks = globalThis.navigator?.locks
  if (locks && window.location.protocol !== 'file:') await locks.request(PASSWORD_KEY, act)
  else act()
}

/** Browser-local prototype authentication. The salt also identifies the credential revision. */
export function initializePassword(password: string): Promise<void> {
  return runOperation(async (id) => {
    validatePassword(password)
    if (readCredential()) throw new Error('Пароль уже задан. Войдите в панель.')
    const credential = await newCredential(password)
    await withCredentialLock(() => {
      ensureCurrent(id)
      writeCredential(credential)
    })
  })
}

export function signIn(password: string): Promise<void> {
  return runOperation(async (id) => {
    const credential = readCredential()
    if (!credential) throw new Error('Сначала задайте пароль панели.')
    await verifyPassword(password, credential)
    ensureCurrent(id, credential)
    writeSession(credential.salt)
  })
}

export function signOut() {
  operation += 1
  logoutPending = true
  refresh()
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return runOperation(async (id) => {
    validatePassword(newPassword)
    const credential = readCredential()
    if (!credential || readSession() !== credential.salt) throw new Error('Войдите в панель, чтобы поменять пароль.')
    await verifyPassword(currentPassword, credential)
    const next = await newCredential(newPassword)
    await withCredentialLock(() => {
      ensureCurrent(id, credential)
      writeCredential(next)
    })
  })
}
