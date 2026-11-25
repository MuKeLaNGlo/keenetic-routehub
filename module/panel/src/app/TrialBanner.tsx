import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { CheckCircle2, FlaskConical, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/api'
import { useRuntime } from '@/state/resource'
import { useCountdown, WriteButton } from '@/components/rh/controls'
import { Button } from '@/components/ui/button'
import { fmtClock } from './ApplyFlow'

/**
 * Persistent banner while a trial apply is waiting for confirmation. Visible on
 * every screen and in every tab (the trial lives on the router, not in a tab).
 */
export function TrialBanner() {
  const { data: rt } = useRuntime()
  const trial = rt?.trial
  const left = useCountdown(trial?.expiresAt)
  const [busy, setBusy] = useState<'ok' | 'back' | null>(null)
  const urgent = left <= 20

  return (
    <AnimatePresence initial={false}>
      {trial && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
          className="sticky top-13 z-20 overflow-hidden"
        >
          <div className="relative border-b border-draft/25 bg-[color-mix(in_oklch,var(--draft)_9%,var(--background))]">
            <motion.div
              className="absolute bottom-0 left-0 h-0.5 bg-draft"
              initial={false}
              animate={{ width: `${(left / trial.totalSec) * 100}%` }}
              transition={{ duration: 0.25, ease: 'linear' }}
            />
            <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 md:px-8">
              <FlaskConical className="size-4 shrink-0 text-draft" />
              <div className="min-w-0 flex-1 text-[13px] leading-snug">
                <span className="font-medium">Пробное применение r{trial.revision} на «{trial.scope}».</span>{' '}
                <span className="text-muted-foreground">Без подтверждения роутер вернёт прежнюю конфигурацию через</span>{' '}
                <span className={`tabular font-semibold ${urgent ? 'text-bad' : 'text-draft'}`}>{fmtClock(left)}</span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy('back')
                    await api.rollbackTrial(trial.taskId)
                    setBusy(null)
                  }}
                >
                  {busy === 'back' ? <Loader2 className="animate-spin" /> : <RotateCcw />} Вернуть
                </Button>
                <WriteButton
                  size="sm"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy('ok')
                    try {
                      await api.confirmTrial(trial.taskId)
                      toast.success(`r${trial.revision} подтверждена и действует`)
                    } catch (e) {
                      toast.error((e as Error).message)
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  {busy === 'ok' ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Подтвердить
                </WriteButton>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
