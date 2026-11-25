import { Check } from 'lucide-react'
import type { Segment, ZapretService } from '@/api/contract'
import { cn } from '@/lib/utils'
import { scopeLabel } from './meta'

/**
 * Which networks the service override applies to. An empty list means every
 * managed segment; excluded segments are never offered at all.
 */
export function ScopeBlock({
  service,
  segments,
  managedIds,
  disabled,
  onChange,
  compact = false,
}: {
  service: ZapretService
  segments: Segment[]
  /** Ids of segments RouteHub manages (from the config's segment policies). */
  managedIds: string[]
  disabled: boolean
  onChange: (ids: string[]) => void
  compact?: boolean
}) {
  const known = segments.filter((s) => s.state !== 'removed')
  const managed = known.filter((s) => managedIds.includes(s.id))
  const explicit = service.segmentIds.length > 0
  const dangling = service.segmentIds.filter((id) => !managed.some((s) => s.id === id))

  function toggle(id: string) {
    onChange(service.segmentIds.includes(id) ? service.segmentIds.filter((x) => x !== id) : [...service.segmentIds, id])
  }

  return (
    <div className={cn('space-y-2.5 py-3', compact ? 'px-3' : 'px-4')}>
      {!compact && <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium">Где применяется</span>
        <span className="text-[12px] text-muted-foreground">{scopeLabel(segments, service.segmentIds)}</span>
      </div>}

      <div className="flex flex-wrap gap-1.5">
        <Chip compact={compact} active={!explicit} disabled={disabled} onClick={() => onChange([])}>
          Все управляемые
        </Chip>
        {managed.map((s) => (
          <Chip key={s.id} compact={compact} active={explicit && service.segmentIds.includes(s.id)} disabled={disabled} onClick={() => toggle(s.id)}>
            {s.name}
          </Chip>
        ))}
      </div>

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {compact
          ? explicit
            ? 'Если снять все отметки, Zapret будет действовать во всех управляемых сетях.'
            : 'Обработка применяется ко всем сетям под управлением RouteHub.'
          : explicit
            ? 'В остальных сетях сервис не обрабатывается Zapret и идёт по своей обычной политике.'
            : 'Во всех сетях, которыми управляет RouteHub. Исключённые сети не затрагиваются.'}
      </p>

      {dangling.length > 0 && (
        <p className="text-[12px] text-warn">
          В настройке остались сети, которых нет среди управляемых: {dangling.join(', ')}. Они не применяются.
        </p>
      )}
    </div>
  )
}

function Chip({ active, disabled, onClick, children, compact }: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
  compact: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'pressable inline-flex items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
        compact ? 'h-9' : 'h-7',
        active ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent',
      )}
    >
      {active && <Check className="size-3" strokeWidth={3} />}
      {children}
    </button>
  )
}
