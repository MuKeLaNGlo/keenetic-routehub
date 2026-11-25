import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { AlertTriangle, CheckCircle2, Info, RefreshCw, WifiOff, XCircle, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Resource } from '@/state/resource'
import { TimeAgo } from './controls'
import { toneText, type Tone } from './status'

/* ───────────── page structure ───────────── */

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
      className={cn('mx-auto w-full px-4 pt-5 pb-40 md:px-8 md:pt-8', wide ? 'max-w-[1400px]' : 'max-w-[1120px]', className)}
    >
      {children}
    </motion.div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:mb-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1.5">
          {eyebrow && <div className="text-[12px] font-medium text-muted-foreground">{eyebrow}</div>}
          <h1 className="text-[26px] leading-[1.15] font-semibold md:text-[30px]">{title}</h1>
          {description && <p className="max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={cn('mb-8 scroll-mt-20 md:mb-10', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="space-y-0.5">
            {title && <h2 className="text-[16px] leading-tight font-semibold">{title}</h2>}
            {description && <p className="max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/** The card surface. `interactive` adds hover/press affordance. */
export function Panel({
  children,
  className,
  interactive,
  onClick,
  as: As = 'div',
  tone,
}: {
  children: ReactNode
  className?: string
  interactive?: boolean
  onClick?: () => void
  as?: 'div' | 'button' | 'a'
  tone?: Tone
}) {
  return (
    <As
      onClick={onClick}
      className={cn(
        'block rounded-xl bg-card text-left ring-1 ring-border',
        interactive && 'pressable w-full cursor-pointer hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
        tone === 'bad' && 'ring-bad/35',
        tone === 'warn' && 'ring-warn/35',
        tone === 'draft' && 'ring-draft/40',
        tone === 'ok' && 'ring-ok/30',
        className,
      )}
    >
      {children}
    </As>
  )
}

/** Rows inside a Panel, separated by hairlines. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-border', className)}>{children}</div>
}

export function KV({ items, className, cols = 1 }: { items: [ReactNode, ReactNode][]; className?: string; cols?: 1 | 2 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-2.5 text-[13px]', cols === 2 && 'sm:grid-cols-2', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[minmax(110px,40%)_1fr] items-baseline gap-3">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ───────────── callouts ───────────── */

const NOTICE: Record<Tone, { cls: string; icon: ReactNode }> = {
  ok: { cls: 'bg-ok/8 ring-ok/20 [&_[data-ico]]:text-ok', icon: <CheckCircle2 /> },
  warn: { cls: 'bg-warn/10 ring-warn/25 [&_[data-ico]]:text-warn', icon: <AlertTriangle /> },
  bad: { cls: 'bg-bad/8 ring-bad/25 [&_[data-ico]]:text-bad', icon: <XCircle /> },
  info: { cls: 'bg-info/8 ring-info/20 [&_[data-ico]]:text-info', icon: <Info /> },
  draft: { cls: 'bg-draft/8 ring-draft/25 [&_[data-ico]]:text-draft', icon: <Sparkles /> },
  muted: { cls: 'bg-muted/60 ring-border [&_[data-ico]]:text-muted-foreground', icon: <Info /> },
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
  icon,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
  icon?: ReactNode
}) {
  const m = NOTICE[tone]
  return (
    <div className={cn('flex flex-col gap-3 rounded-xl px-3.5 py-3 ring-1 ring-inset sm:flex-row sm:items-start', m.cls, className)}>
      <div className="flex min-w-0 flex-1 gap-2.5">
        <span data-ico className="mt-0.5 shrink-0 [&>svg]:size-4">
          {icon ?? m.icon}
        </span>
        <div className="min-w-0 space-y-0.5 text-[13px] leading-relaxed">
          {title && <div className="font-medium text-foreground">{title}</div>}
          {children && <div className="text-foreground/80">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 gap-2 pl-6.5 sm:pl-0">{action}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
      {icon && <div className="mb-1 text-muted-foreground [&>svg]:size-6">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="max-w-[48ch] text-[13px] text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/**
 * Renders a resource: skeleton on first load, the data otherwise. If a
 * refetch failed, keeps showing the last good data with a stale banner.
 */
export function Gate<T>({
  res,
  children,
  skeleton,
}: {
  res: Resource<T> & { refetch: () => Promise<void> }
  children: (data: T) => ReactNode
  skeleton?: ReactNode
}) {
  if (res.data === undefined) {
    if (res.error)
      return (
        <EmptyState
          icon={<WifiOff />}
          title="Не удалось загрузить данные"
          action={
            <Button variant="outline" size="sm" onClick={() => res.refetch()}>
              <RefreshCw /> Повторить
            </Button>
          }
        >
          {res.error}
        </EmptyState>
      )
    return <>{skeleton ?? <SkeletonBlock />}</>
  }
  return (
    <>
      {res.error && (
        <Notice
          tone="warn"
          className="mb-4"
          title="Показаны последние полученные данные"
          action={
            <Button variant="outline" size="sm" onClick={() => res.refetch()}>
              <RefreshCw /> Повторить
            </Button>
          }
        >
          {res.error}. Обновлено <TimeAgo at={res.updatedAt} />.
        </Notice>
      )}
      {children(res.data)}
    </>
  )
}

export function SkeletonBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-xl" style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  )
}

/** Small "label: value" stat used in summaries. */
export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={cn('text-[20px] leading-none font-semibold tracking-tight tabular', tone && toneText[tone])}>{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
