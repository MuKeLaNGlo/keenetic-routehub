import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, History, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Revision } from '@/api/contract'
import { api } from '@/api'
import { useRevisions, useRuntime, useTask } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { closeQuery, setQuery, useRoute } from '@/state/router'
import { EmptyState, Gate, Notice, Section } from '@/components/rh/layout'
import { StatusBadge, toneBg } from '@/components/rh/status'
import { Mono, TimeAgo, WriteButton } from '@/components/rh/controls'
import { TaskCard } from '@/components/rh/task'
import { DetailSheet } from '@/components/rh/sheet'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { count, dateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { REVISION_RESULT } from './meta'

export function Revisions({ compact = false }: { compact?: boolean }) {
  const revisions = useRevisions()
  const runtime = useRuntime()
  const route = useRoute()
  const { server, changes } = useDraft()
  const [target, setTarget] = useState<number | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskVisible, setTaskVisible] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const launchingRef = useRef(false)
  const rollbackTask = useTask(compact ? taskId : null)
  const revisionParam = compact ? route.query.get('rev') : null
  const selected = revisions.data?.find((r) => String(r.revision) === revisionParam)

  useEffect(() => {
    if (!compact) return
    setTarget(null)
    setError(null)
  }, [compact, revisionParam])

  const open = (rev: number) => {
    setError(null)
    setTarget(rev)
  }

  const run = async () => {
    if (target == null || launchingRef.current) return
    const initialHash = window.location.hash
    launchingRef.current = true
    setLaunching(true)
    try {
      const t = await api.rollbackTo(target)
      setTaskId(t.id)
      setTaskVisible(true)
      setTarget(null)
      if (compact && initialHash === window.location.hash) closeQuery('rev')
      toast('Возврат запущен', { description: `Новая ревизия получит содержимое r${target}` })
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error('Возврат не выполнен', { description: msg })
    } finally {
      launchingRef.current = false
      setLaunching(false)
    }
  }

  if (compact) {
    const loaded = runtime.error ? undefined : runtime.data?.loadedRevision
    const saved = server?.revision
    const differs = loaded !== undefined && saved !== undefined && loaded !== saved
    const confirming = selected?.revision === target
    const taskBusy = !!taskId && (!rollbackTask || rollbackTask.state === 'pending' || rollbackTask.state === 'running')

    return (
      <div className="space-y-3.5">
        <dl className="flex flex-wrap gap-px overflow-hidden rounded-xl border border-border bg-border">
          <div className="min-w-[115px] flex-1 bg-card px-3.5 py-2.5">
            <dt className="text-[12px] text-muted-foreground">Действует</dt>
            <dd className="mt-0.5 text-sm font-medium">{loaded === undefined ? 'Нет данных' : <Mono className="text-sm">r{loaded}</Mono>}</dd>
          </div>
          {(differs || loaded === undefined) && (
            <div className="min-w-[115px] flex-1 bg-card px-3.5 py-2.5">
              <dt className="text-[12px] text-muted-foreground">Сохранена</dt>
              <dd className="mt-0.5 text-sm font-medium">{saved === undefined ? 'Нет данных' : <Mono className="text-sm">r{saved}</Mono>}</dd>
            </div>
          )}
        </dl>
        {differs && <Notice tone="warn" title="Действующая и сохранённая ревизии различаются">Сохранена r{saved}, действует r{loaded}.</Notice>}
        {runtime.error && (
          <Notice
            tone="warn"
            title="Действующую ревизию не удалось получить"
            action={<Button variant="outline" size="sm" onClick={() => void runtime.refetch()}>Обновить</Button>}
          >
            {runtime.error}
          </Notice>
        )}

        <AnimatePresence>
          {taskId && taskVisible && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }}>
              <TaskPanel taskId={taskId} onHide={() => setTaskVisible(false)} compact />
            </motion.div>
          )}
        </AnimatePresence>

        <Gate res={revisions}>
          {(list) => list.length === 0 ? <EmptyState icon={<History />} title="Ревизий ещё нет" /> : (
            <ol aria-label="История ревизий" className="divide-y overflow-hidden rounded-xl border border-border bg-card">
              {list.map((r) => (
                <li key={r.revision}>
                  <button
                    type="button"
                    onClick={() => setQuery({ rev: String(r.revision) })}
                    className="grid min-h-[58px] w-full grid-cols-[minmax(0,1fr)_14px] items-center gap-2 px-3.5 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                      <div className="min-w-0 flex-1 basis-50">
                        <div className="flex flex-wrap items-center gap-2">
                          <Mono className="text-[13px] font-semibold">r{r.revision}</Mono>
                          {loaded === r.revision && <span className="text-[11.5px] font-medium text-ok">Действует</span>}
                          {saved === r.revision && differs && <span className="text-[11.5px] font-medium text-muted-foreground">Сохранена</span>}
                        </div>
                        <div className="mt-0.5 text-[12.5px] leading-snug [overflow-wrap:anywhere]">{r.summary}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                        <StatusBadge tone={REVISION_RESULT[r.result].tone}>{REVISION_RESULT[r.result].label}</StatusBadge>
                        <TimeAgo at={r.at} />
                      </div>
                    </div>
                    <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Gate>

        <DetailSheet
          open={!!selected || (revisionParam !== null && revisions.data !== undefined)}
          onClose={() => {
            if (!launching) closeQuery('rev')
          }}
          title={selected ? `Ревизия r${selected.revision}` : 'Ревизия не найдена'}
          footer={selected && selected.revision !== saved && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {confirming ? (
                <>
                  <WriteButton disabled={launching || taskBusy} onClick={() => void run()}>Создать ревизию из r{selected.revision}</WriteButton>
                  <Button autoFocus variant="outline" disabled={launching} onClick={() => setTarget(null)}>Отмена</Button>
                </>
              ) : (
                <WriteButton
                  variant="outline"
                  disabled={taskBusy}
                  reason={taskBusy ? 'Дождитесь окончания возврата' : undefined}
                  onClick={() => open(selected.revision)}
                >
                  <RotateCcw aria-hidden="true" /> Вернуться к ревизии
                </WriteButton>
              )}
            </div>
          )}
        >
          {selected && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <StatusBadge tone={REVISION_RESULT[selected.result].tone} icon={REVISION_RESULT[selected.result].icon}>{REVISION_RESULT[selected.result].label}</StatusBadge>
                {selected.revision === loaded && <StatusBadge tone="ok">Действует</StatusBadge>}
              </div>
              <p className="text-sm font-medium [overflow-wrap:anywhere]">{selected.summary}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
                <span>{selected.by}</span>
                <span>{dateTime(selected.at)}</span>
                <span>{count(selected.changes, ['изменение', 'изменения', 'изменений'])}</span>
              </div>
              {REVISION_RESULT[selected.result].consequence && <p className="text-[12.5px] text-muted-foreground">{REVISION_RESULT[selected.result].consequence}</p>}
              {confirming && (
                <Notice tone="warn" title={`Восстановить содержимое r${selected.revision}?`}>
                  <p>Роутер сразу создаст и применит новую ревизию. Текущая конфигурация останется в истории. При недоступной или повреждённой копии роутер отклонит операцию.</p>
                  {changes.length > 0 && <p className="mt-1">Черновик сохранится отдельно и будет основан на предыдущей ревизии.</p>}
                </Notice>
              )}
              {confirming && error && <Notice tone="bad" title="Возврат не выполнен">{error}</Notice>}
            </div>
          )}
        </DetailSheet>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 rounded-xl bg-card p-3.5 ring-1 ring-border sm:grid-cols-2">
        <div className="space-y-0.5">
          <div className="text-[12px] text-muted-foreground">Сохранено на роутере</div>
          <Mono className="text-[15px] font-medium">{server ? `r${server.revision}` : '—'}</Mono>
        </div>
        <div className="space-y-0.5">
          <div className="text-[12px] text-muted-foreground">Загружено демоном</div>
          <Mono className="text-[15px] font-medium">{runtime.data ? `r${runtime.data.loadedRevision}` : '—'}</Mono>
        </div>
      </div>

      {runtime.data && server && runtime.data.loadedRevision !== server.revision && (
        <Notice tone="warn" title="Демон работает не с последней сохранённой ревизией">
          На роутере сохранена r{server.revision}, сейчас действует r{runtime.data.loadedRevision}.
        </Notice>
      )}

      <Section
        title="История ревизий"
        description="Каждая сохранённая ревизия хранится вместе с копией конфигурации. Возврат к прежней — это новая ревизия с тем же содержимым, а не переписывание истории."
      >
        <Gate res={revisions}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={<History />} title="Ревизий ещё нет">
                Первая ревизия появится после первого применения конфигурации.
              </EmptyState>
            ) : (
              <ol className="ml-1 border-l border-border pl-4">
                {list.map((r) => (
                  <RevisionRow
                    key={r.revision}
                    r={r}
                    current={server?.revision === r.revision}
                    loaded={runtime.data?.loadedRevision === r.revision}
                    onRollback={() => open(r.revision)}
                  />
                ))}
              </ol>
            )
          }
        </Gate>
      </Section>

      <AnimatePresence>
        {taskId && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }}>
            <TaskPanel taskId={taskId} onHide={() => setTaskId(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      <AlertDialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Вернуться к содержимому r{target}?</AlertDialogTitle>
            <AlertDialogDescription>
              Будет создана новая ревизия с номером больше текущего и содержимым r{target}. Текущая r{server?.revision ?? '—'} останется в истории — к ней можно вернуться так же.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-[12.5px] leading-relaxed text-muted-foreground">
            <p>Профили, правила и сегменты сразу вернутся к настройкам из r{target}.</p>
            <p>Если копия r{target} повреждена или не хранится, сервер откажется: конфигурация и трафик не изменятся.</p>
            {error && <p className="text-bad">Возврат не выполнен: {error}. Действующей остаётся r{server?.revision ?? '—'}.</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Оставить как есть</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run()}>Создать ревизию из r{target}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RevisionRow({ r, current, loaded, onRollback }: { r: Revision; current: boolean; loaded: boolean; onRollback: () => void }) {
  const m = REVISION_RESULT[r.result]
  return (
    <li className="relative pb-5 last:pb-0">
      <span className={cn('absolute top-1.5 -left-[21.5px] size-2.5 rounded-full ring-4 ring-background', toneBg[m.tone])} aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Mono className="text-[13.5px] font-medium">r{r.revision}</Mono>
            <StatusBadge tone={m.tone} icon={m.icon}>
              {m.label}
            </StatusBadge>
            {current && <StatusBadge tone="ok">действует</StatusBadge>}
            {loaded && !current && <StatusBadge tone="muted">загружена демоном</StatusBadge>}
            {r.changes > 0 && <span className="text-[12px] text-muted-foreground">{count(r.changes, ['изменение', 'изменения', 'изменений'])}</span>}
          </div>
          <div className="text-[13.5px] leading-snug">{r.summary}</div>
          <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span>{r.by}</span>
            <span aria-hidden>·</span>
            <TimeAgo at={r.at} />
            <span aria-hidden>·</span>
            <span className="tabular">{dateTime(r.at)}</span>
          </div>
          {m.consequence && <p className="text-[12px] leading-relaxed text-muted-foreground">{m.consequence}</p>}
        </div>
        {!current && (
          <WriteButton variant="outline" size="sm" className="shrink-0" onClick={onRollback}>
            <RotateCcw /> Вернуться к этой
          </WriteButton>
        )}
      </div>
    </li>
  )
}

function TaskPanel({ taskId, onHide, compact = false }: { taskId: string; onHide: () => void; compact?: boolean }) {
  const task = useTask(taskId)
  return (
    <Section
      className={compact ? 'mb-0 md:mb-0' : undefined}
      title="Возврат к прежней ревизии"
      description={compact ? undefined : 'Операция на роутере. Результат и восстановление видны по шагам.'}
      actions={
        <Button variant="ghost" size="sm" onClick={onHide}>
          <X /> Скрыть
        </Button>
      }
    >
      {task ? <TaskCard task={task} /> : <div className="h-24 animate-pulse rounded-xl bg-card ring-1 ring-border" />}
    </Section>
  )
}
