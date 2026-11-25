import { ArrowRight, Route } from 'lucide-react'
import type { Capabilities, Config, Device, Topology } from '@/api/contract'
import { TimeAgo } from '@/components/rh/controls'
import { Panel } from '@/components/rh/layout'
import { StatusBadge, StatusDot } from '@/components/rh/status'
import { policyById, segmentName } from '@/lib/entities'
import { actionLabel } from '@/lib/labels'
import { devicePolicyView, policyChain } from '@/lib/policy'
import { useDraft } from '@/state/draft'
import { useCaps, useRuntime, useServerConfig, useTopology } from '@/state/resource'
import { href } from '@/state/router'

interface RouteSummary {
  label: string
  detail?: string
  policyIds?: string[]
  cycle?: boolean
}

const bindings: Record<Device['binding'], { label: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  confirmed: { label: 'Привязка подтверждена', tone: 'ok' },
  observed: { label: 'Привязка не подтверждена', tone: 'muted' },
  ambiguous: { label: 'Адрес неоднозначен', tone: 'warn' },
  lost: { label: 'Привязка потеряна', tone: 'bad' },
}

function describeRoute(config: Config, topo: Topology, device: Device, caps?: Capabilities): RouteSummary {
  const association = config.segmentPolicies.find(({ segmentId }) => segmentId === device.segmentId)
  if (!association) return { label: 'Штатный Keenetic', detail: 'Для сети нет политики RouteHub.' }
  if (association.mode === 'excluded') return { label: 'Штатный Keenetic', detail: 'Сеть исключена из RouteHub.' }

  const network = policyById(config, association.policyId)
  if (device.binding !== 'confirmed') {
    return {
      label: network ? `Политика сети «${network.name}»` : 'Политика сети недоступна',
      detail: 'Личная политика применяется после подтверждения привязки.',
      policyIds: network ? policyChain(config, network.id).chain.map(({ id }) => id) : [],
    }
  }

  const policy = config.devicePolicies.find(({ deviceId }) => deviceId === device.id)
  if (policy?.mode === 'fixed-exit' && policy.fixedExit) {
    return { label: actionLabel({ config, caps }, policy.fixedExit), detail: 'Настроенный выход для несистемного трафика.' }
  }

  const view = devicePolicyView(config, topo, device.id)
  const own = policy?.mode === 'independent' || policy?.mode === 'local-overrides' ? view.ownPolicy : undefined
  const source = view.sourcePolicy ?? (policy?.mode === 'independent' ? undefined : network)
  const groups = policy ? config.deviceGroups.filter((entry) => entry.deviceIds.includes(device.id)) : []
  const policyIds = [
    ...(own ? policyChain(config, own.id).chain.map(({ id }) => id) : []),
    ...(source ? policyChain(config, source.id).chain.map(({ id }) => id) : []),
    ...groups.map(({ policyId }) => policyId),
  ]
  const label = own && source
    ? `Личные правила и «${source.name}»`
    : own ? 'Личные правила'
      : source ? `Политика «${source.name}»` : groups.length ? 'Правила групп устройств' : 'Нет активной политики'
  return { label, detail: 'Выход зависит от назначения.', policyIds, cycle: view.cycle }
}

export function CompactDeviceSummary({ device, topo, tracePath }: { device: Device; topo: Topology; tracePath: string }) {
  const { config, server, changes } = useDraft()
  const { error: configError } = useServerConfig()
  const { data: caps } = useCaps()
  const { data: runtime, error: runtimeError } = useRuntime()
  const { error: topologyError } = useTopology()
  const saved = server && describeRoute(server, topo, device, caps)
  const drafted = config && describeRoute(config, topo, device, caps)
  const confirmed = !!server && !!runtime && !configError && !runtimeError && !topologyError && runtime.loadedRevision === server.revision
  const binding = bindings[device.binding]
  const ssid = topo.ssids.find(({ id }) => id === device.ssidId)
  const connectionKnown = device.connectionKnown !== false
  const network = topo.segments.find(({ id }) => id === device.segmentId)
  const relevantPolicies = new Set([...(saved?.policyIds ?? []), ...(drafted?.policyIds ?? [])])
  const relevantGroups = new Set([...(server?.deviceGroups ?? []), ...(config?.deviceGroups ?? [])]
    .filter((group) => group.deviceIds.includes(device.id)).map(({ id }) => id))
  const localDraft = changes.some((change) => (
    (change.collection === 'devicePolicies' && change.id === device.id)
    || (change.collection === 'deviceGroups' && relevantGroups.has(change.id))
    || (change.collection === 'segmentPolicies' && change.id === device.segmentId)
    || (change.collection === 'policies' && relevantPolicies.has(change.id))
  ))
  const showDraft = !!drafted && changes.length > 0 && (localDraft || saved?.label !== drafted.label || saved?.detail !== drafted.detail)

  return (
    <Panel className="space-y-2.5 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium [overflow-wrap:anywhere]">{segmentName(topo, device.segmentId)}{ssid && ` · ${ssid.name}`}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <StatusDot tone={connectionKnown && device.online && !topologyError ? 'ok' : 'muted'} />
            {connectionKnown ? <>{topologyError && 'Последнее состояние: '}{device.online ? 'В сети' : 'Не в сети'}</> : 'Нет данных о подключении'}
            {connectionKnown && !device.online && <TimeAgo at={device.lastSeen} />}
          </p>
        </div>
        <StatusBadge tone={binding.tone}>{binding.label}</StatusBadge>
      </div>

      <div className="border-t border-border pt-2.5">
        <p className="text-[11.5px] text-muted-foreground">{confirmed ? 'Действующая маршрутизация' : 'Сохранённая маршрутизация'}</p>
        <p className="mt-0.5 text-[13.5px] font-semibold [overflow-wrap:anywhere]">{saved?.label ?? 'Нет данных о маршруте'}</p>
        {saved?.detail && <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{saved.detail}</p>}
        {saved && !confirmed && <p className="mt-0.5 text-xs text-warn">Действующая ревизия не подтверждена.</p>}
        {saved?.cycle && <p className="mt-0.5 text-xs text-bad">Цикл в цепочке политик.</p>}
        {network?.routable.available === false && (
          <p className="mt-0.5 text-xs text-warn [overflow-wrap:anywhere]">{network.routable.reason ?? 'Маршрутизация RouteHub недоступна для этой сети.'}</p>
        )}
      </div>

      {device.binding !== 'confirmed' && device.bindingNote && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{device.bindingNote}</p>}
      {showDraft && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <StatusBadge tone="draft">Черновик</StatusBadge>
          <span className="min-w-0 [overflow-wrap:anywhere]">{drafted.label}</span>
          {drafted.cycle && <span className="text-bad">Цикл в политике</span>}
        </div>
      )}

      <a href={href(tracePath, { src: `device:${device.id}` })} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        <Route className="size-4 shrink-0" aria-hidden="true" /> Проверить маршрут <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
      </a>
    </Panel>
  )
}
