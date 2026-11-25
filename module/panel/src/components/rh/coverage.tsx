import { cn } from '@/lib/utils'
import type { Availability, Coverage as CoverageT, CoverageCell, CoverageState } from '@/api/contract'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Check, Minus, X, AlertTriangle, CircleDashed, Info, Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCanWrite } from '@/state/resource'

const CELL: Record<CoverageState, { label: string; cls: string; icon: ReactNode }> = {
  verified: { label: 'Проверено трафиком', cls: 'bg-ok/15 text-ok ring-ok/25', icon: <Check strokeWidth={3} /> },
  configured: { label: 'Настроено, не подтверждено трафиком', cls: 'bg-info/10 text-info ring-info/25', icon: <Check strokeWidth={2} className="opacity-70" /> },
  partial: { label: 'Частично', cls: 'bg-warn/15 text-warn ring-warn/30', icon: <AlertTriangle /> },
  untested: { label: 'Не испытано', cls: 'hatch text-muted-foreground ring-border', icon: <CircleDashed /> },
  unsupported: { label: 'Не поддерживается', cls: 'bg-muted text-muted-foreground/70 ring-border', icon: <Minus /> },
  failed: { label: 'Не работает', cls: 'bg-bad/12 text-bad ring-bad/25', icon: <X strokeWidth={3} /> },
}

const ORDER: { key: keyof CoverageT; fam: string; proto: string }[] = [
  { key: 'v4tcp', fam: 'IPv4', proto: 'TCP' },
  { key: 'v4udp', fam: 'IPv4', proto: 'UDP' },
  { key: 'v6tcp', fam: 'IPv6', proto: 'TCP' },
  { key: 'v6udp', fam: 'IPv6', proto: 'UDP' },
]

export const coverageLabel = (s: CoverageState) => CELL[s].label

function Cell({ c, fam, proto, size }: { c: CoverageCell; fam: string; proto: string; size: 'sm' | 'md' }) {
  const m = CELL[c.state]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex items-center justify-center gap-1 rounded-md font-medium ring-1 ring-inset [&>svg]:size-3',
              size === 'sm' ? 'h-5 px-1.5 text-[10.5px]' : 'h-6 px-2 text-[11.5px]',
              m.cls,
            )}
          />
        }
      >
        {m.icon}
        <span className="tabular">
          {fam === 'IPv4' ? 'v4' : 'v6'} {proto}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 flex-col items-start gap-0.5">
        <span className="font-medium">
          {fam} {proto}: {m.label}
        </span>
        {c.note && <span className="opacity-80">{c.note}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** IPv4/IPv6 × TCP/UDP coverage, one consistent rendering everywhere. */
export function Coverage({ coverage, size = 'sm', className }: { coverage: CoverageT; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      {ORDER.map((o) => (
        <Cell key={o.key} c={coverage[o.key]} fam={o.fam} proto={o.proto} size={size} />
      ))}
    </span>
  )
}

export function CoverageLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-muted-foreground">
      {(['verified', 'configured', 'partial', 'untested', 'unsupported', 'failed'] as CoverageState[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className={cn('inline-flex size-4 items-center justify-center rounded ring-1 ring-inset [&>svg]:size-2.5', CELL[s].cls)}>{CELL[s].icon}</span>
          {CELL[s].label}
        </span>
      ))}
    </div>
  )
}

/** Inline explanation for something this install cannot do. Never a silent disable. */
export function CapabilityNote({ availability, className, children }: { availability: Availability; className?: string; children?: ReactNode }) {
  if (availability.available) return null
  return (
    <div className={cn('flex gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground', className)}>
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <div className="space-y-0.5">
        {children && <div className="font-medium text-foreground">{children}</div>}
        <div>{availability.reason}</div>
        {availability.remedy && <div className="text-foreground/80">{availability.remedy}</div>}
      </div>
    </div>
  )
}

/** Read-only sessions see why a control is locked. */
export function ReadOnlyHint({ className }: { className?: string }) {
  const can = useCanWrite()
  if (can) return null
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11.5px] text-muted-foreground', className)}>
      <Lock className="size-3" /> Только чтение
    </span>
  )
}
