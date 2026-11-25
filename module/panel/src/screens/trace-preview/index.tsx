import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, Loader2, Search } from 'lucide-react'
import type { Proto, TraceQuery, TraceResult } from '@/api/contract'
import { SimpleSelect } from '@/components/rh/controls'
import { Coverage } from '@/components/rh/coverage'
import { Notice, Page, Panel, SkeletonBlock } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { PanelFeature } from '@/components/rh/feature'
import { Input } from '@/components/ui/input'
import { deviceName } from '@/lib/entities'
import { cn } from '@/lib/utils'
import {
  EXAMPLES, LiveConnections, PathCard, RealTest, SavedChecks, Steps,
  parseSource, srcKey, traceHref, useQueryFromUrl, useTraceEvaluation,
} from '@/screens/trace/components'
import { useDraft } from '@/state/draft'
import { useServerConfig, useTopology } from '@/state/resource'
import { href, navigate } from '@/state/router'

const path = '/trace-preview'
const focus = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
const selectClass = 'w-full min-w-0 bg-background text-[13px] text-foreground data-[size=default]:h-10'
const recognitionLabel: Record<TraceResult['recognition']['via'], string> = {
  domain: 'По домену',
  'dns-association': 'По DNS-ассоциации',
  sni: 'По SNI',
  ip: 'Только по IP',
  classifier: 'По классификатору',
}

function QueryForm({ q, busy, onSubmit }: { q: TraceQuery; busy: boolean; onSubmit: (next: TraceQuery) => void }) {
  const { data: topology } = useTopology()
  const { config } = useDraft()
  const formId = useId()
  const [source, setSource] = useState(srcKey(q.source))
  const [target, setTarget] = useState(q.target)
  const [proto, setProto] = useState<Proto>(q.proto)
  const [port, setPort] = useState(String(q.port))
  const [ip, setIp] = useState(q.resolvedIp ?? '')
  const segments = topology?.segments.filter((segment) => segment.state !== 'removed') ?? []
  const devices = topology?.devices ?? []
  const availableSegments = new Set(segments.filter(({ state, routable }) => state === 'up' && routable.available).map(({ id }) => id))
  const knownSource = segments.some((segment) => source === `segment:${segment.id}`)
    || devices.some((device) => source === `device:${device.id}`)
  const sourceAvailable = segments.some(({ id }) => source === `segment:${id}` && availableSegments.has(id))
    || devices.some(({ id, segmentId }) => source === `device:${id}` && availableSegments.has(segmentId))
  const directIp = /^[\d.]+$|:/.test(target.trim())

  return (
    <Panel className="p-3.5 sm:p-4">
      <form
        aria-label="Параметры расчёта маршрута"
        onSubmit={(event) => {
          event.preventDefault()
          const nextSource = parseSource(source)
          const destination = target.trim()
          if (!nextSource || !sourceAvailable || !destination) return
          const resolvedIp = directIp ? undefined : ip.trim() || undefined
          const flowId = source === srcKey(q.source) && destination === q.target && proto === q.proto
            && Number(port) === q.port && resolvedIp === q.resolvedIp
            ? q.flowId
            : undefined
          onSubmit({ source: nextSource, target: destination, proto, port: Number(port), resolvedIp, flowId })
        }}
      >
        <div className="grid gap-2.5 @min-[680px]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
          <div className="grid min-w-0 gap-1.5 text-[12px] font-medium text-muted-foreground">
            <label htmlFor={`${formId}-source`}>Источник</label>
            <SimpleSelect
              id={`${formId}-source`}
              value={source}
              onChange={setSource}
              className={selectClass}
              options={[
                ...(!knownSource ? [{ value: source, label: topology ? 'Выберите доступный источник' : 'Загрузка источников…', disabled: true }] : []),
                ...segments.map(({ id, name }) => ({
                  value: `segment:${id}`, label: `Сеть «${name}»`, group: 'Сети',
                  disabled: !availableSegments.has(id),
                })),
                ...devices.map((device) => ({
                  value: `device:${device.id}`, label: deviceName(device, config), group: 'Устройства',
                  disabled: !availableSegments.has(device.segmentId),
                })),
              ]}
            />
          </div>
          <label className="grid min-w-0 gap-1.5 text-[12px] font-medium text-muted-foreground">
            Адрес назначения
            <Input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="Домен или IP"
              className="h-10 min-w-0 font-mono text-[13px] text-foreground"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
            />
          </label>
          <div className="grid grid-cols-[minmax(80px,1fr)_auto] items-end gap-2.5 @min-[680px]:grid-cols-[90px_auto]">
            <div className="grid min-w-0 gap-1.5 text-[12px] font-medium text-muted-foreground">
              <label htmlFor={`${formId}-proto`}>Протокол</label>
              <SimpleSelect
                id={`${formId}-proto`}
                value={proto}
                onChange={(value) => setProto(value === 'udp' ? 'udp' : 'tcp')}
                className={selectClass}
                options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]}
              />
            </div>
            <Button type="submit" disabled={!target.trim() || busy || !sourceAvailable} className="h-10 px-3.5">
              {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Search aria-hidden="true" />}
              {busy ? 'Проверяем' : 'Проверить'}
            </Button>
          </div>
        </div>
        {topology && availableSegments.size === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">У RouteHub нет активной сети с перехватом трафика.</p>
        )}

        <details className="group mt-2">
          <summary className={cn(
            'flex min-h-9 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden',
            focus,
          )}>
            Дополнительные параметры
            {q.port !== 443 && <span className="text-foreground">· {q.port}</span>}
            <ChevronDown aria-hidden="true" className="size-3.5 group-open:rotate-180" />
          </summary>
          <div className="flex flex-wrap gap-2.5 pb-1 pt-1.5">
            <label className="grid w-24 min-w-0 gap-1.5 text-[12px] font-medium text-muted-foreground">
              Порт
              <Input
                type="number"
                min={1}
                max={65535}
                required
                value={port}
                onChange={(event) => setPort(event.target.value)}
                onInvalid={(event) => event.currentTarget.closest('details')?.setAttribute('open', '')}
                className="h-9 min-w-0 font-mono text-[13px] text-foreground"
              />
            </label>
            {!directIp && (
              <label className="grid min-w-0 gap-1.5 text-[12px] font-medium text-muted-foreground">
                IP из DNS-ответа
                <Input value={ip} onChange={(event) => setIp(event.target.value)} placeholder="Необязательно" className="h-9 font-mono text-[13px] text-foreground" />
              </label>
            )}
          </div>
        </details>
      </form>
    </Panel>
  )
}

