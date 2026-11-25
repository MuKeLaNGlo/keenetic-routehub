/**
 * Hash router. Works from file://, integrates with browser history (back /
 * forward, gestures) and never applies anything on navigation.
 *
 * URL shape: `#/devices-preview?d=d-pixel&tab=policy`. Detail sheets are query
 * params, so Back closes them.
 */
import { useSyncExternalStore } from 'react'

export interface Route {
  path: string
  segments: string[]
  query: URLSearchParams
}

export const sectionPaths = {
  '/': '/overview-preview',
  '/journal': '/journal-preview',
  '/networks': '/networks-preview',
  '/devices': '/devices-preview',
  '/rules': '/rules-preview',
  '/trace': '/trace-preview',
  '/exits': '/exits-preview',
  '/zapret': '/zapret-preview',
  '/dns': '/dns-preview',
  '/system': '/system-preview',
} as const

const previousPanelPaths: Record<string, { path: keyof typeof sectionPaths; tab?: string }> = {
  '/overview': { path: '/' },
  '/profiles': { path: '/exits' },
  '/geoip': { path: '/rules', tab: 'geo' },
  '/startup': { path: '/system', tab: 'autostart' },
  '/check': { path: '/trace' },
}

function canonicalHash(hash: string): string {
  const value = hash.replace(/^#/, '') || '/'
  const split = value.indexOf('?')
  const rawPath = split === -1 ? value : value.slice(0, split)
  const query = split === -1 ? '' : value.slice(split)
  const path = (rawPath.startsWith('/') ? rawPath : `/${rawPath}`).replace(/\/+$/, '') || '/'
  const previous = Object.hasOwn(previousPanelPaths, path) ? previousPanelPaths[path] : undefined
  if (previous) {
    const params = new URLSearchParams(query)
    if (previous.tab && !params.has('tab')) params.set('tab', previous.tab)
    const normalized = params.toString()
    return `#${sectionPaths[previous.path]}${normalized ? `?${normalized}` : ''}`
  }
  const end = path.indexOf('/', 1)
  const section = end === -1 ? path : path.slice(0, end)
  if (section === '/games' || section === '/games-preview') return `#${sectionPaths['/']}`
  const alias = Object.hasOwn(sectionPaths, section) ? sectionPaths[section as keyof typeof sectionPaths] : undefined
  const canonical = alias ? alias + (end === -1 ? '' : path.slice(end)) : path
  return `#${canonical}${query}`
}

function parse(hash: string): Route {
  const split = hash.indexOf('?')
  const path = hash.slice(1, split === -1 ? undefined : split)
  return { path, segments: path.split('/').filter(Boolean), query: new URLSearchParams(split === -1 ? '' : hash.slice(split + 1)) }
}

function syncHash() {
  const target = canonicalHash(window.location.hash)
  if (target !== window.location.hash) history.replaceState(history.state, '', target)
  return target
}

let currentHash = syncHash()
let current = parse(currentHash)
/** Hash before the latest navigation — lets "close" use Back when it would land there. */
let previousHash: string | null = null
const listeners = new Set<() => void>()
window.addEventListener('hashchange', (e) => {
  previousHash = canonicalHash(new URL(e.oldURL).hash)
  currentHash = syncHash()
  current = parse(currentHash)
  listeners.forEach((l) => l())
})

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

export function href(path: string, query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams()
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') q.set(k, v)
  const qs = q.toString()
  return canonicalHash(`${path}${qs ? `?${qs}` : ''}`)
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const target = canonicalHash(to)
  if (target === currentHash) return
  if (opts.replace) {
    history.replaceState(history.state, '', target)
    currentHash = target
    current = parse(target)
    listeners.forEach((l) => l())
  } else {
    window.location.hash = target
  }
}

/** Set/clear query params on the current path. Push by default (Back undoes it). */
export function setQuery(patch: Record<string, string | null>, opts: { replace?: boolean } = {}) {
  const q = new URLSearchParams(current.query)
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') q.delete(k)
    else q.set(k, v)
  }
  const qs = q.toString()
  navigate(`#${current.path}${qs ? `?${qs}` : ''}`, opts)
}

/**
 * Close a URL-bound overlay (remove query keys). If the page underneath is
 * exactly where we came from, go Back — so Forward reopens it, as expected.
 */
export function closeQuery(...keys: string[]) {
  const q = new URLSearchParams(current.query)
  keys.forEach((k) => q.delete(k))
  const qs = q.toString()
  const target = `#${current.path}${qs ? `?${qs}` : ''}`
  if (previousHash === target) history.back()
  else navigate(target, { replace: true })
}
