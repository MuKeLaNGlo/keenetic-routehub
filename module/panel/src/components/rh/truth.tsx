import { cn } from '@/lib/utils'
import { motion } from 'motion/react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { EntityChange } from '@/api/contract'

type StepState = 'done' | 'pending' | 'fail' | 'partial' | 'na' | 'draft'

export interface TruthLadderProps {
  /** Pending draft edits for this item. */
  draft: boolean
  /** Saved in config revision N. */
  savedRevision: number | null
  /** Daemon has loaded that revision. */
  active: boolean | 'na'
  /** Confirmed by real traffic. */
  verified: 'ok' | 'fail' | 'partial' | 'untested' | 'na'
  notes?: Partial<Record<'draft' | 'saved' | 'active' | 'verified', string>>
  className?: string
  size?: 'sm' | 'md'
}

const DOT: Record<StepState, string> = {
  done: 'bg-ok border-ok',
  draft: 'bg-draft border-draft',
  pending: 'bg-transparent border-muted-foreground/40 border-dashed',
  fail: 'bg-bad border-bad',
  partial: 'bg-warn border-warn',
  na: 'bg-muted border-border',
}

/**
 * Configuration and verification status. Pending changes are shown only for recovered drafts.
 */
export function TruthLadder({ draft, savedRevision, active, verified, notes, className, size = 'sm' }: TruthLadderProps) {
  const steps: { key: 'draft' | 'saved' | 'active' | 'verified'; label: string; state: StepState; note: string }[] = [
    {
      key: 'saved', label: savedRevision ? `r${savedRevision}` : 'Сохранено', state: savedRevision ? 'done' : 'pending',
      note: notes?.saved ?? (savedRevision ? `Сохранено в ревизии r${savedRevision}` : 'Ещё не сохранено на роутере'),
    },
    {
      key: 'active', label: 'Действует', state: active === 'na' ? 'na' : active ? 'done' : 'pending',
      note: notes?.active ?? (active === true ? 'Демон работает с этой конфигурацией' : active === 'na' ? 'Не применимо' : 'Демон ещё не загрузил эту ревизию'),
    },
    {
      key: 'verified', label: 'Проверено', state: verified === 'ok' ? 'done' : verified === 'fail' ? 'fail' : verified === 'partial' ? 'partial' : verified === 'na' ? 'na' : 'pending',
      note: notes?.verified ?? { ok: 'Подтверждено реальным трафиком', fail: 'Проверка трафиком не прошла', partial: 'Подтверждено частично', untested: 'Реальным трафиком не проверялось', na: 'Не применимо' }[verified],
    },
  ]
  if (draft) steps.unshift({ key: 'draft', label: 'Старый черновик', state: 'draft', note: notes?.draft ?? 'Есть правки из предыдущей версии панели' })
  return (
    <div className={cn('inline-flex max-w-full items-center', className)} role="list" aria-label="Состояние настройки">
      {steps.map((s, i) => (
        <div key={s.key} className="flex min-w-0 items-center" role="listitem">
          {i > 0 && <span className={cn('h-px min-w-1 shrink', size === 'sm' ? 'w-3' : 'w-5', s.state === 'done' || s.state === 'partial' ? 'bg-ok/40' : 'bg-border')} />}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex items-center gap-1.5 rounded-full px-1 py-0.5" />}>
              <span className={cn('size-2 rounded-full border', DOT[s.state])} />
              <span className={cn(size === 'sm' ? 'text-[11px]' : 'text-xs', s.state === 'na' || s.state === 'pending' ? 'text-muted-foreground' : 'text-foreground', s.state === 'draft' && 'text-draft')}>
                {s.label}
              </span>
            </TooltipTrigger>
            <TooltipContent>{s.note}</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  )
}

/** Violet marker on any entity with a pending draft change. */
export function DraftMark({ change, className }: { change: EntityChange | undefined; className?: string }) {
  if (!change) return null
  const label = change.op === 'add' ? 'Новое в черновике' : change.op === 'remove' ? 'Удалено в черновике' : 'Изменено в черновике'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <motion.span
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            className={cn('inline-flex h-4 items-center gap-1 rounded-full bg-draft/14 px-1.5 text-[10.5px] font-medium text-draft', className)}
          />
        }
      >
        <span className="size-1.5 rounded-full bg-draft" />
        {change.op === 'add' ? 'новое' : change.op === 'remove' ? 'удалено' : 'изменено'}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
