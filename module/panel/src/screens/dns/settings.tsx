import { useState } from 'react'
import { X } from 'lucide-react'
import type { DnsPolicy } from '@/api/contract'
import { isDemo } from '@/api/mode'
import { Input } from '@/components/ui/input'
import { SavingSwitch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Mono, SimpleSelect } from '@/components/rh/controls'
import { Rows } from '@/components/rh/layout'
import { useDraft } from '@/state/draft'
import { useCanWrite, useCaps } from '@/state/resource'
import { cn } from '@/lib/utils'

/** A boolean policy field with the line that explains what it changes. */
export function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  disabledReason,
  compact = false,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  disabledReason?: string
  compact?: boolean
  onChange: (on: boolean) => Promise<boolean>
}) {
  const description = disabled && disabledReason ? disabledReason : hint
  return (
    <div className={cn('flex items-start justify-between gap-4 bg-card', compact ? 'px-3.5 py-2.5' : 'px-4 py-3')}>
      <div className="min-w-0 space-y-0.5">
        <div className="text-[13px] font-medium">{label}</div>
        {description && <p className="text-[12px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <SavingSwitch checked={checked} disabled={disabled} aria-label={label} onSave={onChange} />
    </div>
  )
}

/** Editable list of strings (blocklists, exceptions) with chips and one add field. */
export function ListEditor({
  label,
  hint,
  items,
  placeholder,
  disabled,
  onAdd,
  onRemove,
  compact = false,
}: {
  label: string
  hint?: string
  items: string[]
  placeholder: string
  disabled: boolean
  onAdd: (value: string) => void
  onRemove: (value: string) => void
  compact?: boolean
}) {
  const [value, setValue] = useState('')
  const add = () => {
    const v = value.trim()
    if (!v) return
    onAdd(v)
    setValue('')
  }
  return (
    <div className={cn('space-y-2 bg-card', compact ? 'px-3.5 py-2.5' : 'px-4 py-3')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="tabular text-[11.5px] text-muted-foreground">{items.length ? `${items.length} в списке` : 'список пуст'}</span>
      </div>
      {hint && <p className="text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className={compact ? 'min-w-0 max-w-full' : undefined}>
              <span className={cn('inline-flex items-center gap-1 rounded-full bg-muted pr-1 pl-3', compact ? 'min-h-7 max-w-full' : 'h-7')}>
                <Mono className={cn('text-[12px]', compact && 'min-w-0 [overflow-wrap:anywhere]')}>{item}</Mono>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onRemove(item)}
                  aria-label={`Убрать «${item}»`}
                  className={cn('pressable inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40', compact && 'shrink-0')}
                >
                  <X className="size-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} disabled={disabled} aria-label={`Добавить в «${label}»`} className="h-8 max-w-72" />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !value.trim()}>
          Добавить
        </Button>
      </form>
    </div>
  )
}

export function PolicySettings({ policy, compact = false, disabled = false }: { policy: DnsPolicy; compact?: boolean; disabled?: boolean }) {
  const { edit } = useDraft()
  const canWrite = useCanWrite()
  const { data: caps } = useCaps()
  const editable = canWrite && policy.managed && !disabled
  const dnsLAN = caps?.features?.dnsLAN

  const mutate = (label: string, update: (target: DnsPolicy) => void) =>
    edit(`DNS «${policy.name}»: ${label}`, (draft) => {
      const target = draft.dns.find(({ id }) => id === policy.id)
      if (target) update(target)
    })

  return (
    <Rows>
      {isDemo && <ToggleRow
        compact={compact}
        label="Резерв может идти напрямую"
        hint={compact ? 'Разрешает прямой маршрут резерва при основном DNS через VPN.' : 'Когда основной идёт через VPN, резервный разрешено выпускать напрямую — он продолжит работать при отказе VPN.'}
        disabled={!editable || !policy.fallback}
        disabledReason={!policy.fallback ? (compact ? 'Резервный сервер не настроен.' : 'Резервный сервер не настроен — переключать нечего.') : undefined}
        checked={policy.fallbackDirectAllowed}
        onChange={(on) => mutate(on ? 'резерв разрешён напрямую' : 'резерв только через VPN', (target) => { target.fallbackDirectAllowed = on })}
      />}
      {!isDemo && <ToggleRow
        compact={compact}
        label="Подключить домашнюю сеть"
        hint="Использовать резолвер RouteHub для DNS-запросов клиентов в управляемой сети."
        disabled={!editable || !dnsLAN?.available}
        disabledReason={dnsLAN?.reason}
        checked={policy.lan ?? false}
        onChange={(on) => mutate(on ? 'резолвер подключён к LAN' : 'резолвер отключён от LAN', (target) => { target.lan = on })}
      />}
      <ToggleRow
        compact={compact}
        label="Кэш DNS"
        hint={compact ? undefined : 'Повторные запросы берутся из кэша роутера. Отключение сбрасывает кэш и увеличивает время ответа.'}
        disabled={!editable}
        checked={policy.cache}
        onChange={(on) => mutate(on ? 'кэш включён' : 'кэш выключен', (target) => { target.cache = on })}
      />
      {compact && (
        <ToggleRow
          compact
          label="Блокировка рекламы через DNS"
          hint="Фильтрация доменов по спискам с учётом исключений."
          checked={policy.filteringEnabled ?? policy.blocklists.length > 0}
          disabled={!editable}
          onChange={(on) => mutate(on ? 'DNS-фильтрация включена' : 'DNS-фильтрация выключена', (target) => { target.filteringEnabled = on })}
        />
      )}
      {isDemo ? <ListEditor
        compact={compact}
        label="Списки блокировок"
        hint={compact ? undefined : 'Источники, по которым имена блокируются на уровне DNS. Список применяется к этой сети.'}
        items={policy.blocklists}
        placeholder="Название списка"
        disabled={!editable}
        onAdd={(value) => mutate(`добавлен список «${value}»`, (target) => {
          if (!target.blocklists.includes(value)) target.blocklists.push(value)
        })}
        onRemove={(value) => mutate(`удалён список «${value}»`, (target) => { target.blocklists = target.blocklists.filter((item) => item !== value) })}
      /> : <div className={cn('space-y-2 bg-card', compact ? 'px-3.5 py-2.5' : 'px-4 py-3')}>
        <div className="text-[13px] font-medium">Список блокировки</div>
        <SimpleSelect
          aria-label="Список блокировки"
          value={policy.blocklists[0] ?? 'normal'}
          disabled={!editable}
          options={[
            { value: 'normal', label: 'HaGeZi Multi Normal' },
            { value: 'pro', label: 'HaGeZi Multi Pro mini' },
            { value: 'proplus', label: 'HaGeZi Multi Pro++ mini' },
          ]}
          onChange={(value) => mutate('выбран список блокировок', (target) => { target.blocklists = [value] })}
        />
      </div>}
      <ListEditor
        compact={compact}
        label="Исключения"
        hint={compact ? undefined : 'Имена, которые не блокируются и не перехватываются даже при включённых списках. Нужны для банков и госуслуг — иначе DNS блокирует сам себя.'}
        items={policy.exceptions}
        placeholder="example.ru"
        disabled={!editable}
        onAdd={(value) => mutate(`добавлено исключение «${value}»`, (target) => {
          if (!target.exceptions.includes(value)) target.exceptions.push(value)
        })}
        onRemove={(value) => mutate(`удалено исключение «${value}»`, (target) => { target.exceptions = target.exceptions.filter((item) => item !== value) })}
      />
    </Rows>
  )
}
