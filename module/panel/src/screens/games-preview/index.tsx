import { ChevronDown, ChevronRight, Gamepad2, Plus } from 'lucide-react'
import type { Capabilities, Config, GamePreset, Topology } from '@/api/contract'
import { WriteButton } from '@/components/rh/controls'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { EmptyState, Notice, Page, SkeletonBlock } from '@/components/rh/layout'
import { PreviewHeader } from '@/components/rh/preview-header'
import { DetailSheet } from '@/components/rh/sheet'
import { StatusDot } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { deviceName, segmentName } from '@/lib/entities'
import { actionLabel } from '@/lib/labels'
import { LiveFlows } from '@/screens/games/flows'
import { CapabilityGrid, ModelPanel } from '@/screens/games/model'
import { PresetCard } from '@/screens/games/preset'
import { GamePresetEditor, isGameIPv4, type PresetSeed } from '@/screens/games/preset-editor'
import { ObservedGameFlows } from '@/screens/games/observed'
import { useCaps, useRuntime, useServerConfig, useTopology } from '@/state/resource'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'

const newPreset = '@new'
const newQuery = ['preset', 'gameIp', 'gamePort', 'gameProto', 'gameDevice'] as const

function scopeLabel(preset: GamePreset, config: Config, topology: Topology | undefined): string {
  const networks = preset.scope.segmentIds.map((id) => segmentName(topology, id))
  const devices = preset.scope.deviceIds.map((id) => {
    const device = topology?.devices.find((entry) => entry.id === id)
    return device ? deviceName(device, config) : id
  })
  const scope = [...networks, ...devices]
  const visible = scope.slice(0, 2).join(', ')
  return scope.length > 2 ? `${visible} +${scope.length - 2}` : visible || 'Область не задана'
}

function presetAction(preset: GamePreset, config: Config, caps: Capabilities | undefined) {
  if (!preset.enabled) return { label: 'По политике устройства' }
  if (!preset.scope.segmentIds.length && !preset.scope.deviceIds.length) return { label: 'По политике устройства', limit: 'Пустая область' }
  if (caps?.ipv6.available === false && !preset.families.includes('v4')) return { label: 'По политике устройства', limit: 'Перехват IPv6 недоступен' }

  const priority = preset.priority === 'strict'
    ? caps?.gameRouting.strictPriority.available === false ? 'Строгий приоритет недоступен' : 'Строгий приоритет'
    : preset.priority === 'intelliqos'
      ? caps?.gameRouting.intelliQos.available === false ? 'IntelliQoS недоступен' : 'IntelliQoS'
      : undefined
  if (preset.signatures && preset.routeAction.kind === 'inherit') return { label: 'По политике устройства', priority }
  if (caps?.gameRouting.routeAtOpen.available === false) return { label: 'По политике устройства', limit: 'Игровой маршрут недоступен', priority }
  const label = preset.routeAction.kind === 'inherit' ? 'По политике устройства' : actionLabel({ config, caps }, preset.routeAction)
  const limit = caps?.ipv6.available === false && preset.families.includes('v6') ? 'Только IPv4' : undefined
  return { label, limit, priority }
}

function PresetRow({
  preset,
  config,
  topology,
  caps,
  to,
}: {
  preset: GamePreset
  config: Config
  topology?: Topology
  caps?: Capabilities
  to: string
}) {
  const action = presetAction(preset, config, caps)

  return (
    <li>
      <a
        href={to}
        aria-haspopup="dialog"
        className="grid min-h-15 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring @min-[640px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]"
      >
        <span className="col-span-2 min-w-0 @min-[640px]:col-span-1">
          <span className="block text-[13.5px] font-semibold [overflow-wrap:anywhere]">{preset.name}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
            <StatusDot tone={preset.enabled ? 'ok' : 'muted'} className="size-1.5 [&>span]:size-1.5" />
            {preset.enabled ? 'Включён' : 'Выключен'}
          </span>
        </span>
        <span className="col-start-1 row-start-2 min-w-0 text-[12px] [overflow-wrap:anywhere] @min-[640px]:col-start-2 @min-[640px]:row-start-1">
          <span className="block text-[11px] text-muted-foreground @min-[640px]:hidden">Область</span>
          {scopeLabel(preset, config, topology)}
        </span>
        <span className="col-start-2 row-start-2 min-w-0 text-[12px] [overflow-wrap:anywhere] @min-[640px]:col-start-3 @min-[640px]:row-start-1">
          <span className="block text-[11px] text-muted-foreground @min-[640px]:hidden">Действие</span>
          <span className="block">{action.label}</span>
          {(action.limit || action.priority) && (
            <span className="block text-[11.5px] text-muted-foreground">{[action.limit, action.priority].filter(Boolean).join(' · ')}</span>
          )}
        </span>
        <ChevronRight className="col-start-3 row-span-2 row-start-1 size-3.5 text-muted-foreground @min-[640px]:col-start-4 @min-[640px]:row-span-1" aria-hidden="true" />
      </a>
    </li>
  )
}

