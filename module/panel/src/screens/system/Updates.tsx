import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ChevronRight, Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Task, UpdateInfo } from '@/api/contract'
import { api } from '@/api'
import { useTasks, useUpdates } from '@/state/resource'
import { closeQuery, setQuery, useRoute } from '@/state/router'
import { EmptyState, Gate, Notice, Panel, Section } from '@/components/rh/layout'
import { StatusBadge, TaskStateBadge, type Tone } from '@/components/rh/status'
import { Mono, TimeAgo, WriteButton } from '@/components/rh/controls'
import { TaskSteps } from '@/components/rh/task'
import { DetailSheet, Modal } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { count, dateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CHANNEL, CHECK_STATE, UPDATE_STATE, requiresReleaseChecksum, updateBlockReason, updateRemedy, updateVerification } from './meta'

const HISTORY_RESULT: Record<UpdateInfo['history'][number]['result'], { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'успешно' },
  'rolled-back': { tone: 'warn', label: 'возврат' },
  failed: { tone: 'bad', label: 'ошибка' },
}

export function Updates({ compact = false }: { compact?: boolean }) {
  const updates = useUpdates()
  const { query } = useRoute()
  if (compact) {
    return (
      <Gate res={updates}>
        {(list) => list.length > 0 ? (
          <div className="space-y-3">
            <div className="divide-y overflow-hidden rounded-xl border border-border bg-card">
              {list.map((u) => <CompactUpdateCard key={u.component} u={u} selected={query.get('component') === u.component} />)}
            </div>
            {list.some(requiresReleaseChecksum) && <p className="text-xs leading-relaxed text-muted-foreground">
              AmneziaWG обновляется с пакетом RouteHub, WireGuard ASC с KeeneticOS. sing-box не установлен.
            </p>}
          </div>
        ) : <EmptyState title="Нет данных о компонентах" />}
      </Gate>
    )
  }

  return (
    <Section
      title="Обновления компонентов"
      description="Текущие версии, доступные обновления и результаты проверки пакетов."
    >
      <Gate res={updates}>
        {(list) => (
          <div className="space-y-3">
            {list.map((u) => (
              <UpdateCard key={u.component} u={u} />
            ))}
          </div>
        )}
      </Gate>
    </Section>
  )
}

function updateState(update: UpdateInfo) {
  if (requiresReleaseChecksum(update) && update.state === 'up-to-date' && !update.checks.length) {
    return { tone: 'muted' as const, label: 'Проверки ещё не было', dashed: true }
  }
  return UPDATE_STATE[update.state]
}

function taskRunning(task?: Task) {
  return task?.state === 'pending' || task?.state === 'running'
}

function useUpdateAction(update: UpdateInfo) {
  const { data: tasks } = useTasks()
  const [receipt, setReceipt] = useState<Task>()
  const [busy, setBusy] = useState(false)
  const starting = useRef(false)
  const latest = tasks?.find(({ kind, scope }) => kind === 'update' && scope === update.name)
  const live = tasks?.find(({ id }) => id === receipt?.id)
  const received = live ?? receipt
  const task = latest && (!received || Date.parse(latest.startedAt) > Date.parse(received.startedAt))
    ? latest : received ?? latest
  const active = busy || update.state === 'checking' || update.state === 'updating' || taskRunning(task)

  const act = async (kind: 'check' | 'run') => {
    if (starting.current || active || (kind === 'run' && updateBlockReason(update))) return false
    starting.current = true
    setBusy(true)
    try {
      const result = kind === 'check' ? await api.checkUpdate(update.component) : await api.runUpdate(update.component)
      setReceipt(result)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Нет ответа от роутера.'
      toast.error(kind === 'check' ? 'Проверка не запущена' : 'Обновление не запущено', { description: message })
      return false
    } finally {
      starting.current = false
      setBusy(false)
    }
  }
  return { task, active, act }
}

