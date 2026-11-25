import { useId, useRef, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@/components/ui/button'

export function InlineSetting({ title, value, note, editable, open, onToggle, children }: {
  title: string
  value: ReactNode
  note?: ReactNode
  editable: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const id = useId()
  const form = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const expanded = editable && open

  function toggle() {
    const previous = document.activeElement
    onToggle()
    if (!expanded) {
      requestAnimationFrame(() => {
        if (document.activeElement === previous || document.activeElement === document.body) {
          form.current?.querySelector<HTMLElement>('input:not(:disabled), [role="combobox"]:not(:disabled), [role="switch"]:not(:disabled), button:not(:disabled)')?.focus()
        }
      })
    }
  }

  return (
    <section aria-labelledby={`${id}-label`} className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-label`} className="text-[13px] leading-snug font-medium">{title}</h3>
          {!expanded && <div className="mt-1 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{value}</div>}
        </div>
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-9"
            onClick={toggle}
            aria-label={`${expanded ? 'Готово' : 'Изменить'}: ${title}`}
            aria-expanded={expanded}
            aria-controls={expanded ? `${id}-editor` : undefined}
          >
            {!expanded && <Pencil aria-hidden="true" />}{expanded ? 'Готово' : 'Изменить'}
          </Button>
        )}
      </div>
      {note && <div className="mt-1 text-xs leading-relaxed [overflow-wrap:anywhere]">{note}</div>}
      {editable && (
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              id={`${id}-editor`}
              ref={form}
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.16, ease: 'easeOut' }}
              className="min-w-0 overflow-clip"
            >
              <div className="grid min-w-0 gap-1.5 pt-1.5 pb-0.5">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </section>
  )
}
