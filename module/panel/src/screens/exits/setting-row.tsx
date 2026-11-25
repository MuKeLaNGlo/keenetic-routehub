import { useId, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { WriteButton } from '@/components/rh/controls'

export function ExitSettingRow({
  label,
  value,
  open,
  onToggle,
  children,
}: {
  label: string
  value: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const id = useId()
  const reduceMotion = useReducedMotion()
  return (
    <div className="min-w-0">
      <div className="flex min-h-12 items-center justify-between gap-2.5 px-3 py-2">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <div id={`${id}-label`} className="text-[13px] font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{value}</div>
        </div>
        <div className="shrink-0">
          <WriteButton
            type="button"
            size="sm"
            variant={open ? 'secondary' : 'ghost'}
            aria-label={`${open ? 'Готово' : 'Изменить'} — ${label}`}
            aria-expanded={open}
            aria-controls={id}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true })
              onToggle()
            }}
          >
            {open ? 'Готово' : 'Изменить'}
          </WriteButton>
        </div>
      </div>
      <div id={id} hidden={!open} role="group" aria-labelledby={`${id}-label`}>
        {open && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}
            className="mx-3 mb-3 min-w-0 rounded-lg border border-border bg-surface-2/45 px-3 py-2.5 [&_section]:mb-0"
          >
            {children}
          </motion.div>
        )}
      </div>
    </div>
  )
}
