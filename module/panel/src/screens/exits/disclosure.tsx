import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function ExitDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group/exit overflow-hidden rounded-xl border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-open/exit:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-border px-3 py-3 [&_section]:mb-0">
        {children}
      </div>
    </details>
  )
}
