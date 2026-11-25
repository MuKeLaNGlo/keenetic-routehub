import type { ReactNode } from 'react'
import { ArrowUpRight, Ban, CornerLeftUp, Router, ShieldCheck, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isDemo } from '@/api/mode'
import type { Action, ActionKind, Config } from '@/api/contract'
import { ACTION_KIND_LABEL, actionLabel, COUNTRY_FLAG } from '@/lib/labels'
import { useCaps, useStrategies } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { SimpleSelect, type SelectOption } from './controls'

export const ACTION_ICON: Record<ActionKind, ReactNode> = {
  keenetic: <Router />,
  direct: <ArrowUpRight />,
  vpn: <ShieldCheck />,
  zapret: <Zap />,
  block: <Ban />,
  inherit: <CornerLeftUp />,
}

/** Route actions get a quiet, consistent icon+label; colour only for block. */
const ACTION_CLS: Record<ActionKind, string> = {
  keenetic: 'text-foreground/80 bg-muted',
  direct: 'text-foreground bg-muted',
  vpn: 'text-foreground bg-muted',
  zapret: 'text-foreground bg-muted',
  block: 'text-bad bg-bad/10',
  inherit: 'text-muted-foreground bg-transparent ring-1 ring-inset ring-border ring-dashed',
}

export function ActionChip({ action, config, className, short }: { action: Action; config?: Pick<Config, 'profiles' | 'exitGroups' | 'primaryProfileId'>; className?: string; short?: boolean }) {
  const { data: caps } = useCaps()
  const draft = useDraft().config
  const cfg = config ?? draft
  const label = cfg ? actionLabel({ config: cfg, caps }, action) : ACTION_KIND_LABEL[action.kind]
  return (
    <span className={cn('inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium [&>svg]:size-3.5 [&>svg]:shrink-0', ACTION_CLS[action.kind], className)}>
      {ACTION_ICON[action.kind]}
      <span className="truncate">{short ? ACTION_KIND_LABEL[action.kind] : label}</span>
    </span>
  )
}

const KINDS: ActionKind[] = ['inherit', 'vpn', 'direct', 'keenetic', 'zapret', 'block']
const ROUTE_CHOICES: Record<ActionKind, { label: string; hint: string }> = {
  inherit: { label: 'По правилам сети и устройства', hint: 'Использовать обычные правила маршрутизации для этого трафика.' },
  vpn: { label: 'Через VPN', hint: 'Отправить трафик через выбранный профиль или группу.' },
  direct: { label: 'Напрямую через провайдера', hint: 'Использовать выбранное интернет-подключение без VPN.' },
  keenetic: { label: 'Передать Keenetic', hint: 'Передать выбор подключения штатной политике роутера.' },
  zapret: { label: 'Обработать через Zapret', hint: 'Применить конфигурацию Zapret и выбрать выход для трафика.' },
  block: { label: 'Заблокировать соединение', hint: 'Отклонять трафик, к которому применяется это действие.' },
}

