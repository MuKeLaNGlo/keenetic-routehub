import { useState } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import type { Config, Device, Topology } from '@/api/contract'
import { Mono, Segmented, SimpleSelect, TimeAgo } from '@/components/rh/controls'
import { Gate, Page, Panel, SkeletonBlock } from '@/components/rh/layout'
import { StatusDot } from '@/components/rh/status'
import { DraftMark } from '@/components/rh/truth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { deviceIp, deviceName, segmentName } from '@/lib/entities'
import { actionLabel } from '@/lib/labels'
import { cn } from '@/lib/utils'
import { DeviceSheet, KIND_ICON, MODE_META, useDeviceChange } from '@/screens/devices/DeviceSheet'
import { useDraft } from '@/state/draft'
import { useTopology } from '@/state/resource'
import { href, setQuery, useRoute } from '@/state/router'
import './devices-preview.css'

type DevicesFilter = 'all' | 'online' | 'attention'

const addressOptions = [
  { value: 'all', label: 'Любой IPv4' },
  { value: 'reserved', label: 'Есть резерв IPv4' },
  { value: 'unreserved', label: 'IPv4 без резерва' },
  { value: 'unknown', label: 'Нет данных об IPv4' },
] as const

const policyOptions = [
  { value: 'all', label: 'Любая политика' },
  { value: 'personal', label: 'Личная политика' },
  { value: 'network', label: 'Без личной политики' },
] as const

const BINDING: Record<Device['binding'], { label: string; tone: string }> = {
  confirmed: { label: 'Привязка подтверждена', tone: 'text-muted-foreground' },
  observed: { label: 'Привязка не проверена', tone: 'text-muted-foreground' },
  ambiguous: { label: 'Адрес неоднозначен', tone: 'text-warn' },
  lost: { label: 'Привязка потеряна', tone: 'text-bad' },
}
const order = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })
const needsAttention = ({ binding }: Device) => binding === 'ambiguous' || binding === 'lost'

function addressType({ addresses }: Device) {
  if (addresses.some(({ family, confirmed }) => family === 'v4' && confirmed)) return 'reserved'
  if (addresses.some(({ family, source }) => family === 'v4' && source !== 'static')) return 'unreserved'
  return 'unknown'
}

function devicePolicy(device: Device, config: Config | undefined): string {
  if (!config) return '—'
  const network = config.segmentPolicies.find(({ segmentId }) => segmentId === device.segmentId)
  if (!network || network.mode === 'excluded') return 'Штатный Keenetic'
  const settings = config.devicePolicies.find(({ deviceId }) => deviceId === device.id)
  if (!settings || device.binding !== 'confirmed' || settings.mode === 'inherit-actual') return 'Правила сети'
  return settings.mode === 'fixed-exit' && settings.fixedExit ? actionLabel({ config }, settings.fixedExit) : MODE_META[settings.mode].label
}

function DeviceRow({ device, topo, config, to }: { device: Device; topo: Topology; config?: Config; to: string }) {
  const change = useDeviceChange(device.id)
  const name = deviceName(device, config)
  const ssid = topo.ssids.find(({ id }) => id === device.ssidId)
  const binding = BINDING[device.binding]
  const connectionKnown = device.connectionKnown !== false
  const ip = deviceIp(device) ?? deviceIp(device, 'v6')
  return (
    <li>
      <a href={to} aria-haspopup="dialog" className="devices-preview__columns devices-preview__row min-h-13 px-3.5 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span className="devices-preview__identity flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-4" aria-hidden="true">
            {KIND_ICON[device.kind]}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="min-w-0 text-[13.5px] leading-snug font-medium [overflow-wrap:anywhere]">{name}</span>
              <DraftMark change={change} />
            </span>
            {ip && <Mono className="block text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">{ip}</Mono>}
          </span>
        </span>
        <span className="devices-preview__network min-w-0 text-[12.5px] leading-snug">
          <span className="block [overflow-wrap:anywhere]">{segmentName(topo, device.segmentId)}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground" title={ssid?.name}>{ssid?.name ?? (connectionKnown ? 'Кабель' : 'Тип подключения неизвестен')}</span>
        </span>
        <span className="devices-preview__status min-w-0 text-[12px] leading-snug">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <StatusDot tone={connectionKnown && device.online ? 'ok' : 'muted'} />
            <span>{connectionKnown ? device.online ? 'В сети' : 'Не в сети' : 'Нет данных о подключении'}</span>
            {connectionKnown && !device.online && <TimeAgo at={device.lastSeen} className="text-[11.5px] text-muted-foreground" />}
          </span>
          <span className={cn('block text-[11.5px] [overflow-wrap:anywhere]', binding.tone)}>{binding.label}</span>
        </span>
        <span className="devices-preview__policy min-w-0 text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
          {devicePolicy(device, config)}
        </span>
        <ChevronRight className="devices-preview__chevron size-3.5 text-muted-foreground" aria-hidden="true" />
      </a>
    </li>
  )
}

