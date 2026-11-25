import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ProbeResult, ServiceState, TaskState } from '@/api/contract'
import { timeAgo } from '@/lib/format'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Loader2,
  RotateCcw,
  Hand,
  XCircle,
  PauseCircle,
  Ghost,
} from 'lucide-react'

/** Semantic tone. Colour = meaning, nothing else (DESIGN.md §2). */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'draft' | 'muted'

export const toneText: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
  draft: 'text-draft',
  muted: 'text-muted-foreground',
}
export const toneBg: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  info: 'bg-info',
  draft: 'bg-draft',
  muted: 'bg-muted-foreground/50',
}
export const toneSoft: Record<Tone, string> = {
  ok: 'bg-ok/12 text-ok ring-ok/20',
  warn: 'bg-warn/14 text-warn ring-warn/25',
  bad: 'bg-bad/12 text-bad ring-bad/25',
  info: 'bg-info/12 text-info ring-info/20',
  draft: 'bg-draft/12 text-draft ring-draft/25',
  muted: 'bg-muted text-muted-foreground ring-border',
}

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-50', toneBg[tone])} style={{ animationDuration: '2s' }} />}
      <span className={cn('relative inline-flex size-2 rounded-full', toneBg[tone])} />
    </span>
  )
}

export function StatusBadge({
  tone,
  icon,
  children,
  className,
  dashed,
}: {
  tone: Tone
  icon?: ReactNode
  children: ReactNode
  className?: string
  /** For unknown/untested states: dashed outline, never looks like success. */
  dashed?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset [&>svg]:size-3',
        toneSoft[tone],
        dashed && 'bg-transparent ring-0 outline-1 outline-dashed outline-current/40 -outline-offset-1',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/* ───────────── probe results ───────────── */

const PROBE: Record<ProbeResult['state'], { tone: Tone; label: string; icon: ReactNode; dashed?: boolean }> = {
  untested: { tone: 'muted', label: 'Не проверен', icon: <CircleDashed />, dashed: true },
  pending: { tone: 'muted', label: 'Ожидает', icon: <Clock /> },
  probing: { tone: 'info', label: 'Проверяется', icon: <Loader2 className="animate-spin" /> },
  ok: { tone: 'ok', label: 'Доступен', icon: <CheckCircle2 /> },
  degraded: { tone: 'warn', label: 'С ухудшением', icon: <AlertTriangle /> },
  down: { tone: 'bad', label: 'Недоступен', icon: <XCircle /> },
  stale: { tone: 'warn', label: 'Устарели', icon: <Clock />, dashed: true },
  disabled: { tone: 'muted', label: 'Отключён', icon: <PauseCircle /> },
  incompatible: { tone: 'bad', label: 'Несовместим', icon: <Ban /> },
  missing: { tone: 'warn', label: 'Исчез из подписки', icon: <Ghost /> },
}

export const probeMeta = (s: ProbeResult['state']) => PROBE[s]

const METHOD: Record<ProbeResult['method'], string> = { https: 'HTTPS', tcp: 'TCP', icmp: 'ICMP', handshake: 'рукопожатие' }

/** Latency ("ping") with its kind, spread, loss and freshness — never a bare number. */
export function ProbeBadge({ probe, compact }: { probe: ProbeResult | undefined; compact?: boolean }) {
  if (!probe) return <StatusBadge tone="muted" dashed icon={<CircleDashed />}>Нет данных</StatusBadge>
  const m = PROBE[probe.state]
  const hasNum = probe.medianMs != null && ['ok', 'degraded', 'stale'].includes(probe.state)
  return (
    <span className="inline-flex items-center gap-2">
      {hasNum ? (
        <span className={cn('tabular inline-flex items-baseline gap-1 font-medium', toneText[m.tone])}>
          <StatusDot tone={m.tone} className="self-center" />
          {probe.medianMs}
          <span className="text-[11px] font-normal text-muted-foreground">мс</span>
        </span>
      ) : (
        <StatusBadge tone={m.tone} icon={m.icon} dashed={m.dashed}>
          {m.label}
        </StatusBadge>
      )}
      {!compact && (
        <span className="text-[11.5px] text-muted-foreground">
          {METHOD[probe.method]}
          {probe.jitterMs != null && hasNum && ` · ±${probe.jitterMs}`}
          {probe.lossPct ? ` · потери ${probe.lossPct}%` : ''}
          {probe.measuredAt && ` · ${timeAgo(probe.measuredAt)}`}
        </span>
      )}
    </span>
  )
}

/* ───────────── services / tasks ───────────── */

export const SERVICE: Record<ServiceState, { tone: Tone; label: string }> = {
  running: { tone: 'ok', label: 'Работает' },
  degraded: { tone: 'warn', label: 'С ухудшением' },
  stopped: { tone: 'muted', label: 'Остановлен' },
  failed: { tone: 'bad', label: 'Сбой' },
  'not-installed': { tone: 'muted', label: 'Не установлен' },
}

export const TASK: Record<TaskState, { tone: Tone; label: string; icon: ReactNode }> = {
  pending: { tone: 'muted', label: 'Ожидает', icon: <Clock /> },
  running: { tone: 'info', label: 'Выполняется', icon: <Loader2 className="animate-spin" /> },
  done: { tone: 'ok', label: 'Завершено', icon: <CheckCircle2 /> },
  cancelled: { tone: 'muted', label: 'Отменено', icon: <CircleSlash /> },
  error: { tone: 'bad', label: 'Ошибка', icon: <XCircle /> },
  restored: { tone: 'warn', label: 'Восстановлена прежняя конфигурация', icon: <RotateCcw /> },
  intervention: { tone: 'bad', label: 'Требуется вмешательство', icon: <Hand /> },
}

export function TaskStateBadge({ state }: { state: TaskState }) {
  const m = TASK[state]
  return (
    <StatusBadge tone={m.tone} icon={m.icon}>
      {m.label}
    </StatusBadge>
  )
}
