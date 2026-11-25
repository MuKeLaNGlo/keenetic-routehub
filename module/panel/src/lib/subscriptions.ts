import type { Profile, SubscriptionPreview } from '@/api/contract'
import { profileFormatLabel } from '@/lib/labels'

export function subscriptionProfiles(profiles: Profile[], subscriptionId: string) {
  return profiles.filter(({ origin }) => origin.type === 'subscription' && origin.subscriptionId === subscriptionId)
}

export function subscriptionCatalogLabel(profiles: Profile[]): string | undefined {
  const formats = new Set(profiles.filter((p) => p.lifecycle !== 'missing-upstream').map(profileFormatLabel))
  if (formats.size > 1) return 'Смешанный каталог'
  return formats.values().next().value
}

export function hasSubscriptionChanges(preview: SubscriptionPreview): boolean {
  return preview.added.length > 0 || preview.changed.length > 0 || preview.missing.length > 0
}

export function hasPreviewDetails(preview: SubscriptionPreview): boolean {
  return hasSubscriptionChanges(preview) || preview.incompatible.length > 0 || preview.ambiguous.length > 0
}

export function subscriptionPreviewFailure(id: string, reason: string): SubscriptionPreview {
  return {
    subscriptionId: id, fetchedAt: new Date().toISOString(), ok: false, error: reason,
    added: [], changed: [], missing: [], incompatible: [], ambiguous: [],
  }
}
