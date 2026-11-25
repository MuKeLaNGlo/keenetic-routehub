import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  GitMerge,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Undo2,
  XCircle,
  Users,
  RefreshCw,
} from 'lucide-react'
import { api } from '@/api'
import type { ApplyPlan, ApplyResult, EntityChange, Task } from '@/api/contract'
import { COLLECTION_LABEL, fieldLabels } from '@/lib/configDiff'
import { draftStore, useDraft } from '@/state/draft'
import { closeQuery, useRoute } from '@/state/router'
import { refetch, useCaps, useRuntime, useTask, useTasks } from '@/state/resource'
import { Modal } from '@/components/rh/sheet'
import { Notice, SkeletonBlock } from '@/components/rh/layout'
import { Segmented, TimeAgo, WriteButton, useCountdown } from '@/components/rh/controls'
import { TaskSteps } from '@/components/rh/task'
import { StatusBadge, TaskStateBadge } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { count, duration } from '@/lib/format'
import type { RebaseResult } from '@/lib/configDiff'

type Stage =
  | { k: 'review' }
  | { k: 'plan' }
  | { k: 'conflict'; info: Extract<ApplyResult, { ok: false }>['conflict'] }
  | { k: 'rebased'; res: RebaseResult; from: number; to: number }
  | { k: 'running'; taskId: string; trial: boolean }

const OP_ICON = { add: <Plus />, remove: <Minus />, change: <Pencil /> }
const OP_CLS = { add: 'text-ok bg-ok/12', remove: 'text-bad bg-bad/12', change: 'text-draft bg-draft/12' }

function ChangeList({ changes, onRevert, conflictKeys }: { changes: EntityChange[]; onRevert?: (c: EntityChange) => void; conflictKeys?: Set<string> }) {
  const groups = useMemo(() => {
    const m = new Map<string, EntityChange[]>()
    for (const c of changes) m.set(c.collection, [...(m.get(c.collection) ?? []), c])
    return [...m.entries()]
  }, [changes])
  return (
    <div className="space-y-4">
      {groups.map(([col, items]) => (
        <div key={col}>
          <div className="mb-1.5 text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">{COLLECTION_LABEL[col as EntityChange['collection']]}</div>
          <ul className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            <AnimatePresence initial={false}>
              {items.map((c) => {
                const conflict = conflictKeys?.has(`${c.collection}/${c.id}`)
                return (
                  <motion.li
                    key={`${c.collection}/${c.id}`}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
                    className={cn('flex items-center gap-3 bg-card px-3 py-2.5', conflict && 'bg-warn/8')}
                  >
                    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md [&>svg]:size-3.5', OP_CLS[c.op])}>{OP_ICON[c.op]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px]">{c.label}</div>
                      {c.fields && c.fields.length > 0 && <div className="truncate text-[12px] text-muted-foreground">{fieldLabels(c.fields).join(', ')}</div>}
                    </div>
                    {conflict && (
                      <StatusBadge tone="warn" icon={<AlertTriangle />}>
                        изменено и там
                      </StatusBadge>
                    )}
                    {onRevert && (
                      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onRevert(c)}>
                        <Undo2 /> <span className="hidden sm:inline">Вернуть</span>
                      </Button>
                    )}
                  </motion.li>
                )
              })}
            </AnimatePresence>
          </ul>
        </div>
      ))}
    </div>
  )
}

