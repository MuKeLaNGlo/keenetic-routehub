import { AnimatePresence, motion } from 'motion/react'
import { Check, Loader2, Minus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Task, TaskStep } from '@/api/contract'
import { TaskStateBadge } from './status'
import { TimeAgo } from './controls'
import { Button } from '@/components/ui/button'
import { api } from '@/api'

const STEP_ICON: Record<TaskStep['state'], React.ReactNode> = {
  pending: <span className="size-1.5 rounded-full bg-muted-foreground/40" />,
  running: <Loader2 className="size-3.5 animate-spin text-info" />,
  done: <Check className="size-3.5 text-ok" strokeWidth={3} />,
  skipped: <Minus className="size-3.5 text-muted-foreground" />,
  error: <X className="size-3.5 text-bad" strokeWidth={3} />,
}

/** Vertical step list of a long-running operation. */
export function TaskSteps({ steps, className }: { steps: TaskStep[]; className?: string }) {
  return (
    <ol className={cn('relative space-y-0', className)}>
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
          {i < steps.length - 1 && <span className={cn('absolute top-5 bottom-0 left-[9.5px] w-px', s.state === 'done' ? 'bg-ok/40' : 'bg-border')} />}
          <span
            className={cn(
              'relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
              s.state === 'done' && 'bg-ok/12 ring-ok/30',
              s.state === 'error' && 'bg-bad/12 ring-bad/30',
              s.state === 'running' && 'bg-info/12 ring-info/30',
              (s.state === 'pending' || s.state === 'skipped') && 'bg-background ring-border',
            )}
          >
            {STEP_ICON[s.state]}
          </span>
          <div className="min-w-0 pt-px">
            <div className={cn('text-[13px] leading-snug', s.state === 'pending' || s.state === 'skipped' ? 'text-muted-foreground' : 'text-foreground', s.state === 'error' && 'font-medium')}>
              {s.label}
              {s.state === 'skipped' && <span className="text-muted-foreground"> · не выполнялось</span>}
            </div>
            <AnimatePresence initial={false}>
              {s.detail && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className={cn('text-[12px] leading-relaxed', s.state === 'error' ? 'text-bad' : 'text-muted-foreground')}
                >
                  {s.detail}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Compact card for a task: title, state, steps, summary, cancel. */
export function TaskCard({ task, showSteps = true, className }: { task: Task; showSteps?: boolean; className?: string }) {
  return (
    <div className={cn('space-y-3 rounded-xl bg-card p-4 ring-1 ring-border', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{task.title}</div>
          <div className="text-[12px] text-muted-foreground">
            {task.scope} · начато <TimeAgo at={task.startedAt} />
          </div>
        </div>
        <TaskStateBadge state={task.state} />
      </div>
      {showSteps && <TaskSteps steps={task.steps} />}
      {(task.summary || task.error) && (
        <div className={cn('rounded-lg px-3 py-2 text-[12.5px]', task.state === 'done' ? 'bg-ok/8' : task.state === 'restored' ? 'bg-warn/10' : task.state === 'error' ? 'bg-bad/8' : 'bg-muted')}>
          {task.summary ?? task.error}
        </div>
      )}
      {task.cancellable && task.state === 'running' && (
        <Button variant="outline" size="sm" onClick={() => api.cancelTask(task.id)}>
          Отменить
        </Button>
      )}
    </div>
  )
}