export default function GamesPreview() {
  const route = useRoute()
  const tab = route.query.get('tab') === 'flows' ? 'flows' : 'presets'
  const serverConfig = useServerConfig()
  const config = serverConfig.data
  const runtime = useRuntime()
  const { data: topology } = useTopology()
  const { data: caps } = useCaps()
  const presetId = route.query.get('preset')
  const preset = config?.games.find((entry) => entry.id === presetId)
  const canAdd = Boolean(config && caps?.features?.gamePresets?.available && config.games.length < 24)
  const adding = presetId === newPreset
  const demo = import.meta.env.MODE === 'demo'
  const applied = !!config && !serverConfig.error && !runtime.error && runtime.data?.loadedRevision === config.revision
  const address = route.query.get('gameIp') ?? ''
  const port = Number(route.query.get('gamePort'))
  const proto = route.query.get('gameProto')
  const seed: PresetSeed | undefined = adding && isGameIPv4(address) && Number.isInteger(port) && port >= 1 && port <= 65535 &&
    (proto === 'tcp' || proto === 'udp')
    ? { signature: { destination: address, port, protocol: proto, category: 'match' }, deviceId: route.query.get('gameDevice') ?? undefined }
    : undefined

  function openNew(seed?: PresetSeed) {
    setQuery({
      preset: newPreset,
      gameIp: seed?.signature.destination ?? null, gamePort: seed ? String(seed.signature.port) : null,
      gameProto: seed?.signature.protocol ?? null, gameDevice: seed?.deviceId ?? null,
    })
  }

  function closePreset() {
    if (presetId && window.location.hash === href(route.path, Object.fromEntries(route.query))) closeQuery(...newQuery)
  }

  return (
    <Page className="@container pb-24 md:pb-14">
      <PreviewHeader title="Игры" actions={
        <>
          <ReadOnlyHint />
          {caps?.features?.gamePresets?.available && (
            <WriteButton size="sm" variant="outline" disabled={!canAdd}
              reason={config && config.games.length >= 24 ? 'Достигнут лимит из 24 игровых пресетов' : undefined}
              onClick={() => openNew()}>
              <Plus aria-hidden="true" /> Добавить пресет
            </WriteButton>
          )}
        </>
      } />
      <Tabs
        value={tab}
        onValueChange={(value) => setQuery({ tab: value === 'flows' ? 'flows' : null, preset: null, gameIp: null, gamePort: null, gameProto: null, gameDevice: null })}
        className="min-w-0 gap-3"
      >
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Игровой трафик" className="h-9 p-0">
            <TabsTrigger value="presets" className="px-3 text-[13px] after:bottom-[-3px]">Пресеты</TabsTrigger>
            <TabsTrigger value="flows" className="px-3 text-[13px] after:bottom-[-3px]">Потоки</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="presets" className="space-y-2.5">
          {caps?.gameRouting.routeAtOpen.available === false && (
            <Notice tone="info" title="Прямой игровой маршрут недоступен">{caps.gameRouting.routeAtOpen.reason}</Notice>
          )}
          {serverConfig.error && (
            <Notice
              tone="warn"
              title={config ? 'Данные могли устареть' : 'Не удалось загрузить пресеты'}
              action={<Button variant="outline" size="sm" onClick={() => void serverConfig.refetch()}>Обновить</Button>}
            />
          )}
          {config ? config.games.length ? (
            <>
              {!applied && <p className="text-xs text-muted-foreground">Показаны сохранённые настройки. Действующая ревизия пока не подтверждена.</p>}
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_14px] gap-2.5 border-b border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground @min-[640px]:grid">
                  <span>Пресет</span><span>Область</span><span>Действие</span>
                </div>
                <ul className="divide-y divide-border" aria-label="Пресеты игр">
                  {config.games.map((item) => (
                    <PresetRow
                      key={item.id}
                      preset={item}
                      config={config}
                      topology={topology}
                      caps={caps}
                      to={href(route.path, { ...Object.fromEntries(route.query), preset: item.id })}
                    />
                  ))}
                </ul>
              </div>
            </>
          ) : <EmptyState icon={<Gamepad2 />} title="Игровых пресетов нет">
            {caps?.features?.gamePresets?.available && 'Добавьте точный адрес сервера или выберите соединение в разделе «Потоки».'}
          </EmptyState>
            : !serverConfig.error && <SkeletonBlock rows={3} />}
        </TabsContent>
        <TabsContent value="flows">
          {demo ? <LiveFlows compact /> : <ObservedGameFlows canCreate={canAdd} onCreate={openNew} />}
        </TabsContent>
      </Tabs>

      <details className="group mt-4 rounded-xl border border-border bg-card">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          Возможности и справка
          <ChevronDown className="size-3.5 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-4 border-t border-border p-3.5">
          <CapabilityGrid />
          <ModelPanel exact={!demo} />
        </div>
      </details>

      <DetailSheet
        open={!!presetId && !!config}
        onClose={closePreset}
        title={adding ? 'Новый игровой пресет' : preset?.name ?? 'Пресет не найден'}
        headerExtra={caps?.access === 'read' && <ReadOnlyHint />}
      >
        {config && (adding || preset?.signatures) ? (
          <GamePresetEditor key={route.query.toString()} preset={preset} seed={seed} config={config} caps={caps} topology={topology} onClose={closePreset} />
        ) : preset ? <PresetCard key={preset.id} preset={preset} segments={topology?.segments ?? []} compact />
          : <EmptyState title="Пресета нет в конфигурации" />}
      </DetailSheet>
    </Page>
  )
}
