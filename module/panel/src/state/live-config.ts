import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api } from '@/api'
import type { Config, ConfigCollection, EntityChange } from '@/api/contract'
import { diffConfig, entityId } from '@/lib/configDiff'
import { publishServerConfig, refetch } from './resource'

let queue: Promise<unknown> = Promise.resolve()
let pending = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function changePending(delta: number) {
  pending += delta
  listeners.forEach((listener) => listener())
}

export function useSettingsSaving() {
  return useSyncExternalStore(subscribe, () => pending > 0)
}

/** Serialize local saves and build each request from the latest applied settings. */
export function saveConfigChange(change: (config: Config) => void): Promise<Config> {
  changePending(1)
  const save = queue.then(async () => {
    const before = await api.getConfig()
    const candidate = structuredClone(before)
    change(candidate)
    const after = diffConfig(before, candidate).length ? await api.saveSettings(candidate, before.revision) : before
    publishServerConfig(after)
    return after
  }).finally(() => changePending(-1))
  queue = save.catch(() => undefined)
  return save
}

type Fields = Record<string, unknown>
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

function entityList(config: Config, collection: ConfigCollection): Fields[] {
  return config[collection] as unknown as Fields[]
}

function conflict(change: EntityChange): never {
  throw new Error(`«${change.label}» уже изменилось. Проверьте текущие настройки и повторите правку.`)
}

function patchFields(current: Fields, before: Fields, desired: Fields, change: EntityChange) {
  for (const field of change.fields ?? []) {
    if (!same(current[field], before[field]) && !same(current[field], desired[field])) conflict(change)
    if (Object.hasOwn(desired, field)) current[field] = structuredClone(desired[field])
    else delete current[field]
  }
}

/** Capture a UI edit once and replay just its fields on the fresh revision. */
export async function saveConfigEdit(base: Config, label: string, mutate: (config: Config) => void): Promise<boolean> {
  try {
    const desired = structuredClone(base)
    mutate(desired)
    const changes = diffConfig(base, desired)
    if (!changes.length) return true
    await saveConfigChange((current) => {
      for (const change of changes) {
        const { collection, id, op } = change
        if (collection === 'autostart') {
          patchFields(current.autostart as unknown as Fields, base.autostart as unknown as Fields, desired.autostart as unknown as Fields, change)
          continue
        }
        if (collection === 'primaryProfileId') {
          if (current.primaryProfileId !== base.primaryProfileId && current.primaryProfileId !== desired.primaryProfileId) conflict(change)
          current.primaryProfileId = desired.primaryProfileId
          continue
        }
        const matches = (entity: Fields) => entityId(collection, entity) === id
        const list = entityList(current, collection)
        const index = list.findIndex(matches)
        const saved = list[index]
        const before = entityList(base, collection).find(matches)
        const after = entityList(desired, collection).find(matches)
        if (op === 'add') {
          if (!after || (saved && !same(saved, after))) conflict(change)
          if (!saved) list.push(structuredClone(after))
        } else if (op === 'remove') {
          if (saved && !same(saved, before)) conflict(change)
          if (saved) list.splice(index, 1)
        } else {
          if (!saved || !before || !after) conflict(change)
          patchFields(saved, before, after, change)
        }
      }
    })
    return true
  } catch (error) {
    const description = error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'В браузере не хватает места для конфигурации. Попробуйте сохранить меньший список.'
      : error instanceof Error ? error.message : label
    toast.error('Не удалось сохранить настройку', { description })
    void refetch('config')
    return false
  }
}
