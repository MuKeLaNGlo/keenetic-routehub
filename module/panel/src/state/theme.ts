import { useEffect, useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'routehub-theme'
let pref: ThemePref = 'system'
try {
  const saved = localStorage.getItem(KEY)
  if (saved === 'light' || saved === 'dark') pref = saved
} catch {
  // Keep the system theme if local storage is unavailable on the sign-in page.
}
const listeners = new Set<() => void>()
const mq = window.matchMedia('(prefers-color-scheme: dark)')

function apply() {
  const dark = pref === 'dark' || (pref === 'system' && mq.matches)
  const root = document.documentElement
  // ease the switch: no abrupt brightness jump
  root.style.transition = 'background-color 240ms ease'
  root.classList.toggle('dark', dark)
}
mq.addEventListener('change', apply)
apply()

export function setTheme(p: ThemePref) {
  pref = p
  localStorage.setItem(KEY, p)
  apply()
  listeners.forEach((l) => l())
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const p = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pref,
  )
  useEffect(apply, [p])
  return [p, setTheme]
}

export function isDark() {
  return document.documentElement.classList.contains('dark')
}
