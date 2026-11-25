import { useId, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/state/resource'
import { timeAgo, dateTime } from '@/lib/format'
import { useEffect, useState } from 'react'

/* ───────────── Segmented control with a sliding thumb ───────────── */

export interface SegOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  hint?: string
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: SegOption<T>[]
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
}) {
  const id = useId()
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex rounded-lg bg-muted p-0.5', className)}>
      {options.map((o) => {
        const active = o.value === value
        const btn = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'pressable relative inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40 [&_svg]:size-3.5',
              size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-7 px-3 text-[13px]',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-md bg-background shadow-sm ring-1 ring-border dark:bg-accent"
                transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
          </button>
        )
        return o.hint ? (
          <Tooltip key={o.value}>
            <TooltipTrigger render={<span className="inline-flex" />}>{btn}</TooltipTrigger>
            <TooltipContent>{o.hint}</TooltipContent>
          </Tooltip>
        ) : (
          btn
        )
      })}
    </div>
  )
}

/* ───────────── Simple select (value → label handled) ───────────── */

export interface SelectOption {
  value: string
  label: ReactNode
  /** Plain text label for the trigger when `label` is a node. */
  text?: string
  disabled?: boolean
  hint?: string
  group?: string
}

export function SimpleSelect({
  value,
  onChange,
  options,
  id,
  placeholder = 'Выберите…',
  className,
  disabled,
  size,
  'aria-label': ariaLabel,
}: {
  value: string | null
  onChange: (v: string) => void
  options: SelectOption[]
  id?: string
  placeholder?: string
  className?: string
  disabled?: boolean
  size?: 'sm' | 'default'
  'aria-label'?: string
}) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.text ?? o.label]))
  const groups = [...new Set(options.map((o) => o.group ?? ''))]
  return (
    <Select value={value} onValueChange={(v) => v != null && onChange(v as string)} items={items} disabled={disabled}>
      <SelectTrigger id={id} className={cn('min-w-40', className)} size={size} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="w-auto min-w-[min(var(--anchor-width),var(--available-width))] max-w-(--available-width)">
        {groups.map((g) => (
          <SelectGroup key={g || '_'}>
            {g && <SelectLabel>{g}</SelectLabel>}
            {options
              .filter((o) => (o.group ?? '') === g)
              .map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal [overflow-wrap:anywhere]">
                    <span>{o.label}</span>
                    {o.hint && <span className="text-[11.5px] text-muted-foreground">{o.hint}</span>}
                  </span>
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

/* ───────────── write guard ───────────── */

/**
 * A button that performs a write. In read-only sessions it stays visible
 * but locked, with the reason on hover — never silently missing.
 */
export function WriteButton({ children, disabled, reason, ...props }: React.ComponentProps<typeof Button> & { reason?: string }) {
  const can = useCanWrite()
  const locked = !can || !!disabled
  const why = !can ? 'Доступ только на чтение: этот ключ панели не может вносить изменения' : reason
  const btn = (
    <Button {...props} disabled={locked}>
      {children}
    </Button>
  )
  if (!locked || !why) return btn
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>{btn}</TooltipTrigger>
      <TooltipContent className="max-w-64">{why}</TooltipContent>
    </Tooltip>
  )
}

/* ───────────── time ───────────── */

/** Relative time that stays fresh; absolute time on hover. */
export function TimeAgo({ at, className, prefix }: { at: string | number | null | undefined; className?: string; prefix?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000)
    return () => clearInterval(t)
  }, [])
  if (at == null) return <span className={className}>—</span>
  return (
    <time className={cn('tabular', className)} dateTime={new Date(at).toISOString()} title={dateTime(at)}>
      {prefix}
      {timeAgo(at)}
    </time>
  )
}

/** Countdown to an ISO time (seconds). */
export function useCountdown(until: string | null | undefined): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!until) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [until])
  return until ? Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000)) : 0
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-[11px] text-muted-foreground">{children}</kbd>
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12.5px] tracking-tight', className)}>{children}</span>
}
