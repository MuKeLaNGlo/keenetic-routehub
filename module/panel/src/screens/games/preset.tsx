import { useId, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { GamePreset, Segment } from '@/api/contract'
import { useCaps, useCanWrite, useTopology } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { Panel, KV, Notice } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { SettingDisclosure } from '@/components/rh/setting-disclosure'
import { Mono, Segmented, SimpleSelect } from '@/components/rh/controls'
import { Switch } from '@/components/ui/switch'
import { ActionChip, ActionPicker } from '@/components/rh/action'
import { CapabilityNote } from '@/components/rh/coverage'
import { deviceName, segmentName } from '@/lib/entities'
import { ACTION_KIND_LABEL, actionLabel } from '@/lib/labels'
import { cn } from '@/lib/utils'
import { CONFIDENCE, PRIORITY, SCENARIO_LABEL } from './meta'

/** One game preset: signatures, scope, the route decision and network priority. */
export function PresetCard({ preset, segments, compact = false }: { preset: GamePreset; segments: Segment[]; compact?: boolean }) {
  const settingsGroup = useId()
  const { config, edit } = useDraft()
  const { data: caps } = useCaps()
  const { data: topo } = useTopology()
  const can = useCanWrite()
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null)
  const toggling = requestedEnabled !== null
  const enabled = requestedEnabled ?? preset.enabled

  const confidence = CONFIDENCE[preset.confidence]
  const routeCap = caps?.gameRouting.routeAtOpen
  const strictCap = caps?.gameRouting.strictPriority
  const qosCap = caps?.gameRouting.intelliQos
  const routeDisabled = !can || !routeCap?.available
  const known = segments.filter((s) => s.state !== 'removed')
  const scoped = preset.scope.deviceIds.map((id) => topo?.devices.find((d) => d.id === id)).filter((d) => d !== undefined)
  const deviceOptions = (topo?.devices ?? [])
    .filter((d) => !preset.scope.deviceIds.includes(d.id))
    .map((d) => ({ value: d.id, label: deviceName(d, config), hint: segmentName(topo, d.segmentId) }))
  const emptyScope = preset.scope.segmentIds.length === 0 && preset.scope.deviceIds.length === 0
  const scopeNames = [
    ...preset.scope.segmentIds.map((id) => segmentName(topo, id)),
    ...preset.scope.deviceIds.map((id) => {
      const device = scoped.find((entry) => entry.id === id)
      return device ? deviceName(device, config) : id
    }),
  ]
  const scopeSummary = scopeNames.length > 3
    ? `${scopeNames.slice(0, 3).join(', ')} +${scopeNames.length - 3}`
    : scopeNames.join(', ') || 'Сети и устройства не выбраны'
  const routeSummary = preset.routeAction.kind === 'inherit'
    ? 'По политике устройства'
    : config ? actionLabel({ config, caps }, preset.routeAction) : ACTION_KIND_LABEL[preset.routeAction.kind]
  const routeOption = caps?.actions[preset.routeAction.kind]
  const priorityCap = preset.priority === 'strict' ? strictCap : preset.priority === 'intelliqos' ? qosCap : undefined

  const mutate = (label: string, f: (g: GamePreset) => void) =>
    edit(`Игровой пресет «${preset.name}»: ${label}`, (c) => {
      const g = c.games.find((x) => x.id === preset.id)
      if (g) f(g)
    })

  const toggle = (
    <Switch
      checked={enabled}
      disabled={!can || toggling}
      aria-label={`Автоматика для «${preset.name}»`}
      onCheckedChange={async (on) => {
        setRequestedEnabled(on)
        await mutate(on ? 'включён' : 'выключен', (g) => {
          g.enabled = on
        })
        setRequestedEnabled(null)
      }}
    />
  )

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pt-4 pb-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14.5px] font-medium">{preset.name}</span>
          <Mono className="text-[11.5px] text-muted-foreground">{preset.version}</Mono>
          <StatusBadge tone={confidence.tone}>{confidence.label}</StatusBadge>
          {!preset.enabled && <StatusBadge tone="muted" dashed>Автоматика выключена</StatusBadge>}
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          {preset.enabled
            ? 'Маршрут и приоритет применяются только к распознанным потокам матча и голоса.'
            : 'Потоки этой игры определяются, но не обрабатываются отдельно: действует политика устройства.'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="text-[12.5px] text-muted-foreground" role="status">{toggling ? 'Сохраняем…' : enabled ? 'Включён' : 'Выключен'}</span>
        {toggle}
      </div>
    </div>
  )

  const disabledNotice = !preset.enabled && (
    <div className="border-t px-4 py-3">
      <Notice tone="muted" title={`«${preset.name}» идёт по политике устройства`}>
        Классификатор по-прежнему видит эти потоки, но не меняет ни маршрут, ни приоритет: без включённого пресета сигнал не даёт права на переключение.
      </Notice>
    </div>
  )

  const technical = (
    <div className={compact ? "px-3 py-2.5" : "border-t px-4 py-3"}>
      <KV
        items={[
          [
            'Источники сигнатур',
            <span className="flex flex-wrap gap-1.5">
              {preset.signatureSources.map((s) => (
                <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[11.5px]">
                  {s}
                </span>
              ))}
            </span>,
          ],
          ['Подтверждение', <span className="text-[12.5px]">{confidence.label.toLowerCase()} — чем выше, тем реже автоматика ошибается на общем трафике.</span>],
          [
            'Семейства адресов',
            <span className="flex flex-wrap items-center gap-1.5">
              {preset.families.map((f) => (
                <span
                  key={f}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11.5px] font-medium',
                    f === 'v6' && caps && !caps.ipv6.available ? 'bg-warn/12 text-warn' : 'bg-muted',
                  )}
                >
                  {f === 'v4' ? 'IPv4' : 'IPv6'}
                </span>
              ))}
              {caps && !caps.ipv6.available && preset.families.includes('v6') && <span className="text-[11.5px] text-muted-foreground">v6-потоки на этой установке не перехватываются</span>}
            </span>,
          ],
          [
            'Сценарии',
            <span className="flex flex-wrap gap-1.5">
              {preset.scenarios.map((s) => (
                <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[11.5px]">
                  {SCENARIO_LABEL[s]}
                </span>
              ))}
            </span>,
          ],
          ['Исключения', preset.exclusions.length ? <span className="flex flex-wrap gap-1.5">{preset.exclusions.map((e) => <span key={e} className="rounded bg-muted px-1.5 py-0.5 text-[11.5px]">{e}</span>)}</span> : <span className="text-[12.5px] text-muted-foreground">нет</span>],
        ]}
      />
    </div>
  )

  const scope = (
    <div className={cn("space-y-2.5 py-3", compact ? "px-3" : "border-t px-4")}>
      {!compact && <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium">Где работает автоматика</span>
        <span className="text-[12px] text-muted-foreground">
          {scoped.length > 0 ? `${scoped.length} устройств` : 'устройства не выбраны'}
          {preset.scope.segmentIds.length > 0 && ` · сети: ${preset.scope.segmentIds.map((id) => segmentName(topo, id)).join(', ')}`}
        </span>
      </div>}

      {scoped.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {scoped.map((d) => (
            <span key={d.id} className={cn("inline-flex items-center gap-1 rounded-full bg-muted pr-1 pl-3 text-[12.5px]", compact ? "min-h-7 max-w-full [overflow-wrap:anywhere]" : "h-7")}>
              <span className="min-w-0">{deviceName(d, config)}</span>
              <span className="text-[11.5px] text-muted-foreground">{segmentName(topo, d.segmentId)}</span>
              <button
                type="button"
                disabled={!can}
                aria-label={`Убрать «${deviceName(d, config)}» из области`}
                onClick={() => mutate(`убрано устройство «${deviceName(d, config)}»`, (g) => void (g.scope.deviceIds = g.scope.deviceIds.filter((x) => x !== d.id)))}
                className="pressable inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          className={compact ? "h-9 w-full min-w-0" : "min-w-48 max-w-full"}
          size="sm"
          aria-label={compact ? 'Добавить устройство в область пресета' : undefined}
          placeholder="Добавить устройство"
          value={null}
          disabled={!can || deviceOptions.length === 0}
          options={deviceOptions}
          onChange={(id) => {
            const d = topo?.devices.find((x) => x.id === id)
            mutate(`добавлено устройство «${d ? deviceName(d, config) : id}»`, (g) => void g.scope.deviceIds.push(id))
          }}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {known.map((s) => {
          const active = preset.scope.segmentIds.includes(s.id)
          return (
            <Chip
              key={s.id}
              active={active}
              disabled={!can}
              onClick={() => mutate(`сеть «${s.name}» ${active ? 'убрана' : 'добавлена'}`, (g) => void (g.scope.segmentIds = active ? g.scope.segmentIds.filter((x) => x !== s.id) : [...g.scope.segmentIds, s.id]))}
            >
              {s.name}
            </Chip>
          )
        })}
      </div>

      {(!compact || !emptyScope) && <p className="text-[12px] leading-relaxed text-muted-foreground">
        {emptyScope
          ? 'Область пуста: автоматика не применяется ни к одному устройству, даже если пресет включён.'
          : 'Сети расширяют область до всех её устройств; устройства из списка обрабатываются в любом случае.'}
      </p>}
    </div>
  )

  const route = (
    <div className={cn("space-y-2.5 py-3", compact ? "px-3" : "border-t px-4")}>
      {!compact && <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium">Маршрут для распознанного потока</span>
        <ActionChip action={preset.routeAction} />
      </div>}
      {!compact && <p className="text-[12px] leading-relaxed text-muted-foreground">
        Применяется к соединению с уверенной классификацией матча или голоса. Неуверенный и поздний сигнал маршрут не меняет.
      </p>}
      <ActionPicker aria-label={compact ? 'Маршрут игрового потока' : undefined} value={preset.routeAction} onChange={(a) => mutate('изменён маршрут', (g) => void (g.routeAction = a))} disabled={routeDisabled} />
      {!compact && routeCap && (
        <CapabilityNote availability={routeCap}>
          Маршрут по игровому сигналу недоступен
        </CapabilityNote>
      )}
    </div>
  )

  const priority = (
    <div className={cn("space-y-2.5 py-3", compact ? "px-3" : "border-t px-4")}>
      {!compact && <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium">Сетевой приоритет</span>
        <span className="text-[12px] text-muted-foreground">{PRIORITY[preset.priority].hint}</span>
      </div>}
      <Segmented
        size={compact ? "sm" : "md"}
        value={preset.priority}
        onChange={(v) => mutate(`приоритет «${PRIORITY[v].label}»`, (g) => void (g.priority = v))}
        aria-label="Сетевой приоритет игрового потока"
        options={(['off', 'intelliqos', 'strict'] as const).map((v) => {
          const availability = v === 'strict' ? strictCap : compact && v === 'intelliqos' ? qosCap : undefined
          return {
            value: v,
            label: PRIORITY[v].label,
            hint: availability?.available === false ? `Недоступно: ${availability.reason ?? 'не поддерживается этой установкой'}` : PRIORITY[v].hint,
            disabled: !can || availability?.available === false,
          }
        })}
      />
      {compact && priorityCap?.available !== false && <p className="text-xs text-muted-foreground">{PRIORITY[preset.priority].hint}</p>}
      {!compact && strictCap && preset.priority === 'strict' && (
        <CapabilityNote availability={strictCap}>
          Строгий приоритет недоступен
        </CapabilityNote>
      )}
      {!compact && qosCap && preset.priority === 'intelliqos' && (
        <CapabilityNote availability={qosCap}>
          Приоритет IntelliQoS недоступен
        </CapabilityNote>
      )}
    </div>
  )

  if (compact) return (
    <div className="min-w-0 space-y-3">
      <Panel className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3.5 py-2">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          Автоматика
          <span role="status"><StatusBadge tone={toggling ? 'info' : enabled ? 'ok' : 'muted'}>{toggling ? 'Сохраняем…' : enabled ? 'Включена' : 'Выключена'}</StatusBadge></span>
        </div>
        {toggle}
      </Panel>
      <Panel className="divide-y divide-border overflow-hidden">
        <SettingDisclosure
          group={settingsGroup}
          title="Маршрут"
          value={routeSummary}
          note={routeCap?.available === false
            ? routeCap.reason ?? 'Маршрут по игровому сигналу недоступен'
            : routeOption?.available === false ? routeOption.reason ?? 'Выбранный маршрут недоступен' : undefined}
        >{route}</SettingDisclosure>
        <SettingDisclosure
          group={settingsGroup}
          title="Сетевой приоритет"
          value={preset.priority === 'off' ? 'Не меняется' : PRIORITY[preset.priority].label}
          note={priorityCap?.available === false ? priorityCap.reason ?? 'Выбранный приоритет недоступен' : undefined}
        >{priority}</SettingDisclosure>
        <SettingDisclosure
          group={settingsGroup}
          title="Сети и устройства"
          value={scopeSummary}
          note={emptyScope && preset.enabled ? 'Автоматика ждёт выбора области' : undefined}
        >{scope}</SettingDisclosure>
        <SettingDisclosure
          group={settingsGroup}
          title="Сигнатуры"
          value={`${confidence.label} · ${preset.version}`}
          note={caps?.ipv6.available === false && preset.families.includes('v6') ? 'Перехват IPv6 недоступен' : undefined}
        >{technical}</SettingDisclosure>
      </Panel>
    </div>
  )

  return (
    <Panel>
      {header}{disabledNotice}{technical}{scope}{route}{priority}
    </Panel>
  )
}

function Chip({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'pressable inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
        active ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent',
      )}
    >
      {active && <Check className="size-3" strokeWidth={3} />}
      {children}
    </button>
  )
}
