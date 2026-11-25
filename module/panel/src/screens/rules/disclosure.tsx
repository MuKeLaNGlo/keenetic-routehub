import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export function RuleDisclosure({ title, meta, children, className }: {
  title: ReactNode
  meta?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <details className={cn('group min-w-0 bg-card', className)}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3.5 py-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]">{title}</span>
          {meta}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-border px-3.5 py-3">{children}</div>
    </details>
  )
}
