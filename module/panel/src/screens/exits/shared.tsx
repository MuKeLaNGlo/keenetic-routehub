/**
 * Общие кусочки экрана «Выходы»: подписи происхождения и жизненного цикла
 * профиля, «действительный» результат проверки, лестница правды и карточка
 * длительной операции. Только этот экран.
 */
import type { EngineId, EngineInfo, ProbeResult, Profile, Runtime, Task } from '@/api/contract'
import type { Config } from '@/api/contract'
import { ENGINE_LABEL } from '@/lib/labels'
import { TaskCard } from '@/components/rh/task'
import { useTask } from '@/state/resource'
import { toast } from 'sonner'
import type { Tone } from '@/components/rh/status'

export const profileLabel = (p: Pick<Profile, 'name' | 'alias'>) => p.alias ?? p.name

export function originLabel(p: Profile, config: Config): string {
  const origin = p.origin
  if (origin.type === 'manual') return 'Вручную'
  if (origin.type === 'file') return `Файл · ${origin.fileName}`
  const sub = config.subscriptions.find((s) => s.id === origin.subscriptionId)
  return `Подписка · ${sub?.name ?? origin.upstreamName}`
}

export const isPaused = (p: Profile) => !!p.pausedUntil && new Date(p.pausedUntil).getTime() > Date.now()

export function probeableProfiles(profiles: Profile[] = []) {
  return profiles.filter((profile) => profile.enabled && !isPaused(profile) && profile.lifecycle !== 'missing-upstream')
}

export function hasActiveProfileProbe(tasks?: Task[]) {
  return Boolean(tasks?.some(({ kind, state }) => kind === 'probe' && (state === 'pending' || state === 'running')))
}

/** Что реально известно о профиле: отключённый не может быть «доступен». */
export function effectiveProbe(p: Profile, rt: Runtime | undefined): ProbeResult {
  const raw: ProbeResult = rt?.profiles[p.id] ?? { state: 'untested', method: 'https' }
  if (p.lifecycle === 'missing-upstream') return { ...raw, state: 'missing' }
  if (!p.enabled || isPaused(p)) return { ...raw, state: 'disabled', medianMs: undefined, jitterMs: undefined, lossPct: undefined }
  return raw
}

/** Стадии жизненного цикла внутри подписки, которые надо показать. */
export const LIFECYCLE_META: Record<Profile['lifecycle'], { label: string; tone: Tone } | null> = {
  active: null,
  'missing-upstream': { label: 'Исчез из подписки', tone: 'warn' },
  'renamed-upstream': { label: 'Переименован', tone: 'info' },
  'ambiguous-replacement': { label: 'Неоднозначная замена', tone: 'warn' },
}

/** Проверка → ступень «Проверено» в лестнице правды. */
export function probeVerified(p: ProbeResult | undefined): 'ok' | 'fail' | 'partial' | 'untested' | 'na' {
  switch (p?.state) {
    case 'ok':
      return 'ok'
    case 'degraded':
    case 'stale':
      return 'partial'
    case 'down':
      return 'fail'
    case 'disabled':
    case 'incompatible':
    case 'missing':
      return 'na'
    default:
      return 'untested'
  }
}

export function engineStatusHint(e: EngineInfo): string {
  if (!e.installed) return 'Ядро не установлено'
  return e.available && e.available !== e.installed ? `Установлено ${e.installed}, доступно ${e.available}` : `Установлено ${e.installed}`
}

export const engineName = (id: EngineId) => ENGINE_LABEL[id] ?? id

/** Первое установленное ядро, которое заявляет поддержку поколения AWG. */
export function engineForGeneration(generation: string, engines: EngineInfo[] | undefined): EngineId | null {
  return engines?.find((e) => e.installed && e.capabilities.includes(`AWG ${generation}`))?.id ?? null
}

/** Запуск операции без правки конфигурации: id задачи отдаётся наверх, ошибка — тостом. */
export async function startOperation(run: () => Promise<Task>, showTask: (taskId: string) => void) {
  try {
    const t = await run()
    showTask(t.id)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

/** Живая карточка задачи, найденной по id. */
export function TaskById({ id }: { id: string }) {
  const task = useTask(id)
  if (!task) return <div className="rounded-xl bg-card px-4 py-3 text-[12.5px] text-muted-foreground ring-1 ring-border">Задача запускается…</div>
  return <TaskCard task={task} />
}
