import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Ban, Check, CircleDashed, CircleSlash, X } from 'lucide-react'
import { toast } from 'sonner'
import type { DnsPolicy, ServiceCheckItem, Task } from '@/api/contract'
import { api } from '@/api'
import { useTask } from '@/state/resource'
import { Button } from '@/components/ui/button'
import { StatusBadge, TASK } from '@/components/rh/status'
import { TimeAgo } from '@/components/rh/controls'
import { TaskSteps } from '@/components/rh/task'
import { cn } from '@/lib/utils'
import { CHECK_STATE, checkRows, isSettled, tally } from './result'

const STATE_ICON: Record<ServiceCheckItem['state'], React.ReactNode> = {
  ok: <Check strokeWidth={3} />,
  fail: <X strokeWidth={3} />,
  untested: <CircleDashed />,
  interrupted: <CircleSlash />,
  unavailable: <Ban />,
}

const reveal = { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 }, transition: { type: 'spring', bounce: 0, duration: 0.35 } } as const

export interface DnsCheckSession {
  taskId?: string
  busy?: boolean
  revision?: number
}

/**
 * DNS check: name resolution, reachability of the primary through its route,
 * TLS, the fallback, an ordinary name, a local name and plain 53. Read-only —
 * it never changes the policy.
 */
export function DnsCheck({ policy, compact = false, disabled = false, revision, session, onSessionChange }: {
  policy: DnsPolicy
  compact?: boolean
  disabled?: boolean
  revision?: number
  session?: DnsCheckSession
  onSessionChange?: (update: (current: DnsCheckSession) => DnsCheckSession) => void
}) {
  const [local, setLocal] = useState<DnsCheckSession>({})
  const launching = useRef(false)
  const { taskId, busy, revision: launchRevision } = session ?? local
  const task = useTask(taskId)
  const progressing = !!task && !isSettled(task)
  const rows = checkRows(isSettled(task) ? task : undefined)
  const counts = tally(rows)

  function updateSession(patch: Partial<DnsCheckSession>) {
    const update = (current: DnsCheckSession) => ({ ...current, ...patch })
    if (onSessionChange) onSessionChange(update)
    else setLocal(update)
  }

  async function run() {
    if (disabled || busy || launching.current || (compact && progressing)) return
    launching.current = true
    updateSession({ busy: true })
    try {
      const started = await api.dnsCheck(policy.id)
      updateSession({ taskId: started.id, revision })
    } catch (e) {
      toast.error(`Проверка не запустилась: ${(e as Error).message}`)
    } finally {
      launching.current = false
      updateSession({ busy: false })
    }
  }

  return (
    <div className={cn('space-y-3', compact ? 'px-3.5 py-2.5' : 'px-4 py-3')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{compact ? 'Действующая конфигурация' : 'Проверка DNS'}</div>
          {!compact && (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Что отвечает сейчас: имена, TLS, резервный путь и локальное имя. Конфигурацию не меняет.
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" disabled={disabled || busy || (compact && progressing)} onClick={() => void run()}>
          {compact && busy ? 'Запускаем…' : 'Проверить DNS'}
        </Button>
      </div>

      {compact && task && launchRevision !== undefined && revision !== undefined && launchRevision !== revision && (
        <p className="text-xs text-muted-foreground">Проверка запущена на r{launchRevision}. Сейчас загружена r{revision}.</p>
      )}

      <AnimatePresence initial={false}>
        {task && !isSettled(task) && (
          <motion.div key={task.id} {...reveal} className="overflow-hidden">
            <div className="rounded-lg bg-muted/40 px-3 py-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium">Идёт проверка</span>
                <TimeAgo at={task.startedAt} className="text-[11.5px] text-muted-foreground" prefix="начато " />
              </div>
              <TaskSteps steps={task.steps} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg ring-1 ring-border">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-muted/50 px-3 py-1.5 text-[11.5px] text-muted-foreground">
            <span className="font-medium">Результат проверки</span>
            <span className="tabular">
              {counts.ok} из {counts.total} проходят
              {counts.fail > 0 && <span className="text-bad"> · {counts.fail} нет</span>}
              {counts.untested > 0 && ` · ${counts.untested} не проверено`}
            </span>
          </div>
          <ol className="divide-y divide-border">
            {rows.map((r) => {
              const m = CHECK_STATE[r.state]
              return (
                <li key={r.id} className={cn('flex items-start gap-2.5 bg-card px-3 py-2', compact && 'flex-wrap gap-y-1')}>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] leading-snug">{r.label}</span>
                      {r.ms != null && <span className="tabular text-[11.5px] text-muted-foreground">{r.ms} мс</span>}
                    </span>
                    {r.detail && <span className={cn('block text-[11.5px] leading-snug', r.state === 'fail' ? 'text-bad' : 'text-muted-foreground')}>{r.detail}</span>}
                  </span>
                  <StatusBadge tone={m.tone} dashed={m.dashed} icon={STATE_ICON[r.state]}>
                    {m.label}
                  </StatusBadge>
                </li>
              )
            })}
          </ol>
          {task && <TaskFooter task={task} />}
        </div>
      )}

      {task && isSettled(task) && rows.length === 0 && <PhaseLine task={task} />}
    </div>
  )
}

function TaskFooter({ task }: { task: Task }) {
  return (
    <div className="border-t bg-card px-3 py-2 text-[11.5px] text-muted-foreground">
      <PhaseLine task={task} />
    </div>
  )
}

function PhaseLine({ task }: { task: Task }) {
  const m = TASK[task.state]
  return (
    <span>
      Проверка: <span className={m.tone === 'bad' ? 'text-bad' : m.tone === 'warn' ? 'text-warn' : 'text-foreground'}>{m.label.toLowerCase()}</span> ·{' '}
      <TimeAgo at={task.finishedAt ?? task.startedAt} />
      {(task.error ?? task.summary) && ` · ${task.error ?? task.summary}`}
    </span>
  )
}
