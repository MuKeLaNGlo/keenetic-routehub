import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { api } from '@/api'
import type { ServiceCheckItem, Task, ZapretAutoSelectResult, ZapretCheckResult, ZapretService, ZapretServiceId, ZapretStrategy } from '@/api/contract'
import { Notice } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { TaskSteps } from '@/components/rh/task'
import { Button } from '@/components/ui/button'
import { CHECK_STATE, isSettled } from '@/screens/zapret/result'
import { useTasks } from '@/state/resource'
import { waitForTask } from '@/state/wait-for-task'

type CheckKind = 'selected' | 'auto'
type Run = {
  kind: CheckKind
  starting: boolean
  taskId?: string
  settled?: Task
  error?: string
  enable?: boolean
  saved?: 'changed' | 'same' | 'stale' | 'failed'
}

export function selectionMode(service: ZapretService) {
  return service.selectionMode === 'auto' ? 'auto' : 'manual'
}

const fingerprint = (service: ZapretService) => JSON.stringify([service.enabled, service.strategyId, selectionMode(service)])

export function useStrategyChecks(
  save: (service: ZapretServiceId, strategyId: string, enable: boolean, isCurrent: (service: ZapretService) => boolean) => Promise<boolean>,
) {
  const tasks = useTasks()
  const [runs, setRuns] = useState<Partial<Record<ZapretServiceId, Run>>>({})
  const starting = useRef(new Set<ZapretServiceId>())
  const getTask = (id: string | undefined) => tasks.data?.find((task) => task.id === id)

  const state = (id: ZapretServiceId) => {
    const run = runs[id]
    const task = run?.settled ?? getTask(run?.taskId)
    return {
      run,
      task,
      busy: !!run && !run.error && (run.starting || (task ? !isSettled(task) : !tasks.error)),
      failed: !!run?.error || task?.state === 'error' || task?.state === 'cancelled',
    }
  }

  async function start(service: ZapretService, kind: CheckKind, enable = false) {
    const { id, strategyId } = service
    if (starting.current.has(id) || state(id).busy) return
    starting.current.add(id)
    const original = fingerprint(service)
    const isCurrent = (candidate: ZapretService) => fingerprint(candidate) === original
    const run: Run = { kind, enable, starting: true }
    const update = (patch: Partial<Run>) => setRuns((current) => ({ ...current, [id]: { ...run, ...current[id], ...patch } }))
    setRuns((current) => ({ ...current, [id]: run }))
    try {
      const task = kind === 'auto'
        ? await api.zapretAutoSelect(id, strategyId)
        : await api.zapretCheck(id, strategyId, 'selected')
      update({ taskId: task.id })
      if (kind !== 'auto') return

      // An enable request must finish even if the user leaves this screen.
      const settled = await waitForTask(task)
      update({ settled })
      const result = settled.result as ZapretAutoSelectResult | undefined
      if (settled.state !== 'done' || result?.service !== id || !result.strategyId) return
      if (result.applied) {
        update({ saved: result.strategyId === strategyId && service.enabled ? 'same' : 'changed' })
        return
      }

      if (result.strategyId === strategyId && (!enable || service.enabled)) {
        const config = await api.getConfig()
        const current = config.zapret.find((candidate) => candidate.id === id)
        update({ saved: current && isCurrent(current) ? 'same' : 'stale' })
      } else {
        const saved = await save(id, result.strategyId, enable, isCurrent)
        update({ saved: saved ? 'changed' : 'failed' })
      }
    } catch (error) {
      update({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      starting.current.delete(id)
      update({ starting: false })
    }
  }

  return { state, start, tasksError: tasks.error }
}

export function StrategyChecks({ service, strategies, run, task, busy, disabled, editable, error, start }: {
  service: ZapretService
  strategies: ZapretStrategy[]
  run?: Run
  task?: Task
  busy: boolean
  disabled: boolean
  editable: boolean
  error: string | null
  start: (kind: CheckKind) => void
}) {
  const available = strategies.filter((strategy) => strategy.service === service.id && strategy.readiness !== 'needs-kernel-module')
  const selected = available.find((strategy) => strategy.id === service.strategyId)
  const automatic = run?.kind === 'auto'
  const autoResult = automatic ? task?.result as ZapretAutoSelectResult | undefined : undefined
  const singleResult = run?.kind === 'selected' ? task?.result as ZapretCheckResult | undefined : undefined
  const items = autoResult?.items ?? singleResult?.items
  const candidateName = (id: string | null | undefined) => strategies.find((strategy) => strategy.id === id)?.name ?? id
  const required = items?.filter((item) => item.proto.includes('TCP'))
  const allRequiredPass = !!required?.length && required.every((item) => item.state === 'ok')
  const title = automatic
    ? autoResult?.strategyId
      ? `Найдена стратегия «${candidateName(autoResult.strategyId)}»`
      : 'Рабочая стратегия не найдена'
    : allRequiredPass ? 'Обязательные проверки TCP пройдены' : 'Обязательные проверки TCP не пройдены'

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="min-h-9" disabled={disabled || busy || !selected} onClick={() => start('selected')}>Проверить выбранную</Button>
        <Button size="sm" className="min-h-9" disabled={disabled || busy || !editable || !available.length} onClick={() => start('auto')}>Подобрать автоматически</Button>
      </div>
      {!selected && <p className="text-[12px] text-muted-foreground">Выберите доступную стратегию для ручной проверки.</p>}
      {!editable && <p className="text-[12px] text-muted-foreground">Для автоподбора и применения стратегии нужен доступ на запись.</p>}
      {(!available.length && !disabled) && <p className="text-[12px] text-muted-foreground">Каталог не содержит доступных стратегий для этого сервиса.</p>}
      {run?.error && <Notice tone="bad" title={run.taskId ? 'Не удалось получить результат проверки' : 'Проверку не удалось запустить'}>{run.error}</Notice>}
      {error && run?.taskId && !task && <Notice tone="warn" title="Результат пока недоступен">{error}</Notice>}
      {busy && !task && <p role="status" className="text-[12.5px] text-muted-foreground">Запускаем проверку…</p>}
      <AnimatePresence initial={false}>
        {task && (automatic || !items) && (
          <motion.div
            key={task.id}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 rounded-xl bg-muted/40 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-medium">{automatic ? 'Ход подбора' : 'Ход проверки'}</p>
                {busy && task.cancellable && (
                  <Button variant="ghost" size="sm" className="min-h-8" onClick={() => void api.cancelTask(task.id)}>Остановить</Button>
                )}
              </div>
              <TaskSteps steps={task.steps} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {task?.state === 'cancelled' && <Notice tone="muted" title={automatic ? 'Подбор остановлен' : 'Проверка остановлена'} />}
      {task && items && task.state !== 'cancelled' && (
        <>
          <Notice tone={allRequiredPass ? 'ok' : 'warn'} title={title}>
            {automatic && autoResult?.strategyId && <p>Обязательные проверки TCP пройдены.</p>}
            {automatic && autoResult?.strategyId && run?.saved === 'changed' && (
              <p>{run.enable ? 'Стратегия применена. Обработка включена.' : 'Стратегия применена.'}</p>
            )}
            {automatic && autoResult?.strategyId && run?.saved === 'same' && <p>Текущая стратегия подходит.</p>}
            {automatic && autoResult?.strategyId && run?.saved === 'stale' && <p>Настройки или права изменились во время подбора. Повторите подбор, чтобы сохранить результат.</p>}
            {automatic && autoResult?.strategyId && run?.saved === 'failed' && <p>Найденную стратегию не удалось применить.</p>}
            {automatic && autoResult && !autoResult.strategyId && run?.enable && <p>Обработка остаётся выключенной.</p>}
            {!automatic && singleResult && <p>Стратегия «{candidateName(singleResult.strategyId)}».</p>}
          </Notice>
          {items.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border">
              <h3 className="border-b border-border bg-muted/40 px-3 py-2 text-[12px] font-medium">
                {automatic && !autoResult?.strategyId ? `Последняя попытка · ${candidateName(autoResult?.lastCandidateId) ?? '—'}` : 'Результаты по функциям'}
              </h3>
              <ul className="divide-y">
                {items.map((item) => <ResultRow key={item.id} item={item} />)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ResultRow({ item }: { item: ServiceCheckItem }) {
  const status = CHECK_STATE[item.state]
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium">{item.label} <span className="text-[11px] font-normal text-muted-foreground">{item.proto}</span></span>
        <StatusBadge tone={status.tone} dashed={status.dashed}>{status.label}</StatusBadge>
      </div>
      {item.detail && <p className="mt-1 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>}
    </li>
  )
}
