import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleDashed,
  CornerDownRight,
  Eye,
  Loader2,
  Minus,
  Pencil,
  Play,
  Plus,
  ShieldAlert,
  SkipForward,
  Trash2,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/api'
import type { ConnectionObservation, RealTestResult, SavedCheck, TraceLayerId, TraceQuery, TraceResult, TraceStep } from '@/api/contract'
import { useCanWrite, useCaps, useServerConfig, useTask, useTopology } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { href, useRoute } from '@/state/router'
import { Notice, Section, Panel } from '@/components/rh/layout'
import { Mono, TimeAgo, WriteButton } from '@/components/rh/controls'
import { ActionChip } from '@/components/rh/action'
import { StatusBadge, TaskStateBadge } from '@/components/rh/status'
import { TaskSteps } from '@/components/rh/task'
import { Button } from '@/components/ui/button'
import { deviceName, newId } from '@/lib/entities'
import { cn } from '@/lib/utils'
import { bytes } from '@/lib/format'
import { savedCheckActions, SavedCheckEditor } from './saved-check-editor'

const LAYER_NO: Record<TraceLayerId, string> = { system: '0', device: '1', zapret: '2', game: '3', policy: '4', global: '5', default: '6' }

export const EXAMPLES = ['youtube.com', 'www.gosuslugi.ru', 'chatgpt.com', 'media-site.example', '151.101.1.10', 'googlevideo.com', 'netflix.com', '192.168.1.1']

/* ───────────── query from URL ───────────── */

export function parseSource(s: string | null): TraceQuery['source'] | null {
  if (!s) return null
  const separator = s.indexOf(':')
  if (separator < 0) return null
  const type = s.slice(0, separator)
  const id = s.slice(separator + 1)
  if (type === 'device' && id) return { type: 'device', deviceId: id }
  if (type === 'segment' && id) return { type: 'segment', segmentId: id }
  return null
}
export const srcKey = (s: TraceQuery['source']) => (s.type === 'device' ? `device:${s.deviceId}` : `segment:${s.segmentId}`)

export function useQueryFromUrl(): TraceQuery {
  const { query } = useRoute()
  const { data: topology } = useTopology()
  const defaultSegment = topology?.segments.find(({ state, routable }) => state === 'up' && routable.available)?.id
  return useMemo(() => {
    const shortParam = query.get('p')
    const shortProto = shortParam === 'tcp' || shortParam === 'udp' ? shortParam : null
    const proto = query.get('proto') ?? shortProto
    const port = Number(query.get('port') ?? (shortProto ? null : shortParam) ?? 443) || 443
    return {
      source: parseSource(query.get('src')) ?? { type: 'segment', segmentId: defaultSegment ?? '' },
      target: query.get('t') ?? '',
      proto: proto === 'udp' ? 'udp' : 'tcp',
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 443,
      resolvedIp: query.get('ip') || undefined,
      flowId: query.get('flow') || undefined,
    }
  }, [query, defaultSegment])
}

export function traceHref(path: string, q: TraceQuery) {
  return href(path, {
    src: srcKey(q.source),
    t: q.target,
    proto: q.proto === 'tcp' ? null : q.proto,
    port: q.port === 443 ? null : String(q.port),
    ip: q.resolvedIp ?? null,
    flow: q.flowId ?? null,
  })
}

export function useTraceEvaluation(q: TraceQuery) {
  const { data: config } = useServerConfig()
  const [live, setLive] = useState<TraceResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settledKey, setSettledKey] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify(q)

  useEffect(() => {
    if (!q.target.trim() || !config || !parseSource(srcKey(q.source))) return
    let alive = true
    setBusy(true)
    setError(null)
    api.evaluate(q)
      .then((result) => { if (alive) setLive(result) })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => {
        if (!alive) return
        setSettledKey(key)
        setBusy(false)
      })
    return () => {
      alive = false
    }
    // Re-evaluate when the query or the applied config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, config, attempt])

  return {
    live, busy, error, key,
    current: settledKey === key,
    refresh: () => setAttempt((value) => value + 1),
  }
}

