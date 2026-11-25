import { useSyncExternalStore } from 'react'
import type { SubscriptionPreview } from '@/api/contract'

let successful = new Map<string, string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useSuccessfulPreviews() {
  return useSyncExternalStore(subscribe, () => successful)
}

export function rememberSubscriptionPreview(preview: SubscriptionPreview) {
  if (!preview.ok) return
  const previous = successful.get(preview.subscriptionId)
  if (previous && Date.parse(previous) >= Date.parse(preview.fetchedAt)) return
  successful = new Map(successful).set(preview.subscriptionId, preview.fetchedAt)
  listeners.forEach((notify) => notify())
}

export function forgetSubscriptionPreview(id: string) {
  if (!successful.has(id)) return
  successful = new Map(successful)
  successful.delete(id)
  listeners.forEach((notify) => notify())
}
