import { useSyncExternalStore } from 'react'
import { api } from '@/api'
import type { Profile, Runtime, Task } from '@/api/contract'
import { draftStore } from '@/state/draft'
import { refetch } from '@/state/resource'
import { waitForTask } from '@/state/wait-for-task'
import { effectiveProbe, isPaused, profileLabel } from '@/screens/exits/shared'

type Target = { id: string; label: string }

export type PrimaryProfileSwitch = { target: Target } & (
  | { phase: 'checking' | 'starting' }
  | { phase: 'applying' | 'syncing'; task: Task }
  | { phase: 'finished'; task?: Task; note?: string }
  | { phase: 'blocked'; title: string; details: string[] }
)

let current: PrimaryProfileSwitch | null = null
const listeners = new Set<() => void>()
const getSnapshot = () => current

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function publish(next: PrimaryProfileSwitch) {
  current = next
  listeners.forEach((listener) => listener())
}

export function profileUnavailable(profile: Profile, runtime?: Runtime): string | undefined {
  if (!profile.enabled) return 'Профиль отключён'
  if (isPaused(profile)) return 'Профиль на паузе'

  const probe = effectiveProbe(profile, runtime)
  if (probe.state === 'missing') return 'Профиль отсутствует в подписке'
  if (probe.state === 'disabled') return 'Профиль отключён'
  if (probe.state === 'incompatible') return 'Профиль несовместим с ядром'

  const engine = runtime?.engines.find(({ id }) => id === profile.adapter.engine)
  if (engine && (engine.status === 'not-installed' || !engine.installed)) return 'Ядро профиля не установлено'
}

async function applyPrimaryProfile(target: Target, workingPrimaryAtStart?: string) {
  const fail = (title: string, details: string[] = []) => publish({ target, phase: 'blocked', title, details })
  const refresh = () => Promise.all([refetch('config'), refetch('runtime')])

  try {
    const [before, runtime] = await Promise.all([api.getConfig(), api.getRuntime()])
    if (runtime.trial) {
      return fail('На роутере уже меняются настройки', ['Дождитесь завершения текущей задачи. Её ход виден в центре задач.'])
    }
    if (runtime.loadedRevision !== before.revision) {
      void refresh()
      return fail('Роутер загружает конфигурацию', ['Повторите выбор, когда будет загружена текущая ревизия.'])
    }
    const profile = before.profiles.find(({ id }) => id === target.id)
    if (!profile) {
      void refresh()
      return fail('Профиль недоступен', ['Используйте профиль из сохранённой конфигурации.'])
    }
    target = { id: profile.id, label: profileLabel(profile) }
    const reason = profileUnavailable(profile, runtime)
    if (reason) {
      void refresh()
      return fail('Профиль недоступен', [reason])
    }
    if (before.primaryProfileId === target.id) {
      await refresh()
      publish({ target, phase: 'finished' })
      return
    }

    const candidate = { ...before, primaryProfileId: target.id }
    const plan = await api.previewApply(candidate, before.revision)
    if (plan.changes.length !== 1 || plan.changes[0]?.collection !== 'primaryProfileId') {
      void refresh()
      return fail('Конфигурация уже изменилась', ['Список обновится. Проверьте текущий профиль и повторите выбор.'])
    }
    const validationErrors = plan.errors.length ? plan.errors : plan.checks
      .filter(({ required, ok }) => required && !ok)
      .map(({ name, message }) => `Обязательная проверка «${name}» не прошла. ${message}`)
    const errors = [...validationErrors, ...plan.warnings.filter(({ level }) => level === 'error').map(({ text }) => text)]
    if (errors.length) return fail('Проверка не пройдена', [...new Set(errors)])

    publish({ target, phase: 'starting' })
    const result = await api.apply(candidate, before.revision, { mode: 'full' })
    if (!result.ok) {
      void refresh()
      return fail('Конфигурация уже изменилась', [`На роутере сохранена ревизия r${result.conflict.serverRevision}. Проверьте текущий профиль и повторите выбор.`])
    }

    publish({ target, phase: 'applying', task: result.task })
    void refetch('tasks')
    const task = await waitForTask(result.task, (task) => publish({ target, phase: 'applying', task }))
    let note: string | undefined
    if (task.state === 'done') {
      publish({ target, phase: 'syncing', task })
      try {
        const [after] = await Promise.all([api.getConfig(), refresh()])
        if (after.primaryProfileId === target.id) {
          try {
            draftStore.reconcilePrimaryProfileSwitch(before, after, workingPrimaryAtStart)
          } catch {
            note = 'Профиль применён. Не удалось согласовать черновик.'
          }
        } else note = 'На роутере уже сохранён другой основной профиль.'
      } catch {
        note = 'Применение завершилось. Текущий профиль пока не удалось подтвердить.'
      }
    } else await refresh()
    publish({ target, phase: 'finished', task, note })
  } catch (error) {
    void refresh()
    fail('Не удалось завершить смену профиля', [error instanceof Error ? error.message : String(error)])
  }
}

function isBusy(state: PrimaryProfileSwitch | null): boolean {
  return !!state && state.phase !== 'blocked' && state.phase !== 'finished'
}

export function usePrimaryProfileSwitch(canWrite: boolean) {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  function start(profile: Profile): boolean {
    if (!canWrite || isBusy(current)) return false
    const target = { id: profile.id, label: profileLabel(profile) }
    const workingPrimaryAtStart = draftStore.get()?.working.primaryProfileId
    publish({ target, phase: 'checking' })
    void applyPrimaryProfile(target, workingPrimaryAtStart)
    return true
  }
  return { state, start, busy: isBusy(state) }
}