function ResultSummary({ result }: { result: TraceResult }) {
  const { effective } = result
  const reason = result.steps.find((step) => step.outcome === 'matched') ?? result.steps.at(-1)
  const rule = reason?.rule

  return (
    <section aria-label="Результат расчёта" className="grid gap-px overflow-hidden rounded-xl border border-border bg-border @min-[680px]:grid-cols-[minmax(0,1fr)_minmax(0,1.18fr)]">
      <div className="min-w-0 bg-card px-3.5 py-3 sm:px-4">
        <h2 className="text-[12px] font-medium text-muted-foreground">Расчётный выход</h2>
        <p className={cn(
          'mt-0.5 text-[19px] leading-tight font-semibold tracking-tight [overflow-wrap:anywhere]',
          (effective.suspended || result.configured.kind === 'block') && 'text-bad',
        )}>{effective.label}</p>
        {result.configuredLabel !== effective.label && <p className="mt-1 text-[12px] text-muted-foreground">По правилам · {result.configuredLabel}</p>}
        {(effective.viaFallback || effective.suspended) && (
          <div className="mt-2 space-y-1 text-[12px] leading-snug text-muted-foreground">
            <StatusBadge tone={effective.suspended ? 'bad' : 'warn'}>{effective.suspended ? 'Соединения приостановлены' : 'Фактический выход отличается'}</StatusBadge>
            {effective.fallbackReason && <p>{effective.fallbackReason}</p>}
          </div>
        )}
      </div>
      <div className="min-w-0 bg-card px-3.5 py-3 sm:px-4">
        <h2 className="text-[12px] font-medium text-muted-foreground">Почему выбран этот выход</h2>
        {reason && (
          <>
            <p className="mt-0.5 text-[14px] font-semibold leading-snug [overflow-wrap:anywhere]">
              {rule && reason.policyId ? (
                <a href={href('/rules-preview', { policy: reason.policyId, rule: rule.id })} className={cn('rounded-sm underline decoration-border underline-offset-3 hover:decoration-current', focus)}>
                  {rule.name}
                </a>
              ) : rule?.name ?? reason.scopeLabel}
            </p>
            <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{reason.note}</p>
          </>
        )}
        <p className="mt-2 text-[12px] text-muted-foreground">{result.physical.segmentName && `Сеть «${result.physical.segmentName}»`}</p>
      </div>
    </section>
  )
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false)
  return (
    <details
      className="group min-w-0 rounded-xl border border-border bg-card"
      onToggle={(event) => { if (event.currentTarget.open) setOpened(true) }}
    >
      <summary className={cn(
        'flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 text-[13px] font-medium hover:bg-surface-2 [&::-webkit-details-marker]:hidden',
        focus,
      )}>
        {title}
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180" />
      </summary>
      {opened && <div className="min-w-0 space-y-3 border-t border-border px-3 py-3.5">{children}</div>}
    </details>
  )
}