export default function DevicesPreview() {
  const topology = useTopology()
  const { config } = useDraft()
  const route = useRoute()
  const [query, setQueryText] = useState('')
  const segment = route.query.get('seg') ?? 'all'
  const filterParam = route.query.get('status')
  const filter: DevicesFilter = filterParam === 'online' || filterParam === 'attention' ? filterParam : 'all'
  const address = addressOptions.find(({ value }) => value === route.query.get('ip4'))?.value ?? 'all'
  const policy = policyOptions.find(({ value }) => value === route.query.get('policy'))?.value ?? 'all'
  const personal = new Set(config?.devicePolicies.filter(({ mode }) => mode !== 'inherit-actual').map(({ deviceId }) => deviceId))
  const deviceId = route.query.get('d')
  const topo = topology.data
  const segments = topo?.segments.filter(({ state }) => state !== 'removed') ?? []
  const needle = query.trim().toLocaleLowerCase('ru')
  const matching = (topo?.devices ?? []).filter((device) => (
    (segment === 'all' || device.segmentId === segment) &&
    (address === 'all' || addressType(device) === address) &&
    (policy === 'all' || !!config && personal.has(device.id) === (policy === 'personal')) &&
    (!needle || [deviceName(device, config), device.hostname, device.vendor, device.mac, ...device.addresses.map(({ addr }) => addr)]
      .some((value) => value.toLocaleLowerCase('ru').includes(needle)))
  ))
  const online = matching.filter(({ online, connectionKnown }) => connectionKnown !== false && online)
  const attention = matching.filter(needsAttention)
  const visible = [...(filter === 'online' ? online : filter === 'attention' ? attention : matching)]
    .sort((left, right) => Number(right.online) - Number(left.online) || order.compare(deviceName(left, config), deviceName(right, config)))
  const filtered = segment !== 'all' || filter !== 'all' || address !== 'all' || policy !== 'all' || !!needle
  const queryParams = Object.fromEntries(route.query)

  function reset() {
    setQueryText('')
    setQuery({ seg: null, status: null, ip4: null, policy: null }, { replace: true })
  }

  return (
    <Page className="devices-preview pb-24 md:pb-14">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5">
        <h1 className="devices-preview__title">Устройства</h1>
      </header>

      {topo && (
        <div className="devices-preview__filters mb-3" role="group" aria-label="Фильтры устройств">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input type="search" aria-label="Поиск устройств" placeholder="Имя, IP или MAC" value={query} onChange={(event) => setQueryText(event.target.value)} className="h-9 bg-card pl-9" />
          </div>
          <SimpleSelect
            aria-label="Сеть"
            value={segment}
            onChange={(value) => setQuery({ seg: value === 'all' ? null : value }, { replace: true })}
            className="w-full min-w-0 bg-card text-[13px] data-[size=default]:h-9"
            options={[
              { value: 'all', label: 'Все сети' },
              ...segments.map(({ id, name }) => ({ value: id, label: name })),
              ...(segment !== 'all' && !segments.some(({ id }) => id === segment) ? [{ value: segment, label: segmentName(topo, segment) }] : []),
            ]}
          />
          <SimpleSelect aria-label="Резерв IPv4" value={address} options={[...addressOptions]}
            onChange={(value) => setQuery({ ip4: value === 'all' ? null : value }, { replace: true })}
            className="w-full min-w-0 bg-card text-[13px] data-[size=default]:h-9"
          />
          <SimpleSelect aria-label="Наличие личной политики" value={policy} options={[...policyOptions]} disabled={!config}
            onChange={(value) => setQuery({ policy: value === 'all' ? null : value }, { replace: true })}
            className="w-full min-w-0 bg-card text-[13px] data-[size=default]:h-9"
          />
          <Segmented
            aria-label="Состояние устройства"
            size="sm"
            value={filter}
            onChange={(value) => setQuery({ status: value === 'all' ? null : value }, { replace: true })}
            className="devices-preview__status-filter w-full [&>button]:h-8 [&>button]:flex-1"
            options={[
              { value: 'all', label: <>Все <span className="tabular opacity-75">{matching.length}</span></> },
              { value: 'online', label: <>В сети <span className="tabular opacity-75">{online.length}</span></> },
              { value: 'attention', label: <>Проблемы <span className="tabular opacity-75">{attention.length}</span></> },
            ]}
          />
        </div>
      )}

      <Gate res={topology} skeleton={<SkeletonBlock rows={6} />}>
        {(data) => visible.length ? (
          <Panel className="overflow-hidden rounded-2xl">
            <div aria-hidden="true" className="devices-preview__columns devices-preview__column-labels border-b border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
              <span>Устройство</span><span>Сеть</span><span>Состояние</span><span>Политика</span>
            </div>
            <ul className="divide-y divide-border" aria-label="Устройства">
              {visible.map((device) => (
                <DeviceRow key={device.id} device={device} topo={data} config={config} to={href(route.path, { ...queryParams, d: device.id, rule: null })} />
              ))}
            </ul>
          </Panel>
        ) : (
          <Panel className="rounded-2xl px-4 py-7 text-center">
            <p className="text-sm text-muted-foreground" role="status">{filtered ? 'По этим фильтрам устройств нет' : 'Устройства пока не обнаружены'}</p>
            {filtered && <Button type="button" variant="ghost" className="mt-2" onClick={reset}>Сбросить фильтры</Button>}
          </Panel>
        )}
      </Gate>

      {topo && <DeviceSheet deviceId={deviceId} topo={topo} />}
    </Page>
  )
}
