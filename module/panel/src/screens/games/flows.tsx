import { ArrowUpRight, Radar, RefreshCw } from 'lucide-react'
import type { ClassifiedFlow } from '@/api/contract'
import { useCaps, useFlows, useTopology } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { href } from '@/state/router'
import { EmptyState, Gate, SkeletonBlock, Notice } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { Mono, TimeAgo } from '@/components/rh/controls'
import { CapabilityNote } from '@/components/rh/coverage'
import { deviceName, segmentName } from '@/lib/entities'
import { cn } from '@/lib/utils'
import { count } from '@/lib/format'
import { CATEGORY_LABEL, CONFIDENCE, FLOW_KIND, flowHost, flowKind } from './meta'
import { Button } from '@/components/ui/button'

/** Live classification, grouped by the device whose traffic it is. */
export function LiveFlows({ compact = false }: { compact?: boolean }) {
  const flows = useFlows()
  const topo = useTopology()
  const { config } = useDraft()
  const { data: caps } = useCaps()

  return (
    <Gate res={flows} skeleton={<SkeletonBlock rows={3} />}>
      {(list) => {
        if (caps && !caps.gameRouting.routeAtOpen.available && !caps.gameRouting.lateSignalPriority.available) {
          return (
            <CapabilityNote availability={caps.gameRouting.routeAtOpen} className="px-4 py-3">
              Живая классификация недоступна
            </CapabilityNote>
          )
        }
        if (list.length === 0)
          return (
            <EmptyState icon={<Radar />} title="Пока нет распознанных потоков">
              {!compact && 'Как только игровое соединение будет классифицировано, оно появится здесь вместе с маршрутом и приоритетом.'}
            </EmptyState>
          )
        // Without the client list there is no way to tell a foreign flow from an
        // unlisted one — wait for the topology instead of guessing.
        if (!topo.data) {
          return compact && topo.error ? (
            <Notice tone="warn" title="Не удалось загрузить устройства" action={<Button size="sm" variant="outline" onClick={() => void topo.refetch()}>Обновить</Button>} />
          ) : <SkeletonBlock rows={3} />
        }
        const devices = topo.data.devices

        const groups = devices
          .map((device) => ({ device, list: list.filter((f) => f.deviceId === device.id) }))
          .filter((g) => g.list.length > 0)
        const orphans = list.filter((f) => !devices.some((d) => d.id === f.deviceId))

        return (
          <div className={compact ? 'space-y-3' : 'space-y-5'}>
            {compact && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{count(list.length, ['поток', 'потока', 'потоков'])} · <TimeAgo at={flows.updatedAt} prefix="обновлено " /></span>
                <Button size="sm" variant="outline" disabled={flows.loading} onClick={() => void flows.refetch()}>
                  <RefreshCw className={flows.loading ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" /> Обновить
                </Button>
              </div>
            )}
            {groups.map(({ device, list: flowsOfDevice }) => (
              <div key={device.id} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className={cn('flex items-center gap-2', compact && 'min-w-0 flex-wrap')}>
                    <span className={cn('text-[13.5px] font-medium', compact && 'min-w-0 [overflow-wrap:anywhere]')}>{deviceName(device, config)}</span>
                    <span className="text-[12px] text-muted-foreground">
                      {segmentName(topo.data, device.segmentId)} · {count(flowsOfDevice.length, ['поток', 'потока', 'потоков'])}
                    </span>
                  </div>
                  <a href={href(compact ? '/trace-preview' : '/trace', { src: `device:${device.id}` })} className="text-[12px] text-muted-foreground hover:text-foreground">
                    Политика устройства →
                  </a>
                </div>
                <div className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-border">
                  {flowsOfDevice.map((flow) => (
                    <FlowRow key={flow.id} flow={flow} compact={compact} />
                  ))}
                </div>
              </div>
            ))}
            {orphans.length > 0 && (
              <Notice tone="muted" title="Потоки устройства, которого нет в Keenetic">
                {orphans.map((f) => `${f.app} · ${f.dst}`).join('; ')}. Устройство не найдено в списке клиентов — классификация показана без привязки к политике.
              </Notice>
            )}
          </div>
        )
      }}
    </Gate>
  )
}

function FlowRow({ flow, compact }: { flow: ClassifiedFlow; compact: boolean }) {
  const kind = FLOW_KIND[flowKind(flow)]
  if (compact) {
    const [host, port] = splitDestination(flow.dst)
    return (
      <a
        href={href('/trace-preview', { src: `device:${flow.deviceId}`, t: host, proto: flow.proto, port, flow: flow.id })}
        title="Проверить маршрут этого потока"
        className={cn('grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-l-2 bg-card px-3 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]', kind.border)}
      >
        <span className="block min-w-0 [overflow-wrap:anywhere]">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-medium">{flow.app}</span>
            {flow.category !== 'unknown' && <span className="text-[11.5px] text-muted-foreground">{CATEGORY_LABEL[flow.category]}</span>}
          </span>
          <span className="block text-[11px] text-muted-foreground"><Mono className="text-[11px]">{flow.dst}</Mono> · {flow.proto.toUpperCase()}</span>
        </span>
        <span className="col-start-1 row-start-2 block min-w-0 text-[12px] [overflow-wrap:anywhere] @min-[640px]:col-start-2 @min-[640px]:row-start-1">
          <span className="block">{flow.route}</span>
          <span className="block text-[11.5px] text-muted-foreground">{kind.label} · {flow.priority}</span>
        </span>
        <ArrowUpRight className="col-start-2 row-span-2 row-start-1 size-4 text-muted-foreground @min-[640px]:col-start-3 @min-[640px]:row-span-1" aria-hidden="true" />
      </a>
    )
  }
  return (
    <a
      href={href('/trace', { src: `device:${flow.deviceId}`, t: flowHost(flow.dst) })}
      className={cn('pressable block border-l-2 bg-card px-3 py-2.5 outline-none hover:bg-surface-2 focus-visible:bg-surface-2', kind.border)}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium">{flow.app}</span>
        <StatusBadge tone={kind.tone} dashed={kind.dashed}>
          {kind.label}
        </StatusBadge>
        <span className="text-[12px] text-muted-foreground">{CATEGORY_LABEL[flow.category]}</span>
        <span className="ml-auto flex items-center gap-2">
          <Mono>{flow.dst}</Mono>
          <span className="text-[11px] font-medium text-muted-foreground">{flow.proto.toUpperCase()}</span>
        </span>
      </div>

      <div className="mt-1 grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
        <div className="text-muted-foreground">
          Маршрут: <span className="text-foreground">{flow.route}</span>
        </div>
        <div className="text-muted-foreground">
          Приоритет: <span className="text-foreground">{flow.priority}</span>
        </div>
      </div>

      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{flow.note}</p>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>{CONFIDENCE[flow.confidence].label}</span>
        <span>{flow.detectedAt === 'open' ? 'сигнал при открытии' : 'сигнал после открытия'}</span>
        <span className="inline-flex items-center gap-1">
          Почему так? <ArrowUpRight className="size-3" />
        </span>
      </div>
    </a>
  )
}

function splitDestination(destination: string): [host: string, port?: string] {
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(destination)
  if (ipv6) return [ipv6[1], ipv6[2]]
  const hostPort = /^([^:]+):(\d+)$/.exec(destination)
  return hostPort ? [hostPort[1], hostPort[2]] : [destination]
}