function RouteDetails({ result }: { result: TraceResult }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span>{recognitionLabel[result.recognition.via]}</span>
        <Coverage coverage={result.coverage} />
      </div>
      <p className="text-[12px] text-muted-foreground">{result.recognition.detail}</p>
      <PathCard r={result} />
      {result.limits.length > 0 && (
        <ul aria-label="Ограничения расчёта" className="space-y-1 text-[12px] text-muted-foreground">
          {result.limits.map((limit) => <li key={limit}>{limit}</li>)}
        </ul>
      )}
      <Steps r={result} />
    </>
  )
}

export default function TracePreview() {
  const q = useQueryFromUrl()
  const serverConfig = useServerConfig()
  const { error: topologyError } = useTopology()
  const evaluation = useTraceEvaluation(q)
  const sourceReady = !!parseSource(srcKey(q.source))
  const configError = !serverConfig.data ? serverConfig.error : null
  const resolved = evaluation.current && !evaluation.error
  const result = resolved ? evaluation.live : null
  const pending = Boolean(q.target.trim()) && sourceReady && !configError && (!evaluation.current || evaluation.busy)

  function run(next: TraceQuery) {
    const to = traceHref(path, next)
    if (to === window.location.hash && evaluation.current) evaluation.refresh()
    else navigate(to)
  }

  return (
    <Page className="@container pb-24 md:pb-14">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight md:text-[31px]">Проверка маршрута</h1>
      </header>
      <QueryForm key={evaluation.key} q={q} busy={pending} onSubmit={run} />

      <div className="mt-4 space-y-2.5" aria-live="polite" aria-busy={pending}>
        {configError ? (
          <Notice
            tone="bad"
            title="Нет данных о конфигурации"
            action={<Button type="button" size="sm" variant="outline" onClick={() => void serverConfig.refetch()}>Обновить</Button>}
          >
            {configError}
          </Notice>
        ) : topologyError && !sourceReady ? (
          <Notice tone="bad" title="Не удалось загрузить источники">{topologyError}</Notice>
        ) : pending ? (
          <SkeletonBlock rows={2} />
        ) : q.target.trim() && evaluation.error ? (
          <Notice tone="bad" title="Не удалось рассчитать маршрут">{evaluation.error}</Notice>
        ) : q.target.trim() && result ? (
          <ResultSummary result={result} />
        ) : null}
      </div>

      <div className="mt-3 grid gap-2.5 @min-[760px]:grid-cols-2">
        <div className="min-w-0 space-y-2.5">
          {!pending && q.target.trim() && result && (
            <Disclosure title="Подробности маршрута">
              <RouteDetails result={result} />
            </Disclosure>
          )}
          <Disclosure title="Сохранённые проверки и примеры">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  type="button"
                  key={example}
                  disabled={!sourceReady}
                  onClick={() => run({ ...q, target: example, resolvedIp: undefined, flowId: undefined })}
                  className={cn('h-9 rounded-lg border border-border px-2 font-mono text-[11.5px] hover:bg-muted', focus)}
                >
                  {example}
                </button>
              ))}
            </div>
            <PanelFeature name="savedChecks"><SavedChecks current={q} onSelect={run} /></PanelFeature>
          </Disclosure>
        </div>
        <div className="min-w-0 space-y-2.5">
          <Disclosure title="Контрольный запрос">
            {resolved && evaluation.live && q.target.trim() ? (
              <RealTest key={evaluation.key} q={q} r={evaluation.live} />
            ) : (
              <p className="text-[12.5px] text-muted-foreground">Сначала рассчитайте маршрут.</p>
            )}
          </Disclosure>
          <Disclosure title="Живые соединения"><LiveConnections /></Disclosure>
        </div>
      </div>
    </Page>
  )
}
