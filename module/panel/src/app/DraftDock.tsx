import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, GitBranch, Trash2, AlertTriangle } from 'lucide-react'
import { useDraft, draftStore } from '@/state/draft'
import { setQuery, useRoute } from '@/state/router'
import { useCanWrite, useCaps } from '@/state/resource'
import { Button } from '@/components/ui/button'
import { count } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

export const openReview = () => setQuery({ review: '1' })

/**
 * Recovery entry for a draft already stored by an earlier version.
 */
export function DraftDock() {
  const { dirty, changes, outdated, server, base } = useDraft()
  const route = useRoute()
  const canWrite = useCanWrite()
  // Unknown access (still loading) is not "read-only": don't claim it.
  const { data: caps } = useCaps()
  const [confirm, setConfirm] = useState(false)
  const reviewing = route.query.get('review') === '1'

  return (
    <>
      <AnimatePresence>
        {dirty && !reviewing && (
          <motion.div
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
            className="pointer-events-none fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 md:bottom-5 md:left-[232px]"
          >
            <div className={cn('material-strong shadow-float pointer-events-auto flex w-full max-w-[620px] items-center gap-3 rounded-2xl py-2 pr-2 pl-3.5 ring-1', outdated ? 'ring-warn/40' : 'ring-draft/30')}>
              <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-draft/14 text-draft">
                <GitBranch className="size-4" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13.5px] font-medium">
                  Старый черновик · {count(changes.length, ['изменение', 'изменения', 'изменений'])}
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {outdated ? (
                    <span className="inline-flex items-center gap-1 text-warn">
                      <AlertTriangle className="size-3" /> На роутере уже r{server?.revision} — черновик от r{base?.revision}
                    </span>
                  ) : canWrite || !caps ? (
                    'Ещё не действует. Сохраняется в этой вкладке.'
                  ) : (
                    'Только чтение: черновик можно изучить, но не применить'
                  )}
                </div>
              </div>
              <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Отменить черновик" onClick={() => setConfirm(true)}>
                <Trash2 />
              </Button>
              <Button size="lg" className="pressable rounded-xl px-3.5" onClick={openReview}>
                Просмотреть <ArrowRight />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить черновик?</AlertDialogTitle>
            <AlertDialogDescription>
              {count(changes.length, ['изменение будет', 'изменения будут', 'изменений будут'])} отброшены. На роутере ничего не меняется — он продолжит работать с r{server?.revision}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Оставить</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => draftStore.discard()}>
              Отменить черновик
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