export function ActionPicker({
  value,
  onChange,
  allow = KINDS,
  disabled,
  'aria-label': ariaLabel = 'Маршрут трафика',
}: {
  value: Action
  onChange: (a: Action) => void
  allow?: readonly ActionKind[]
  disabled?: boolean
  'aria-label'?: string
}) {
  const { data: caps } = useCaps()
  const { config } = useDraft()
  const { data: strategies } = useStrategies()
  if (!config) return null

  const defaults: Record<ActionKind, Action> = {
    keenetic: { kind: 'keenetic' },
    direct: { kind: 'direct', uplinkId: caps?.ispUplinks[0]?.id ?? 'isp-main' },
    vpn: { kind: 'vpn', target: config.exitGroups[0] ? { type: 'group', groupId: config.exitGroups[0].id } : { type: 'primary' } },
    zapret: { kind: 'zapret', strategyId: isDemo ? strategies?.[0]?.id ?? 'zs-yt-fake' : '', exit: 'direct' },
    block: { kind: 'block' },
    inherit: { kind: 'inherit' },
  }

  const vpnOptions: SelectOption[] = [
    { value: 'primary', label: 'Основной профиль', hint: config.profiles.find((p) => p.id === config.primaryProfileId)?.name, group: '' },
    ...config.exitGroups.map((g) => ({ value: `group:${g.id}`, label: `Группа «${g.name}»`, text: `Группа «${g.name}»`, hint: `${g.memberIds.length} профиля · ${g.mode === 'failover' ? 'по порядку' : g.mode === 'best' ? 'лучший' : 'вручную'}`, group: 'Группы выходов' })),
    ...config.profiles.map((p) => ({
      value: `profile:${p.id}`,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <span>{COUNTRY_FLAG[p.country] ?? '🏳️'}</span>
          {p.alias ?? p.name}
        </span>
      ),
      text: p.alias ?? p.name,
      disabled: p.lifecycle === 'missing-upstream',
      hint: !p.enabled ? 'Отключён' : p.lifecycle === 'missing-upstream' ? 'Исчез из подписки' : `${p.protocol.toUpperCase()} · ${p.transport}`,
      group: 'Профили',
    })),
  ]
  const vpnValue = value.kind === 'vpn' ? (value.target.type === 'primary' ? 'primary' : value.target.type === 'group' ? `group:${value.target.groupId}` : `profile:${value.target.profileId}`) : null

  const kinds = allow.includes(value.kind) ? allow : [...allow, value.kind]
  const options = kinds.map((kind) => {
    const reason = !allow.includes(kind) ? 'Недоступно для этого действия' : caps?.actions[kind]?.available === false
      ? caps.actions[kind].reason ?? 'Недоступно на этой установке'
      : undefined
    return { value: kind, label: ROUTE_CHOICES[kind].label, hint: reason ?? (kind === 'zapret' && !isDemo ? 'Использовать действующую конфигурацию Zapret.' : ROUTE_CHOICES[kind].hint), disabled: !!reason }
  })
  const selected = options.find((option) => option.value === value.kind)

  return (
    <div className="@container min-w-0 space-y-2">
      <div className={cn('grid min-w-0 gap-2', (value.kind === 'vpn' || value.kind === 'direct' || isDemo && value.kind === 'zapret') && '@min-[480px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]')}>
        <SimpleSelect
          className="h-9 w-full min-w-0"
          aria-label={ariaLabel}
          value={value.kind}
          options={options}
          disabled={disabled}
          onChange={(kind) => {
            const option = options.find((entry) => entry.value === kind)
            if (option && !option.disabled && option.value !== value.kind) onChange(defaults[option.value])
          }}
        />
        {value.kind === 'vpn' && (
          <SimpleSelect
            className="h-9 w-full min-w-0"
            aria-label="Профиль или группа VPN"
            value={vpnValue}
            disabled={disabled || selected?.disabled}
            options={vpnOptions}
            onChange={(v) => {
              if (v === 'primary') onChange({ kind: 'vpn', target: { type: 'primary' } })
              else if (v.startsWith('group:')) onChange({ kind: 'vpn', target: { type: 'group', groupId: v.slice(6) } })
              else onChange({ kind: 'vpn', target: { type: 'profile', profileId: v.slice(8) } })
            }}
          />
        )}
        {value.kind === 'direct' && (
          <SimpleSelect
            className="h-9 w-full min-w-0"
            aria-label="Интернет-провайдер"
            value={value.uplinkId}
            disabled={disabled || selected?.disabled}
            options={(caps?.ispUplinks ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.iface }))}
            onChange={(v) => onChange({ kind: 'direct', uplinkId: v })}
          />
        )}
        {isDemo && value.kind === 'zapret' && (
          <SimpleSelect
            className="h-9 w-full min-w-0"
            aria-label="Конфигурация Zapret"
            value={value.strategyId}
            disabled={disabled || selected?.disabled}
            options={(strategies ?? []).map((s) => ({ value: s.id, label: s.name, hint: `${s.service === 'youtube' ? 'YouTube' : 'Discord'} · ${s.protos.join('+').toUpperCase()}`, disabled: s.readiness === 'needs-kernel-module' }))}
            onChange={(v) => onChange({ ...value, strategyId: v })}
          />
        )}
      </div>
      {isDemo && value.kind === 'zapret' && (
        <SimpleSelect
          className="h-9 w-full min-w-0"
          aria-label="Маршрут после обработки Zapret"
          value={value.exit}
          disabled={disabled || selected?.disabled}
          options={[
            { value: 'direct', label: 'Далее напрямую' },
            { value: 'keenetic', label: 'Далее по политике Keenetic' },
          ]}
          onChange={(v) => onChange({ ...value, exit: v as 'direct' | 'keenetic' })}
        />
      )}
      {selected && <p className={cn('text-[12px]', selected.disabled ? 'text-warn' : 'text-muted-foreground')}>{selected.hint}</p>}
    </div>
  )
}