export function PathCard({ r }: { r: TraceResult }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
      <div className="rounded-xl bg-card p-3.5 ring-1 ring-border">
        <div className="mb-1.5 text-[12px] text-muted-foreground">Физическая сеть</div>
        <div className="text-[14px] font-semibold">{r.physical.segmentName}</div>
        {r.physical.ssid && <div className="text-[12px] text-muted-foreground">{r.physical.ssid}</div>}
      </div>
      <div className="rounded-xl bg-card p-3.5 ring-1 ring-border">
        <div className="mb-1.5 text-[12px] text-muted-foreground">Цепочка политик</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {r.policyChain.length === 0 && <span className="text-[13px] text-muted-foreground">—</span>}
          {r.policyChain.map((p, i) => (
            <span key={p.id} className="inline-flex items-center gap-1.5">
              {i > 0 && <ArrowRight className="size-3 text-muted-foreground/60" />}
              <a href={href('/rules', { policy: p.id })} className="pressable inline-flex h-6 items-center rounded-md bg-muted px-2 text-[12.5px] hover:bg-accent">
                {p.name}
              </a>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ───────────── evaluation steps ───────────── */

const OUTCOME: Record<TraceStep['outcome'], { icon: ReactNode; cls: string; label: string }> = {
  matched: { icon: <Check strokeWidth={3} />, cls: 'bg-foreground text-background', label: 'сработало' },
  'no-match': { icon: <Minus />, cls: 'bg-muted text-muted-foreground', label: 'нет совпадений' },
  skipped: { icon: <SkipForward />, cls: 'bg-muted text-muted-foreground', label: 'пропущено' },
  'not-applicable': { icon: <CircleDashed />, cls: 'bg-transparent text-muted-foreground ring-1 ring-dashed ring-border', label: 'не применяется' },
  yielded: { icon: <Undo2 />, cls: 'bg-warn/15 text-warn', label: 'уступил' },
}

export function Steps({ r }: { r: TraceResult }) {
  const matchedIdx = r.steps.findIndex((s) => s.outcome === 'matched')
  return (
    <Section
      className="mb-0 md:mb-0"
      title="Порядок проверки"
    >
      <ol className="relative">
        {r.steps.map((s, i) => (
          <StepRow key={i} s={s} last={i === r.steps.length - 1} after={matchedIdx >= 0 && i > matchedIdx} />
        ))}
      </ol>
    </Section>
  )
}

function StepRow({ s, last, after }: { s: TraceStep; last: boolean; after: boolean }) {
  const [open, setOpen] = useState(false)
  const m = OUTCOME[s.outcome]
  const matched = s.outcome === 'matched'
  return (
    <li className={cn('relative flex gap-3 pb-4', after && 'opacity-45')}>
      {!last && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />}
      <span className={cn('relative z-10 flex size-[27px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold [&>svg]:size-3.5', m.cls)}>{matched || s.outcome === 'yielded' ? m.icon : LAYER_NO[s.layer]}</span>
      <div className={cn('min-w-0 flex-1 pt-0.5', matched && 'rounded-xl bg-card p-3 ring-1 ring-foreground/15 -mt-1.5')}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('text-[13.5px]', matched ? 'font-semibold' : 'font-medium')}>{s.scopeLabel}</span>
          <span className={cn('text-[12px]', s.outcome === 'yielded' ? 'text-warn' : 'text-muted-foreground')}>{m.label}</span>
        </div>
        {s.rule && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a href={href('/rules', { policy: s.policyId ?? null, rule: s.rule.id })} className="text-[13px] font-medium underline-offset-2 hover:underline">
              «{s.rule.name}»
            </a>
            <Mono className="text-[12px] text-muted-foreground">{s.rule.match}</Mono>
            <ActionChip action={s.rule.action} />
            <span className="text-[11.5px] text-muted-foreground">{s.rule.source}</span>
          </div>
        )}
        <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.note}</div>
        {s.considered && s.considered.length > 0 && (
          <div className="mt-1.5">
            <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
              Рассмотрено, но не сработало: {s.considered.length}
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.3 }} className="overflow-hidden">
                  {s.considered.map((c) => (
                    <li key={c.ruleId} className="flex gap-2 pt-1.5 text-[12px]">
                      <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
                      <span>{c.name}</span>
                      <span className="text-muted-foreground">— {c.why}</span>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </li>
  )
}

/* ───────────── real test ───────────── */

export function RealTest({ q, r }: { q: TraceQuery; r: TraceResult }) {
  const [taskId, setTaskId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const task = useTask(taskId)
  useEffect(() => setTaskId(null), [q.target, q.proto, q.port, q.source])
  const res = task?.result as RealTestResult | undefined
  const inProgress = starting || task?.state === 'running' || task?.state === 'pending'
  return (
    <Section
      className="mb-0 md:mb-0"
      title="Запрос с роутера"
      description="Проверяет выход со стороны роутера."
      actions={
        <Button
          variant="outline"
          disabled={inProgress}
          onClick={async () => {
            setStarting(true)
            try {
              setTaskId((await api.realTest(q)).id)
            } catch (e) {
              toast.error((e as Error).message)
            } finally {
              setStarting(false)
            }
          }}
        >
          {inProgress ? <Loader2 className="animate-spin" /> : <Play />} Отправить запрос
        </Button>
      }
    >
      {!task ? (
        <div className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
          <CircleDashed className="size-4" /> Не проверялось трафиком. Выход: {r.effective.label}.
        </div>
      ) : (
        <Panel className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13.5px] font-medium">
              {q.target} → {r.effective.label}
            </div>
            <TaskStateBadge state={task.state} />
          </div>
          <TaskSteps steps={task.steps} />
          {res && <p className="text-[12px] leading-relaxed text-muted-foreground">{res.note}</p>}
        </Panel>
      )}
    </Section>
  )
}

/* ───────────── saved checks ───────────── */

export function SavedChecks({ current, onSelect }: {
  current: TraceQuery
  onSelect: (q: TraceQuery) => void
}) {
  const { config, edit } = useDraft()
  const { data: topo } = useTopology()
  const canWrite = useCanWrite()
  const [results, setResults] = useState<Record<string, { label: string; passed: boolean }>>({})
  const [loadingResults, setLoadingResults] = useState(false)
  const [editor, setEditor] = useState<SavedCheck | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const checks = config?.checks ?? []

  useEffect(() => {
    setResults({})
    const checks = config?.checks ?? []
    if (!checks.length) {
      setLoadingResults(false)
      return
    }
    let alive = true
    setLoadingResults(true)
    const getResults = async () => {
      if (api.getSavedCheckResults) {
        const rows = await api.getSavedCheckResults()
        return Object.fromEntries(rows.map((row) => [row.checkId, { label: row.live, passed: row.ok }]))
      }
      const rows = await Promise.allSettled(checks.map(async (c) => {
        const q: TraceQuery = { source: c.source, target: c.target, proto: c.proto, port: c.port }
        const result = await api.evaluate(q)
        return [c.id, { label: result.configuredLabel, passed: result.configured.kind === c.expect }] as const
      }))
      return Object.fromEntries(rows.flatMap((row) => row.status === 'fulfilled' ? [row.value] : []))
    }
    getResults()
      .then((value) => alive && setResults(value))
      .catch(() => {})
      .finally(() => alive && setLoadingResults(false))
    return () => {
      alive = false
    }
  }, [config])

  function sourceLabel(source: TraceQuery['source']) {
    if (source.type === 'device') {
      const device = topo?.devices.find((entry) => entry.id === source.deviceId)
      return device ? deviceName(device, config) : source.deviceId
    }
    const network = topo?.segments.find((entry) => entry.id === source.segmentId)
    return `Сеть «${network?.name ?? source.segmentId}»`
  }

  const sourceCanCheck = current.source.type === 'device'
    ? topo?.devices.some((entry) => srcKey(current.source) === `device:${entry.id}`)
    : topo?.segments.some((entry) => srcKey(current.source) === `segment:${entry.id}`)

  async function saveCheck(check: SavedCheck) {
    const saved = await edit(`Проверка маршрута «${check.name}»`, (candidate) => {
      const index = candidate.checks.findIndex(({ id }) => id === check.id)
      if (index === -1) candidate.checks.push(check)
      else candidate.checks[index] = check
    })
    if (saved) toast.success('Проверка сохранена')
    return saved
  }

  async function removeCheck(check: SavedCheck) {
    setRemoving(check.id)
    try {
      if (await edit(`Удаление проверки «${check.name}»`, (candidate) => {
        candidate.checks = candidate.checks.filter(({ id }) => id !== check.id)
      })) toast.success('Проверка удалена')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <Section
      className="mb-0 md:mb-0"
      actions={(
        <WriteButton
          size="sm" variant="outline" disabled={!config || !current.target.trim() || !sourceCanCheck || checks.length >= 64}
          onClick={() => setEditor({ id: newId('check'), name: current.target, source: current.source, target: current.target,
            family: current.target.includes(':') ? 'v6' : 'v4', proto: current.proto, port: current.port, expect: 'direct', required: false })}
        >
          <Plus /> Сохранить запрос
        </WriteButton>
      )}
    >
      {config && checks.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground">Сохранённых проверок нет.</p>
      )}
      <div className={cn('divide-y overflow-hidden rounded-xl ring-1 ring-border', checks.length === 0 && 'hidden')}>
        {checks.map((c) => {
          const r = results[c.id]
          const active = current.target === c.target && srcKey(current.source) === srcKey(c.source)
            && current.proto === c.proto && current.port === c.port
          return (
            <div key={c.id} className={cn('flex min-w-0 items-center bg-card', active && 'bg-surface-2')}>
            <button
              type="button"
              onClick={() => onSelect({ source: c.source, target: c.target, proto: c.proto, port: c.port })}
              className={cn(
                'pressable flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              )}
            >
              <span className="shrink-0">
                {!r ? (
                  loadingResults ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <CircleDashed className="size-4 text-muted-foreground" />
                ) : r.passed ? (
                  <Check className="size-4 text-ok" strokeWidth={3} />
                ) : (
                  <ShieldAlert className={cn('size-4', c.required ? 'text-bad' : 'text-warn')} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span className="sr-only">
                  {!r ? 'Нет результата' : r.passed ? 'Проверка прошла' : 'Расчёт не совпал с ожиданием'}
                </span>
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{c.name}</span>
                  {c.required && <span className="shrink-0 text-[11px] text-muted-foreground">обязательная</span>}
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {sourceLabel(c.source)} → <Mono className="text-[12px]">{c.target}</Mono> · ожидается {savedCheckActions[c.expect]}
                </div>
              </div>
              {r && (
                <span className="hidden shrink-0 text-right text-[12px] sm:block">
                  <span className={cn(r.passed ? 'text-muted-foreground' : 'text-bad')}>{r.label}</span>
                </span>
              )}
            </button>
            {canWrite && (
              <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
                <WriteButton aria-label={`Изменить ${c.name}`} onClick={() => setEditor(c)} size="icon-sm" variant="ghost"><Pencil /></WriteButton>
                <WriteButton aria-label={`Удалить ${c.name}`} disabled={removing !== null} onClick={() => void removeCheck(c)} size="icon-sm" variant="ghost"><Trash2 /></WriteButton>
              </div>
            )}
            </div>
          )
        })}
      </div>
      {editor && <SavedCheckEditor key={editor.id} check={editor} source={sourceLabel(editor.source)} onSave={saveCheck} onClose={() => setEditor(null)} />}
    </Section>
  )
}

/* ───────────── live connections ───────────── */

export function LiveConnections() {
  const { data: caps } = useCaps()
  const { data: topo } = useTopology()
  const { config } = useDraft()
  const [observation, setObservation] = useState<ConnectionObservation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const availability = caps?.liveObservation

  async function observe() {
    setBusy(true)
    setError(null)
    try {
      setObservation(await api.observeConnections(10))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Запрос не завершился.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      className="mb-0 md:mb-0"
      title="Наблюдение"
      description="Netfilter показывает TCP и UDP клиентов в настроенной IPv4-подсети. Короткие соединения могут пройти между замерами."
      actions={
        <WriteButton
          variant="outline"
          disabled={busy || !availability?.available}
          reason={availability?.reason}
          onClick={() => void observe()}
        >
          {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {busy ? 'Наблюдаем…' : 'Наблюдать 10 с'}
        </WriteButton>
      }
    >
      {availability?.available === false && <Notice tone="info" title="Наблюдение недоступно">{availability.reason}</Notice>}
      {error && <div role="alert"><Notice tone="warn" title="Наблюдение не завершилось">{error}</Notice></div>}
      {busy && <p role="status" className="mb-2 text-[12px] text-muted-foreground">Собираем данные за 10 секунд.</p>}
      {observation && (
        <div className="space-y-2">
          <p className="text-[12px] text-muted-foreground">
            Соединений: {observation.rows.length} · {observation.seconds} с · <TimeAgo at={observation.finishedAt} prefix="завершено " />
          </p>
          {observation.limited && <p className="text-[12px] text-warn">Показана часть соединений. Достигнут лимит наблюдения.</p>}
          {!observation.rows.length ? (
            <p className="text-[13px] text-muted-foreground">За это время соединений в таблице не найдено.</p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
              {observation.rows.map((connection) => {
                const device = topo?.devices.find(({ id }) => id === connection.deviceId)
                const source = device ? deviceName(device, config) : connection.sourceAddress ?? connection.deviceId
                return (
                  <li key={connection.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-card px-3 py-2.5">
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <div className="flex flex-wrap items-center gap-2">
                        <Mono>{connection.dst}</Mono>
                        <span className="text-[11px] text-muted-foreground">{connection.proto.toUpperCase()}</span>
                        {connection.new && <StatusBadge tone="info">Новое</StatusBadge>}
                        {connection.redirected && <StatusBadge tone="muted">На входе RouteHub</StatusBadge>}
                        {connection.stalePolicy && <StatusBadge tone="warn" dashed>По прежней политике</StatusBadge>}
                      </div>
                      <p className="text-[12px] text-muted-foreground">
                        {source}{connection.rule && <> · {connection.rule}</>}
                        {connection.bytes == null ? ' · объём неизвестен' : <> · {bytes(connection.bytes)} за замер</>}
                      </p>
                    </div>
                    <span className="text-[12px] text-muted-foreground">{connection.exit ?? 'Выход не проверен'}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Section>
  )
}
