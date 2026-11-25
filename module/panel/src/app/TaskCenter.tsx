import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ListChecks, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTasks } from '@/state/resource'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TaskCard } from '@/components/rh/task'
import { EmptyState } from '@/components/rh/layout'
import { cn } from '@/lib/utils'
import type { Task } from '@/api/contract'
import { TASK } from '@/components/rh/status'

/**
 * Task centre: every long operation (apply, refresh, update, checks) is a
 * task with steps that survives navigation. Finished tasks toast once.
 */
export function TaskCenter() {
  const { data: tasks } = useTasks()
  const [open, setOpen] = useState(false)
  const running = tasks?.filter((t) => t.state === 'running' || t.state === 'pending') ?? []
  const recent = tasks?.slice(0, 12) ?? []
  useTaskToasts(tasks)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'pressable relative inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] ring-1 ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          running.length ? 'bg-info/10 text-info ring-info/30' : 'text-muted-foreground ring-border hover:text-foreground',
        )}
        aria-label="Задачи"
      >
        {running.length ? <Loader2 className="size-3.5 animate-spin" /> : <ListChecks className="size-3.5" />}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={running.length} initial={{ y: 6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -6, opacity: 0 }} className="tabular hidden sm:inline">
            {running.length ? `${running.length} в работе` : 'Задачи'}
          </motion.span>
        </AnimatePresence>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(420px,calc(100vw-1.5rem))] gap-0 p-0">
        <div className="border-b px-4 py-3 text-[14px] font-semibold">Задачи</div>
        <div className="max-h-[min(70dvh,560px)] space-y-2.5 overflow-y-auto p-3">
          {recent.length === 0 ? (
            <EmptyState title="Задач пока не было">Применения, обновления и проверки появятся здесь с ходом выполнения.</EmptyState>
          ) : (
            recent.map((t) => <TaskCard key={t.id} task={t} showSteps={t.state === 'running' || t.state === 'pending' || t.state === 'error' || t.state === 'restored'} />)
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function useTaskToasts(tasks: Task[] | undefined) {
  const seen = useRef<Map<string, Task['state']> | null>(null)
  useEffect(() => {
    if (!tasks) return
    if (!seen.current) {
      seen.current = new Map(tasks.map((t) => [t.id, t.state]))
      return
    }
    for (const t of tasks) {
      const prev = seen.current.get(t.id)
      seen.current.set(t.id, t.state)
      if (!prev || prev === t.state) continue
      if (prev !== 'running' && prev !== 'pending') continue
      const m = TASK[t.state]
      const desc = t.summary ?? t.error
      if (t.state === 'done') toast.success(t.title, { description: desc })
      else if (t.state === 'restored') toast.warning(`${t.title}: ${m.label.toLowerCase()}`, { description: desc })
      else if (t.state === 'error' || t.state === 'intervention') toast.error(`${t.title}: ${m.label.toLowerCase()}`, { description: desc })
      else if (t.state === 'cancelled') toast(`${t.title}: отменено`)
    }
  }, [tasks])
}
