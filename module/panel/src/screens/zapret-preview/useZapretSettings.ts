import { useRef, useState } from 'react'
import type { ZapretService, ZapretServiceId } from '@/api/contract'
import { saveConfigChange } from '@/state/live-config'
import { refetch } from '@/state/resource'

type ZapretPatch = Partial<Omit<ZapretService, 'id'>>
export type SaveState = { phase: 'saving'; patch: ZapretPatch } | { phase: 'error'; message: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function useZapretSettings(services: ZapretService[] | undefined) {
  const [states, setStates] = useState<Partial<Record<ZapretServiceId, SaveState>>>({})
  const saving = useRef(new Set<ZapretServiceId>())

  async function save(id: ZapretServiceId, patch: ZapretPatch, isCurrent?: (service: ZapretService) => boolean) {
    if (saving.current.has(id)) return false
    const before = services?.find((service) => service.id === id)
    const fields = Object.keys(patch) as (keyof ZapretPatch)[]
    saving.current.add(id)
    setStates((previous) => ({ ...previous, [id]: { phase: 'saving', patch } }))

    try {
      await saveConfigChange((config) => {
        const service = config.zapret.find((item) => item.id === id)
        if (!service) throw new Error('Сервис больше недоступен в настройках роутера.')
        if (isCurrent && !isCurrent(service)) throw new Error('Стратегия или режим уже изменились. Запустите подбор ещё раз.')
        if (before && fields.some((field) => !same(service[field], before[field]) && !same(service[field], patch[field]))) {
          throw new Error('Настройка уже изменилась. Проверьте текущее значение и повторите действие.')
        }
        Object.assign(service, patch)
      })
      setStates((previous) => ({ ...previous, [id]: undefined }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStates((previous) => ({ ...previous, [id]: { phase: 'error', message } }))
      void Promise.all([refetch('config'), refetch('runtime')])
      return false
    } finally {
      saving.current.delete(id)
    }
  }

  return { states, save }
}
