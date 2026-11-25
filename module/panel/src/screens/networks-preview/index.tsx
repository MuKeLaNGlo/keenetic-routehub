import { ChevronRight, Lock, Wifi } from 'lucide-react'
import type { Capabilities, Config, Segment, Topology } from '@/api/contract'
import { EmptyState, Notice, Page, SkeletonBlock } from '@/components/rh/layout'
import { PanelFeature } from '@/components/rh/feature'
import { StatusDot, type Tone } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { policyById } from '@/lib/entities'
import { count } from '@/lib/format'
import { cn } from '@/lib/utils'
import { devicesInSegment } from '@/screens/networks/helpers'
import { TemplatesSection } from '@/screens/networks/templates'
import { useCaps, useServerConfig, useTopology } from '@/state/resource'
import { href, useRoute } from '@/state/router'
import { SegmentPreviewSheet } from './SegmentSheet'

const previewPath = '/networks-preview'
const focus = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
const networkStates: Record<Segment['state'], { label: string; tone: Tone }> = {
  up: { label: 'Поднята', tone: 'ok' },
  down: { label: 'Опущена', tone: 'bad' },
  removed: { label: 'Удалена', tone: 'muted' },
}
const views = [
  { id: 'segments', label: 'Сегменты', to: href(previewPath) },
  { id: 'templates', label: 'Шаблоны', to: href(previewPath, { tab: 'templates' }) },
] as const

function NetworkLink({
  segment,
  topology,
  config,
  capabilities,
}: {
  segment: Segment
  topology: Topology
  config: Config
  capabilities?: Capabilities
}) {
  const association = config.segmentPolicies.find((entry) => entry.segmentId === segment.id)
  const policy = policyById(config, association?.policyId)
  const excluded = association?.mode === 'excluded'
  const state = networkStates[segment.state]
  const deviceCount = devicesInSegment(topology, segment.id).length
  const ssids = topology.ssids.filter((ssid) => segment.ssidIds.includes(ssid.id))
  const sharesPolicy = ssids.length > 1
    && (capabilities?.perSsidPolicy.available === false || ssids.some((ssid) => !ssid.distinguishable.available))
  const policyLabel = excluded
    ? 'Вне RouteHub'
    : policy
      ? `Политика «${policy.name}»`
      : association ? 'Политика недоступна' : 'Политика не назначена'

  return (
    <li className="min-w-0 bg-card">
      <a href={href(previewPath, { s: segment.id })} className={cn(
        'flex h-full flex-col gap-2 px-3.5 py-3 hover:bg-surface-2',
        focus,
      )}>
        <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_14px] items-center gap-2.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold [overflow-wrap:anywhere]">{segment.name}</span>
            </div>
            <div className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-muted-foreground">
              {excluded && <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />}
              <span className="[overflow-wrap:anywhere]">{policyLabel}</span>
            </div>
          </div>
          <div className="space-y-1 text-right text-[12px] leading-tight text-muted-foreground">
            <div className="flex items-center justify-end gap-1.5">
              <StatusDot tone={state.tone} className="size-1.5 [&>span]:size-1.5" />
              {state.label}
            </div>
            <div className="tabular-nums">{count(deviceCount, ['устройство', 'устройства', 'устройств'])}</div>
          </div>
          <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </div>
        {(sharesPolicy || (!segment.routable.available && !excluded)) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-2 text-[12px] leading-snug text-muted-foreground">
            {sharesPolicy && (
              <span className="flex items-start gap-1.5">
                <Wifi aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {ssids.length} SSID на одном мосту с общей политикой
              </span>
            )}
            {!segment.routable.available && !excluded && (
              <span>Управление маршрутизацией недоступно</span>
            )}
          </div>
        )}
      </a>
    </li>
  )
}

export default function NetworksPreview() {
  const route = useRoute()
  const topology = useTopology()
  const { data: networks } = topology
  const serverConfig = useServerConfig()
  const { data: config } = serverConfig
  const { data: capabilities } = useCaps()
  const selected = route.query.get('tab') === 'templates' ? 'templates' : 'segments'
  const showTemplates = selected === 'templates'
  const ready = Boolean(config && (showTemplates || networks))
  const failed = Boolean(serverConfig.error || (!showTemplates && topology.error))

  function retry() {
    void serverConfig.refetch()
    if (!showTemplates) void topology.refetch()
  }

  return (
    <Page className="@container pb-24 md:pb-14">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight md:text-[31px]">Сети</h1>
      </header>

      <nav aria-label="Сети и шаблоны" className="mb-4 flex gap-1 border-b border-border">
        {views.map(({ id, label, to }) => (
          <a key={id} href={to} aria-current={selected === id ? 'page' : undefined} className={cn(
            'inline-flex min-h-10 items-center rounded-t-md border-b-2 px-3 text-[13px] font-medium hover:bg-surface-2',
            selected === id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground',
            focus,
          )}>
            {label}
          </a>
        ))}
      </nav>

      {failed && (
        <Notice
          tone="warn"
          title={ready ? 'Данные могли устареть' : 'Не удалось загрузить данные'}
          className="mb-3"
          action={<Button type="button" variant="outline" size="sm" onClick={retry}>Обновить</Button>}
        />
      )}
      {!ready && !failed && <SkeletonBlock rows={4} />}
      {showTemplates ? (
        config && <PanelFeature name="segments"><TemplatesSection compact /></PanelFeature>
      ) : (
        config && networks && (
          networks.segments.length ? (
            <ul aria-label="Сегменты сети" className="grid gap-px overflow-hidden rounded-xl border border-border bg-border @min-[660px]:grid-cols-2">
              {networks.segments.map((segment) => (
                <NetworkLink
                  key={segment.id}
                  segment={segment}
                  topology={networks}
                  config={config}
                  capabilities={capabilities}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="Нет сетей">Проверьте список сегментов в KeeneticOS.</EmptyState>
          )
        )
      )}
      {networks && config && <SegmentPreviewSheet segmentId={route.query.get('s')} />}
    </Page>
  )
}