function PlanView({ plan }: { plan: ApplyPlan }) {
  const a = plan.affected
  return (
    <div className="space-y-5">
      {plan.errors.length > 0 && (
        <Notice tone="bad" title="Применение невозможно">
          <ul className="list-disc space-y-0.5 pl-4">
            {plan.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl p-3.5 ring-1 ring-border">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Users className="size-3.5" /> Кого затронет
          </div>
          <div className="space-y-1 text-[13px]">
            <div>{a.segments.length ? `Сети: ${a.segments.join(', ')}` : 'Сети не затронуты'}</div>
            <div>{a.devices.length ? `Устройства: ${a.devices.join(', ')}` : 'Отдельные устройства не затронуты'}</div>
            <div className="text-muted-foreground">
              {a.rules > 0 ? `Правил затронуто: ${a.rules}` : 'Правила не меняются'}
              {a.profiles.length > 0 && ` · профили: ${a.profiles.join(', ')}`}
            </div>
          </div>
        </div>
        <div className="rounded-xl p-3.5 ring-1 ring-border">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <RefreshCw className="size-3.5" /> Что перезапустится
          </div>
          {plan.restarts.length ? (
            <ul className="space-y-1 text-[13px]">
              {plan.restarts.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <div className="text-[13px]">Ничего — изменения применяются без перезапуска</div>
          )}
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <div className="space-y-2">
          {plan.warnings.map((w, i) => (
            <Notice key={i} tone={w.level === 'error' ? 'bad' : 'warn'}>
              {w.text}
            </Notice>
          ))}
        </div>
      )}

      {plan.checks.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-[13px] font-medium">Сохранённые проверки маршрутов</div>
            <div className="text-[12px] text-muted-foreground">сейчас → после применения</div>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            {plan.checks.map((c) => (
              <li key={c.checkId} className={cn('grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 bg-card px-3 py-2.5', !c.ok && c.required && 'bg-bad/6', !c.ok && !c.required && 'bg-warn/6')}>
                <span className="row-span-2 mt-0.5">
                  {c.ok ? <CheckCircle2 className="size-4 text-ok" /> : c.required ? <XCircle className="size-4 text-bad" /> : <AlertTriangle className="size-4 text-warn" />}
                </span>
                <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span className="font-medium">{c.name}</span>
                  {c.required && <span className="text-[11px] text-muted-foreground">обязательная</span>}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {c.live === c.draft ? c.live : (
                    <>
                      {c.live} → <span className={cn(c.ok ? 'text-foreground' : c.required ? 'text-bad' : 'text-warn')}>{c.draft}</span>
                    </>
                  )}
                  {c.message && <span> · {c.message}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Watches stashed drafts: a failed or restored apply gives the draft back. */
function useStashSettler() {
  const { data: tasks } = useTasks()
  useEffect(() => {
    if (!tasks) return
    for (const id of draftStore.stashedTaskIds()) {
      const t = tasks.find((x) => x.id === id)
      if (!t) continue
      if (t.state === 'done') draftStore.settle(id, false)
      else if (t.state === 'restored' || t.state === 'error' || t.state === 'cancelled' || t.state === 'intervention') {
        if (draftStore.settle(id, true))
          toast.warning('Изменения вернулись в черновик', {
            description: `${t.summary ?? t.error ?? 'Применение не завершилось'}. Ничего не потеряно — их можно исправить и применить снова.`,
          })
      }
    }
  }, [tasks])
}

const TRIAL_SECONDS = [
  { value: '60', label: '1 мин' },
  { value: '120', label: '2 мин' },
  { value: '300', label: '5 мин' },
]

export function ApplyFlow() {
  useStashSettler()
  const route = useRoute()
  const open = route.query.get('review') === '1'
  const { changes, outdated, base, server, dirty } = useDraft()
  const { data: caps } = useCaps()
  const [stage, setStage] = useState<Stage>({ k: 'review' })
  const [plan, setPlan] = useState<ApplyPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  // Which action is in flight: the spinner belongs on the button that was pressed.
  const [busy, setBusy] = useState<'full' | 'trial' | 'rebase' | null>(null)
  const [trialSec, setTrialSec] = useState('120')
  const runningTask = useTask(stage.k === 'running' ? stage.taskId : null)

  // Reset when (re)opened
  useEffect(() => {
    if (open) {
      setStage({ k: 'review' })
      setPlan(null)
    }
  }, [open])

  const close = () => closeQuery('review')

  const buildPlan = async () => {
    const d = draftStore.get()
    if (!d) return
    setStage({ k: 'plan' })
    setPlan(null)
    setPlanError(null)
    try {
      setPlan(await api.previewApply(d.working, d.base.revision))
    } catch (e) {
      setPlanError((e as Error).message)
    }
  }

  const doApply = async (mode: 'full' | 'trial') => {
    const d = draftStore.get()
    if (!d || !plan) return
    setBusy(mode)
    try {
      const res = await api.apply(
        d.working,
        d.base.revision,
        mode === 'trial' && plan.trial.suggestedScope ? { mode: 'trial', deviceId: plan.trial.suggestedScope.deviceId, seconds: Number(trialSec) } : { mode: 'full' },
      )
      if (!res.ok) {
        setStage({ k: 'conflict', info: res.conflict })
      } else {
        draftStore.stash(res.task.id)
        void refetch('tasks')
        setStage({ k: 'running', taskId: res.task.id, trial: mode === 'trial' })
      }
    } catch (e) {
      toast.error('Не удалось начать применение', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const doRebase = async () => {
    setBusy('rebase')
    try {
      const theirs = await api.getConfig()
      const from = draftStore.get()?.base.revision ?? 0
      const res = draftStore.rebaseOnto(theirs)
      void refetch('config')
      if (res) setStage({ k: 'rebased', res, from, to: theirs.revision })
    } finally {
      setBusy(null)
    }
  }

  // Nothing to review (e.g. user reverted everything) → close.
  useEffect(() => {
    if (open && !dirty && (stage.k === 'review' || stage.k === 'plan')) close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dirty, stage.k])

  /* ─── content per stage ─── */

  let title: React.ReactNode = 'Проверка изменений'
  let description: React.ReactNode = null
  let body: React.ReactNode = null
  let footer: React.ReactNode = null
  let dismissible = true

  if (stage.k === 'review') {
    description = base && `Черновик от r${base.revision}. Пока вы не примените его, роутер работает как прежде.`
    body = (
      <div className="space-y-4">
        {outdated && (
          <Notice
            tone="warn"
            title={`На роутере уже r${server?.revision}`}
            action={
              <Button size="sm" variant="outline" onClick={doRebase} disabled={!!busy}>
                {busy === 'rebase' ? <Loader2 className="animate-spin" /> : <GitMerge />} Перенести на r{server?.revision}
              </Button>
            }
          >
            Пока вы редактировали, конфигурацию изменили в другом месте. Перенесите черновик на новую ревизию — ваши изменения сохранятся, совпадения будут показаны.
          </Notice>
        )}
        <ChangeList changes={changes} onRevert={(c) => draftStore.revertEntity(c.collection, c.id)} />
      </div>
    )
    footer = (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted-foreground">{count(changes.length, ['изменение', 'изменения', 'изменений'])}</span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={close}>
            Продолжить правку
          </Button>
          <Button onClick={buildPlan} disabled={outdated}>
            Далее: план применения
          </Button>
        </div>
      </div>
    )
  }

  if (stage.k === 'plan') {
    title = 'План применения'
    description = 'Проверено на роутере для этого черновика. Сейчас ничего не меняется.'
    const trialAv = plan?.trial
    body = planError ? (
      <Notice tone="bad" title="Не удалось построить план" action={<Button size="sm" variant="outline" onClick={buildPlan}>Повторить</Button>}>
        {planError}
      </Notice>
    ) : !plan ? (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Роутер проверяет черновик и прогоняет сохранённые проверки…
        </div>
        <SkeletonBlock rows={3} />
      </div>
    ) : (
      <div className="space-y-5">
        <PlanView plan={plan} />
        <div className="rounded-xl p-3.5 ring-1 ring-border">
          <div className="mb-1 flex items-center gap-2 text-[13px] font-medium">
            <FlaskConical className="size-4" /> Пробное применение
          </div>
          {trialAv?.available && trialAv.suggestedScope ? (
            <div className="space-y-2.5 text-[13px] text-muted-foreground">
              <p>
                Только для «{trialAv.suggestedScope.label}». Если не подтвердить — роутер сам вернёт r{plan.baseRevision}, даже если эта вкладка закроется.
              </p>
              <div className="flex items-center gap-2">
                <span>Время на проверку</span>
                <Segmented size="sm" value={trialSec} onChange={setTrialSec} options={TRIAL_SECONDS} />
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{trialAv?.reason ?? 'Недоступно'}</p>
          )}
        </div>
      </div>
    )
    const blocked = !!plan && plan.errors.length > 0
    footer = (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={() => setStage({ k: 'review' })}>
          <ArrowLeft /> К изменениям
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row">
          {plan?.trial.available && (
            <WriteButton variant="outline" disabled={!!busy || blocked} onClick={() => doApply('trial')} reason={blocked ? 'Исправьте ошибки плана' : undefined}>
              {busy === 'trial' ? <Loader2 className="animate-spin" /> : <FlaskConical />} Опробовать {duration(Number(trialSec))}
            </WriteButton>
          )}
          <WriteButton disabled={!plan || !!busy || blocked} onClick={() => doApply('full')} reason={blocked ? 'Исправьте ошибки плана' : undefined}>
            {busy === 'full' ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Применить
          </WriteButton>
        </div>
      </div>
    )
  }

  if (stage.k === 'conflict') {
    const c = stage.info
    title = 'Конфигурация уже изменилась'
    description = `Пока вы готовили черновик, ${c.by} сохранил r${c.serverRevision}.`
    const mine = new Set(changes.map((x) => `${x.collection}/${x.id}`))
    body = (
      <div className="space-y-4">
        <Notice tone="warn" title="Ваш черновик не применён и не потерян">
          Применение без учёта чужих изменений перезаписало бы их. Перенесите черновик на r{c.serverRevision}: ваши правки встанут поверх, а совпадающие объекты будут отмечены.
        </Notice>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">
            Изменено в r{c.serverRevision} · <TimeAgo at={c.at} />
          </div>
          <ChangeList changes={c.theirChanges} conflictKeys={new Set(c.theirChanges.map((x) => `${x.collection}/${x.id}`).filter((k) => mine.has(k)))} />
        </div>
      </div>
    )
    footer = (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Позже
        </Button>
        <Button onClick={doRebase} disabled={!!busy}>
          {busy === 'rebase' ? <Loader2 className="animate-spin" /> : <GitMerge />} Перенести на r{c.serverRevision}
        </Button>
      </div>
    )
  }

  if (stage.k === 'rebased') {
    const { res, to } = stage
    title = `Черновик перенесён на r${to}`
    description = 'Ваши изменения теперь поверх актуальной конфигурации.'
    const ck = new Set(res.conflicts.map((x) => `${x.collection}/${x.id}`))
    body = (
      <div className="space-y-4">
        {res.conflicts.length ? (
          <Notice tone="warn" title={`${count(res.conflicts.length, ['объект изменён', 'объекта изменены', 'объектов изменены'])} с обеих сторон`}>
            Для них оставлена ваша версия. Проверьте, что чужие правки не нужны — или верните объект к версии r{to}.
          </Notice>
        ) : (
          <Notice tone="ok" title="Пересечений нет">
            Чужие и ваши изменения касаются разных объектов.
          </Notice>
        )}
        <ChangeList changes={changes} onRevert={(c) => draftStore.revertEntity(c.collection, c.id)} conflictKeys={ck} />
      </div>
    )
    footer = (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Продолжить правку
        </Button>
        <Button onClick={buildPlan} disabled={!dirty}>
          Построить план заново
        </Button>
      </div>
    )
  }

  if (stage.k === 'running') {
    const t: Task | undefined = runningTask
    const finished = t && !['pending', 'running'].includes(t.state)
    const awaitingConfirm = stage.trial && t?.state === 'running' && t.steps[6]?.state === 'running'
    dismissible = true
    title = stage.trial ? 'Пробное применение' : 'Применение'
    description = t ? (
      <span className="inline-flex items-center gap-2">
        {t.title} <TaskStateBadge state={t.state} />
      </span>
    ) : null
    body = t ? (
      <div className="space-y-4">
        <TaskSteps steps={t.steps} />
        {awaitingConfirm && <TrialConfirmInline taskId={t.id} />}
        {finished && (
          <Notice tone={t.state === 'done' ? 'ok' : t.state === 'restored' ? 'warn' : 'bad'} icon={t.state === 'restored' ? <RotateCcw /> : undefined} title={t.summary ?? t.error}>
            {t.state === 'done'
              ? 'Изменения действуют. Проверка маршрута и журнал уже показывают новую ревизию.'
              : 'Роутер работает на прежней конфигурации. Ваши изменения возвращены в черновик.'}
          </Notice>
        )}
        {!finished && !awaitingConfirm && <p className="text-[12.5px] text-muted-foreground">Окно можно закрыть — задача продолжится, её ход виден в центре задач.</p>}
      </div>
    ) : (
      <SkeletonBlock rows={3} />
    )
    footer = (
      <div className="flex justify-end">
        <Button variant={finished ? 'default' : 'outline'} onClick={close}>
          {finished ? 'Готово' : 'Свернуть'}
        </Button>
      </div>
    )
  }

  void caps
  return (
    <Modal open={open} onClose={close} title={title} description={description} footer={footer} size="lg" dismissible={dismissible}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={stage.k} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ type: 'spring', bounce: 0, duration: 0.3 }}>
          {body}
        </motion.div>
      </AnimatePresence>
    </Modal>
  )
}

export function TrialConfirmInline({ taskId }: { taskId: string }) {
  const { data: rt } = useRuntimeTrial()
  const left = useCountdown(rt?.expiresAt)
  const [busy, setBusy] = useState<'ok' | 'back' | null>(null)
  if (!rt) return null
  return (
    <div className="space-y-3 rounded-xl bg-draft/8 p-4 ring-1 ring-draft/25">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13.5px] font-medium">Проверьте «{rt.scope}» и подтвердите</div>
        <div className="tabular text-[22px] font-semibold text-draft">{fmtClock(left)}</div>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-draft/15">
        <motion.div className="h-full bg-draft" initial={false} animate={{ width: `${(left / rt.totalSec) * 100}%` }} transition={{ duration: 0.25, ease: 'linear' }} />
      </div>
      <div className="flex flex-wrap gap-2">
        <WriteButton
          disabled={!!busy}
          onClick={async () => {
            setBusy('ok')
            try {
              await api.confirmTrial(taskId)
            } catch (e) {
              toast.error((e as Error).message)
            } finally {
              setBusy(null)
            }
          }}
        >
          {busy === 'ok' ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Всё работает — оставить
        </WriteButton>
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={async () => {
            setBusy('back')
            await api.rollbackTrial(taskId)
            setBusy(null)
          }}
        >
          <RotateCcw /> Вернуть прежнюю
        </Button>
      </div>
    </div>
  )
}

export function fmtClock(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

function useRuntimeTrial() {
  const r = useRuntime()
  return { data: r.data?.trial ?? null }
}