function UpdateCard({ u }: { u: UpdateInfo }) {
  const { task, active, act } = useUpdateAction(u)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const state = updateState(u)
  const verification = updateVerification(u)
  const reason = updateBlockReason(u)
  const remedy = updateRemedy(u)
  const fail = u.checks.find((c) => c.state === 'fail')
  const okCount = u.checks.filter((c) => c.state === 'ok').length

  return (
    <Panel className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <div className="text-[14px] font-medium">{u.name}</div>
          <div className="text-[12px] text-muted-foreground">
            {CHANNEL[u.channel]} ·{' '}
            <span className={cn(verification.tone === 'ok' && 'text-ok', verification.tone === 'bad' && 'text-bad')}>{verification.label}</span>
          </div>
        </div>
        <StatusBadge tone={state.tone} dashed={state.dashed}>
          {state.label}
        </StatusBadge>
      </div>

      <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <div className="text-[11.5px] text-muted-foreground">Сейчас</div>
          <Mono className="text-[13px] font-medium">{u.current}</Mono>
        </div>
        <ArrowRight className="hidden size-4 justify-self-center text-muted-foreground sm:block" />
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <div className="text-[11.5px] text-muted-foreground">Целевая версия</div>
          <Mono className="text-[13px] font-medium">{u.target ?? '—'}</Mono>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-medium">Проверки перед обновлением</span>
          {u.checks.length > 0 && (
            <span className="text-[11.5px] text-muted-foreground">
              пройдено {okCount} из {u.checks.length}
            </span>
          )}
        </div>
        {u.checks.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
            Запустите проверку, чтобы получить сведения о кандидате.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {u.checks.map((c) => {
              const cm = CHECK_STATE[c.state]
              return (
                <li key={c.label} className="flex items-start gap-2 text-[12.5px]">
                  <span className={cn('mt-0.5 shrink-0 [&>svg]:size-3.5', c.state === 'ok' ? 'text-ok' : c.state === 'fail' ? 'text-bad' : 'text-muted-foreground')}>{cm.icon}</span>
                  <div className="min-w-0">
                    <div className={cn(c.state === 'fail' && 'font-medium text-bad', c.state === 'untested' && 'text-muted-foreground')}>
                      {c.label}
                      {c.state === 'untested' && <span className="text-muted-foreground"> · не проверялось</span>}
                    </div>
                    {c.detail && <div className={cn('text-[12px] leading-relaxed', c.state === 'fail' ? 'text-bad/90' : 'text-muted-foreground')}>{c.detail}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {!requiresReleaseChecksum(u) && <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[13px]">Автообновление {u.autoUpdate ? 'включено' : 'выключено'}</div>
          <div className="text-[11.5px] leading-relaxed text-muted-foreground">В режиме просмотра.</div>
        </div>
        <Switch checked={u.autoUpdate} disabled aria-label="Автообновление (только просмотр)" />
      </div>}

      {u.state === 'blocked' && (
        <Notice tone="bad" title="Обновление заблокировано">
          {fail ? `${fail.label}: ${fail.detail ?? 'проверка не пройдена'}.` : 'Проверка совместимости не пройдена.'} Сейчас работает {u.current} — ничего не изменилось.
          {remedy && <p className="mt-1">{remedy}</p>}
        </Notice>
      )}

      {u.state === 'rolled-back' && (
        <Notice tone="warn" title="Возвращена прежняя версия">
          Сервер вернул {u.current} после сбоя при переключении.
        </Notice>
      )}

      {u.state === 'failed' && (
        <Notice tone="bad" title="Обновление завершилось ошибкой">
          Работает {u.current}. Повторите проверку, чтобы получить причину отказа и свежий кандидат.
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <WriteButton variant="outline" onClick={() => void act('check')} disabled={active}>
          <RefreshCw aria-hidden="true" /> Проверить
        </WriteButton>
        <WriteButton
          disabled={!!reason || active}
          reason={reason ?? (active ? 'Дождитесь завершения операции' : undefined)}
          onClick={() => setConfirmation(u.target)}
        >
          <Download aria-hidden="true" /> Обновить
        </WriteButton>
        {reason && u.state !== 'up-to-date' && <span className="text-[12px] text-muted-foreground">Почему нельзя: {reason.charAt(0).toLowerCase() + reason.slice(1)}</span>}
      </div>

      <Modal open={confirmation !== null} onClose={() => setConfirmation(null)}
        title={`Установить ${u.name} ${confirmation ?? ''}?`}
        footer={<div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmation(null)}>Отмена</Button>
          <WriteButton disabled={active || !!reason || confirmation !== u.target}
            onClick={async () => { if (await act('run')) setConfirmation(null) }}>Установить обновление</WriteButton>
        </div>}
      >
        <p className="text-[13px] text-muted-foreground">Во время переключения ядра соединения через RouteHub могут прерваться.</p>
      </Modal>

      <AnimatePresence>
        {task && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.3 }}>
            <TaskInline task={task} />
          </motion.div>
        )}
      </AnimatePresence>

      {u.history.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[12.5px] font-medium">История</div>
          <div className="divide-y overflow-hidden rounded-lg ring-1 ring-border">
            {u.history.map((h, i) => {
              const r = HISTORY_RESULT[h.result]
              return (
                <div key={i} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-card px-3 py-2 text-[12px]">
                  <span className="text-muted-foreground">
                    <TimeAgo at={h.at} /> · <span className="tabular">{dateTime(h.at)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Mono className="text-[12px]">
                      {h.from} → {h.to}
                    </Mono>
                    <StatusBadge tone={r.tone}>{r.label}</StatusBadge>
                  </span>
                </div>
              )
            })}
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Откат автоматический: предыдущая версия остаётся на диске до тех пор, пока контрольный трафик новой не подтвердит работу. Всего попыток: {count(u.history.length, ['запись', 'записи', 'записей'])}.
          </p>
        </div>
      )}
    </Panel>
  )
}

function CompactUpdateCard({ u, selected }: { u: UpdateInfo; selected: boolean }) {
  const { task, active, act } = useUpdateAction(u)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const state = updateState(u)
  const reason = updateBlockReason(u)
  const remedy = updateRemedy(u)
  const verification = updateVerification(u)
  const taskRepeatsChecks = task && task.state !== 'pending' && task.state !== 'running'
    && u.checks.length > 0 && task.steps.length === u.checks.length
    && task.steps.every((step, index) => step.label === u.checks[index].label)
  const open = () => setQuery({ component: u.component })

  useEffect(() => {
    if (!selected) setConfirmation(null)
  }, [selected])

  const checkButton = (
    <WriteButton variant="outline" size="sm" className="min-h-9" disabled={active} onClick={() => {
      open()
      void act('check')
    }}>
      <RefreshCw aria-hidden="true" /> Проверить
    </WriteButton>
  )
  const updateButton = u.target && (
    <WriteButton
      size="sm"
      className="min-h-9"
      disabled={active || !!reason}
      reason={reason ?? (active ? 'Дождитесь завершения операции' : undefined)}
      onClick={() => {
        setConfirmation(u.target)
        open()
      }}
    >
      <Download aria-hidden="true" /> Обновить
    </WriteButton>
  )
  const actionSlot = 'row-start-2 col-span-2 grid min-h-9 min-w-0 [&_button]:w-full [&_button]:px-1.5 [&_button]:text-xs [&_svg]:hidden @min-[640px]:row-start-1 @min-[640px]:col-span-1 @min-[640px]:[&_button]:px-2 @min-[640px]:[&_svg]:block'

  return (
    <article className="min-w-0 px-2.5 py-2.5 @min-[640px]:px-3.5 @min-[640px]:py-3">
      <div className="grid grid-cols-6 grid-rows-[minmax(2.5rem,auto)_auto] items-center gap-x-1.5 gap-y-1.5 @min-[640px]:grid-cols-[minmax(0,1fr)_9.5rem_6.4rem_6.4rem_6.6rem] @min-[640px]:grid-rows-1 @min-[640px]:gap-x-2">
        <div className="col-span-3 col-start-1 row-start-1 min-w-0 @min-[640px]:col-span-1">
          <h2 className="truncate text-sm font-semibold" title={u.name}>{u.name}</h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground" title={u.target ? `${u.current} → ${u.target}` : u.current}>
            <Mono className="min-w-0 truncate text-[11.5px]">{u.current}</Mono>
            {u.target && <><ArrowRight aria-label="к версии" className="size-3 shrink-0" /><Mono className="min-w-0 truncate text-[11.5px]">{u.target}</Mono></>}
          </p>
        </div>
        <div className="col-span-3 col-start-4 row-start-1 min-w-0 @min-[640px]:col-span-1 @min-[640px]:col-start-2">
          <StatusBadge tone={state.tone} dashed={state.dashed} className="h-auto min-h-5 max-w-full py-0.5 text-[11px] leading-tight whitespace-normal">
            <span className="min-w-0 [overflow-wrap:anywhere]">{state.label}</span>
          </StatusBadge>
        </div>
        <div className={cn(actionSlot, 'col-start-1 @min-[640px]:col-start-3')}>{checkButton}</div>
        <div className={cn(actionSlot, 'col-start-3 @min-[640px]:col-start-4')} aria-hidden={!updateButton || undefined}>{updateButton}</div>
        <div className={cn(actionSlot, 'col-start-5')}>
          <Button variant="ghost" size="sm" className="min-h-9" onClick={open} aria-label={`Подробнее о компоненте ${u.name}`}>
            Подробнее <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
      {(u.state === 'blocked' || u.state === 'failed') && <p className="mt-1.5 text-[12px] text-muted-foreground">{reason}. Продолжает работать {u.current}.</p>}
      {u.state === 'rolled-back' && <p className="mt-1.5 text-[12px] text-muted-foreground">Сбой при переключении. Роутер вернул {u.current}.</p>}

      <DetailSheet
        open={selected}
        title={u.name}
        description={u.target ? `${u.current} → ${u.target}` : `Установлена ${u.current}`}
        onClose={() => closeQuery('component')}
        width="lg"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            {confirmation ? (
              <>
                <WriteButton
                  disabled={active || !!reason || confirmation !== u.target}
                  reason={reason ?? (confirmation !== u.target ? 'Кандидат изменился. Вернитесь к списку кандидатов.' : undefined)}
                  onClick={async () => { if (await act('run')) setConfirmation(null) }}
                >
                  Установить обновление
                </WriteButton>
                <Button autoFocus variant="outline" disabled={active} onClick={() => setConfirmation(null)}>Отмена</Button>
              </>
            ) : <>{checkButton}{updateButton}</>}
          </div>
        }
      >
        <div className="space-y-4">
          {confirmation && (
            <Notice tone="warn" title={`Установить ${u.name} ${confirmation}?`}>
              Соединения через RouteHub могут прерваться при переключении. Роутер проверит трафик и при сбое вернёт {u.current}.
            </Notice>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span>{CHANNEL[u.channel]}</span>
            <span className={cn(verification.tone === 'ok' && 'text-ok', verification.tone === 'bad' && 'text-bad')}>{verification.label}</span>
            <span>{requiresReleaseChecksum(u) ? 'Установка по подтверждению' : `Автообновление ${u.autoUpdate ? 'включено' : 'выключено'}`}</span>
          </div>
          <AnimatePresence>
            {task && (
              <motion.div key={task.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.3 }}>
                <TaskInline task={task} showSteps={!taskRepeatsChecks} />
              </motion.div>
            )}
          </AnimatePresence>
          {(u.state === 'blocked' || u.state === 'failed' || u.state === 'rolled-back') && (
            <Notice tone={u.state === 'rolled-back' ? 'warn' : 'bad'} title={state.label}>
              {u.state === 'rolled-back' ? `Роутер восстановил ${u.current}.` : (
                <>
                  {reason}. Работает {u.current}.
                  {remedy && <p className="mt-1">{remedy}</p>}
                </>
              )}
            </Notice>
          )}
          {u.state !== 'checking' && <div className="space-y-2">
            <h3 className="text-[13px] font-semibold">Совместимость</h3>
            {u.checks.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">Запустите проверку доступной версии и официального пакета.</p>
            ) : (
              <ul className="space-y-1.5">
                {u.checks.map((check) => (
                  <li key={check.label} className="flex items-start gap-2 text-[12px]">
                    <span className={cn('mt-0.5 shrink-0 [&>svg]:size-3.5', check.state === 'ok' ? 'text-ok' : check.state === 'fail' ? 'text-bad' : 'text-muted-foreground')}>{CHECK_STATE[check.state].icon}</span>
                    <span className="min-w-0">
                      {check.label} <span className="sr-only">— {CHECK_STATE[check.state].label}</span>
                      {check.detail && <span className="block text-muted-foreground">{check.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>}
          {u.history.length > 0 && (
            <details className="rounded-lg border border-border px-3">
              <summary className="min-h-9 cursor-pointer py-2 text-[13px] font-medium">История обновлений</summary>
              <ul className="divide-y border-t border-border">
                {u.history.map((entry, index) => (
                  <li key={index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-[12px]">
                    <Mono>{entry.from} → {entry.to}</Mono>
                    <span className="text-muted-foreground">{dateTime(entry.at)}</span>
                    <StatusBadge tone={HISTORY_RESULT[entry.result].tone}>{HISTORY_RESULT[entry.result].label}</StatusBadge>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </DetailSheet>
    </article>
  )
}

/** Live task inside a component card — steps only, no nested card chrome. */
function TaskInline({ task, showSteps = true }: { task: Task; showSteps?: boolean }) {
  return (
    <div className="space-y-2.5 rounded-lg bg-muted/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-medium">{task.title}</div>
        <TaskStateBadge state={task.state} />
      </div>
      {showSteps && <TaskSteps steps={task.steps} />}
      {(task.summary || task.error) && (
        <div
          className={cn(
            'rounded-md px-2.5 py-1.5 text-[12px]',
            task.state === 'done' ? 'bg-ok/10' : task.state === 'restored' ? 'bg-warn/12' : task.state === 'error' ? 'bg-bad/10' : 'bg-background',
          )}
        >
          {task.summary ?? task.error}
        </div>
      )}
    </div>
  )
}
