import { useId } from 'react'
import { Loader2, MessagesSquare, MonitorPlay, Play, Route, Settings2 } from 'lucide-react'
import { isDemo } from '@/api/mode'
import type { Runtime, ZapretService, ZapretServiceId } from '@/api/contract'
import { ActionChip, ActionPicker } from '@/components/rh/action'
import { Segmented } from '@/components/rh/controls'
import { CapabilityNote, ReadOnlyHint } from '@/components/rh/coverage'
import { EmptyState, Notice, Page, Panel, SkeletonBlock } from '@/components/rh/layout'
import { PreviewHeader } from '@/components/rh/preview-header'
import { SettingDisclosure } from '@/components/rh/setting-disclosure'
import { DetailSheet } from '@/components/rh/sheet'
import { StatusDot, type Tone } from '@/components/rh/status'
import { Button, buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { actionLabel } from '@/lib/labels'
import { READINESS, scopeLabel, ZAPRET_META } from '@/screens/zapret/meta'
import { ScopeBlock } from '@/screens/zapret/scope'
import { StrategyBlock } from '@/screens/zapret/strategy'
import { useCaps, useRuntime, useServerConfig, useStrategies, useTopology } from '@/state/resource'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'
import { selectionMode, StrategyChecks, useStrategyChecks } from './strategy-checks'
import { useZapretSettings, type SaveState } from './useZapretSettings'

const path = '/zapret-preview'
const serviceIcons = { youtube: MonitorPlay, discord: MessagesSquare } as const
const cardLink = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-9 px-2 text-xs')

function serviceStatus(
  runtime: Runtime['zapret'][ZapretServiceId] | undefined,
  applied: ZapretService | undefined,
  unavailable: boolean,
): { tone: Tone; label: string; detail?: string; fallback?: boolean } {
  if (unavailable) return { tone: 'muted', label: 'Недоступен' }
  if (!runtime) return { tone: 'muted', label: 'Нет текущего статуса' }
  if (applied?.enabled === false) return { tone: 'muted', label: 'Выключен', detail: 'Действует обычная политика сети' }
  if (runtime.engine === 'not-installed') return { tone: 'muted', label: 'Движок не установлен' }
  if (runtime.engine !== 'running') return { tone: 'bad', label: 'Сбой обработки', fallback: true }
  if (runtime.payloadCheck === 'down') return { tone: 'bad', label: 'Проверка не проходит', detail: runtime.effective }
  if (runtime.payloadCheck === 'degraded') return { tone: 'warn', label: 'Работает частично', detail: runtime.effective.replace(/^Zapret · /, '') }
  if (!runtime.packetsSeen) return { tone: 'muted', label: 'Пакеты пока не видны' }
  if (runtime.payloadCheck !== 'ok') return { tone: 'info', label: 'Пакеты видны', detail: 'Доступность отдельных функций ещё не подтверждена' }
  return { tone: 'ok', label: 'Работает' }
}

export default function ZapretPreview() {
  const settingsGroup = useId()
  const route = useRoute()
  const caps = useCaps()
  const runtime = useRuntime()
  const serverConfig = useServerConfig()
  const topology = useTopology()
  const strategies = useStrategies()
  const config = serverConfig.data
  const settings = useZapretSettings(config?.zapret)
  const services = (config?.zapret ?? []).map((service) => {
    const operation = settings.states[service.id]
    return operation?.phase === 'saving' ? { ...service, ...operation.patch } : service
  })
  const selected = services.find((service) => service.id === route.query.get('service'))
  const currentTab = route.query.get('tab') === 'checks' ? 'checks' : 'settings'
  const unavailable = caps.data?.zapret.available === false
  const readOnly = caps.data?.access === 'read'
  const stale = Boolean(runtime.error || runtime.data?.link.state === 'offline')
  const editable = Boolean(config && !serverConfig.error && caps.data?.access === 'write' && !unavailable && !stale)
  const revisionMismatch = Boolean(runtime.data && config && runtime.data.loadedRevision !== config.revision)
  const current = stale || serverConfig.error || revisionMismatch ? undefined : runtime.data
  const segments = topology.data?.segments ?? []
  const managed = segments.filter((segment) => segment.state !== 'removed' && segment.routable.available
    && config?.segmentPolicies.some((policy) => policy.segmentId === segment.id && policy.mode === 'managed'))
  const selectedStrategy = strategies.data?.find((strategy) => strategy.service === selected?.id && strategy.id === selected.strategyId)
  const fallbackAvailability = selected && caps.data?.actions[selected.failAction.kind]
  const selectedSave = selected && settings.states[selected.id]
  const selectedEditable = editable && selectedSave?.phase !== 'saving'
  const checks = useStrategyChecks((id, strategyId, enable, isCurrent) =>
    settings.save(id, enable ? { strategyId, enabled: true } : { strategyId }, isCurrent),
  )
  const canCheck = !unavailable && !stale
  const available = (id: ZapretServiceId) => strategies.data?.some((strategy) => strategy.service === id && strategy.readiness !== 'needs-kernel-module')

  const strategyConfiguration = (tab: 'settings' | 'checks') => selected && (
    <SettingDisclosure
      group={`${settingsGroup}-${tab}`}
      title="Стратегия"
      value={[
        selectedStrategy?.name ?? (strategies.data ? 'Стратегия недоступна' : 'Каталог не загружен'),
        selectionMode(selected) === 'auto' ? 'Автоподбор' : 'Ручной выбор',
        selectedStrategy && !selectedStrategy.protos.includes('udp') ? 'Только TCP' : undefined,
      ].filter(Boolean).join(' · ')}
      note={selectedStrategy && selectedStrategy.readiness !== 'ready' ? READINESS[selectedStrategy.readiness].label : undefined}
    >
      {isDemo && <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
        <span className="text-[13px] font-medium">Выбор стратегии</span>
        <Segmented<'manual' | 'auto'>
          size="sm"
          aria-label={`Режим выбора стратегии ${ZAPRET_META[selected.id].name}`}
          value={selectionMode(selected)}
          options={[
            { value: 'manual', label: 'Вручную', disabled: !selectedEditable || checks.state(selected.id).busy },
            { value: 'auto', label: 'Автоматически', disabled: !selectedEditable || checks.state(selected.id).busy },
          ]}
          onChange={(mode) => {
            if (mode === selectionMode(selected)) return
            void settings.save(selected.id, { selectionMode: mode })
          }}
        />
      </div>}
      {strategies.data ? (
        <StrategyBlock
          compact
          service={selected}
          strategy={selectedStrategy}
          strategies={strategies.data}
          showPicker={selectionMode(selected) === 'manual'}
          disabled={!selectedEditable || checks.state(selected.id).busy}
          onChange={(id) => void settings.save(selected.id, { strategyId: id })}
        />
      ) : (
        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">{strategies.error ?? 'Загружаем стратегии…'}</p>
      )}
      {selectionMode(selected) === 'auto' && (
        <p className="px-3 pb-3 text-[12px] text-muted-foreground">При включении обработки панель подберёт стратегию по обязательным проверкам TCP.</p>
      )}
    </SettingDisclosure>
  )

  return (
    <Page className="@container pb-24 md:pb-14">
      <PreviewHeader title="Zapret" actions={readOnly && <ReadOnlyHint />} />

      <div className="space-y-3">
        {caps.data && <CapabilityNote availability={caps.data.zapret}>Zapret недоступен на этом роутере</CapabilityNote>}
        {(serverConfig.error || stale) && (
          <Notice
            tone="warn"
            title={config ? 'Текущий статус недоступен' : 'Не удалось загрузить настройки Zapret'}
            action={<Button variant="outline" size="sm" onClick={() => {
              void serverConfig.refetch()
              void runtime.refetch()
            }}>Обновить</Button>}
          >
            {serverConfig.error ?? runtime.error ?? 'Роутер вне сети'}
          </Notice>
        )}
        {!config ? (
          !serverConfig.error && <SkeletonBlock rows={3} />
        ) : services.length === 0 ? (
          <EmptyState title="Нет настроенных сервисов Zapret" />
        ) : (
          <div className="grid gap-3 @min-[610px]:grid-cols-2">
            {services.map((service) => {
              const { id } = service
              const { name, host } = ZAPRET_META[id]
              const Icon = serviceIcons[id]
              const applied = config.zapret.find((value) => value.id === id)
              const status = serviceStatus(current?.zapret[id], applied, unavailable)
              const traceNetwork = managed.find((segment) => service.segmentIds.includes(segment.id)) ?? managed[0]
              const trace = href('/trace-preview', { src: traceNetwork ? `segment:${traceNetwork.id}` : null, t: host })
              const scope = current && applied?.enabled && !unavailable ? scopeLabel(segments, applied.segmentIds) : null
              const testing = checks.state(id)
              const operation = settings.states[id]
              const automatic = selectionMode(service) === 'auto'
              const unavailableAuto = automatic && !service.enabled && (!canCheck || !available(id))
              return (
                <article key={id} aria-labelledby={`zapret-preview-${id}`} className="flex min-w-0 flex-col rounded-xl border border-border bg-card">
                  <div className="min-w-0 flex-1 space-y-2.5 px-3.5 py-3">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Icon className="size-4" aria-hidden="true" />
                        </span>
                        <h2 id={`zapret-preview-${id}`} className="text-[15px] font-semibold">{name}</h2>
                      </div>
                      <Switch
                        checked={service.enabled}
                        disabled={!editable || testing.busy || unavailableAuto || operation?.phase === 'saving'}
                        aria-label={`Обработка ${name} через Zapret`}
                        onCheckedChange={(enabled) => {
                          if (enabled && automatic) {
                            if (!canCheck || !available(id)) return
                            void checks.start(service, 'auto', true)
                            return
                          }
                          void settings.save(id, { enabled })
                        }}
                      />
                    </div>
                    {operation?.phase === 'error' && <SaveIndicator state={operation} />}
                    {testing.busy && operation?.phase !== 'saving' && <p role="status" className="text-[12px] text-muted-foreground">{testing.run?.kind === 'auto' ? 'Подбираем стратегию…' : 'Проверяем стратегию…'}</p>}
                    {automatic && !service.enabled && testing.run?.enable && testing.failed && (
                      <p role="alert" className="text-[12px] text-bad">{testing.run.error ?? (testing.task?.state === 'cancelled'
                        ? 'Подбор остановлен. Обработка остаётся выключенной.'
                        : 'Рабочая стратегия не найдена. Обработка остаётся выключенной.')}</p>
                    )}
                    {unavailableAuto && <p className="text-[12px] text-muted-foreground">Для включения с автоподбором нужны связь и доступная стратегия.</p>}
                    <div role="status" className="flex min-h-[19px] flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                      {operation?.phase === 'saving' ? (
                        <><Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" /> Применяем настройки…</>
                      ) : (
                        <><StatusDot tone={status.tone} /><span className="font-medium">{revisionMismatch && !stale && !unavailable ? 'Синхронизация Zapret…' : status.label}</span></>
                      )}
                    </div>
                    <div className="min-h-4 text-[12px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                      {status.fallback && applied ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>При отказе</span>
                          {applied.failAction.kind === 'inherit'
                            ? <span>Обычная политика сети</span>
                            : <ActionChip action={applied.failAction} config={config} />}
                        </div>
                      ) : status.detail ?? scope}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-0.5 border-t border-border px-1.5 py-1">
                    <a href={href(path, { service: id })} aria-label={`Настройки ${name}`} className={cardLink}><Settings2 aria-hidden="true" /> Настройки</a>
                    <a href={href(path, { service: id, tab: 'checks' })} aria-label={`Проверки ${name}`} className={cardLink}><Play aria-hidden="true" /> Проверки</a>
                    <a href={trace} aria-label={`Маршрут ${name}`} className={cardLink}><Route aria-hidden="true" /> Маршрут</a>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <DetailSheet
        open={Boolean(selected)}
        title={selected ? ZAPRET_META[selected.id].name : 'Zapret'}
        headerExtra={readOnly && <ReadOnlyHint />}
        onClose={() => closeQuery('service', 'tab')}
        width="lg"
      >
        {selected && (
          <Tabs
            key={selected.id}
            value={currentTab}
            onValueChange={(tab) => setQuery({ tab: tab === 'checks' ? 'checks' : null }, { replace: true })}
            className="min-w-0 gap-3"
          >
            <div className="border-b border-border">
              <TabsList variant="line" aria-label={`Zapret для ${ZAPRET_META[selected.id].name}`} className="h-10 max-w-full p-0">
                <TabsTrigger value="settings" className="px-3 after:bottom-[-3px]">Настройки</TabsTrigger>
                <TabsTrigger value="checks" className="px-3 after:bottom-[-3px]">Проверки</TabsTrigger>
              </TabsList>
            </div>
            <SaveIndicator state={selectedSave} />
            <TabsContent value="settings">
              <Panel className="divide-y divide-border overflow-hidden">
                {strategyConfiguration('settings')}
                <SettingDisclosure
                  group={`${settingsGroup}-settings`}
                  title="Сети"
                  value={topology.data ? scopeLabel(segments, selected.segmentIds) : 'Список сетей не загружен'}
                  note={topology.data && selected.segmentIds.some((id) => !managed.some((segment) => segment.id === id)) ? 'Часть выбранных сетей недоступна' : undefined}
                >
                  {topology.data ? (
                    <ScopeBlock
                      compact
                      service={selected}
                      segments={segments}
                      managedIds={managed.map((segment) => segment.id)}
                      disabled={!selectedEditable || !isDemo}
                      onChange={(ids) => void settings.save(selected.id, { segmentIds: ids })}
                    />
                  ) : (
                    <p className="px-3 py-3 text-[12.5px] text-muted-foreground">{topology.error ?? 'Загружаем сети…'}</p>
                  )}
                </SettingDisclosure>
                <SettingDisclosure
                  group={`${settingsGroup}-settings`}
                  title="Если Zapret перестанет работать"
                  value={selected.failAction.kind === 'inherit' ? 'По правилам сети и устройства' : config ? actionLabel({ config, caps: caps.data }, selected.failAction) : ''}
                  note={selected.failAction.kind === 'zapret'
                    ? 'Выберите доступный запасной маршрут'
                    : fallbackAvailability?.available === false ? fallbackAvailability.reason ?? 'Запасной маршрут недоступен' : undefined}
                >
                  <div className="p-3">
                    <ActionPicker
                      aria-label="Маршрут при отказе Zapret"
                      allow={['inherit', 'vpn', 'direct', 'keenetic', 'block']}
                      value={selected.failAction}
                      disabled={!selectedEditable || !isDemo}
                      onChange={(action) => void settings.save(selected.id, { failAction: action })}
                    />
                  </div>
                </SettingDisclosure>
              </Panel>
            </TabsContent>
            <TabsContent value="checks" className="space-y-3">
              {caps.data && <CapabilityNote availability={caps.data.zapret}>Проверки Zapret недоступны</CapabilityNote>}
              {stale && <p className="text-[12.5px] text-muted-foreground">Для запуска проверки нужна связь с роутером.</p>}
              <Panel className="overflow-hidden">{strategyConfiguration('checks')}</Panel>
              <StrategyChecks
                key={selected.id}
                service={selected}
                strategies={strategies.data ?? []}
                {...checks.state(selected.id)}
                disabled={!canCheck || !strategies.data || selectedSave?.phase === 'saving'}
                editable={editable}
                error={checks.tasksError}
                start={(kind) => void checks.start(selected, kind)}
              />
            </TabsContent>
          </Tabs>
        )}
      </DetailSheet>
    </Page>
  )
}

function SaveIndicator({ state }: { state?: SaveState }) {
  if (!state) return null
  if (state.phase === 'error') return <p role="alert" className="text-[12px] text-bad [overflow-wrap:anywhere]">Не удалось применить настройку. {state.message}</p>
  return (
    <p role="status" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" /> Применяем настройки…
    </p>
  )
}
