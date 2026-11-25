import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function SettingDisclosure({ group, title, value, note, children }: { group: string; title: string; value: string; note?: string; children: ReactNode }) {
  return (
    <details name={group} className="group/setting min-w-0">
      <summary className="flex min-h-[55px] cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring group-open/setting:bg-muted/35 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 space-y-0.5 [overflow-wrap:anywhere]">
          <span className="block text-[13px] font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{value}</span>
          {note && <span className="block text-xs text-warn">{note}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground motion-safe:transition-transform group-open/setting:rotate-180" />
      </summary>
      <div className="min-w-0 border-t border-border motion-safe:group-open/setting:animate-in motion-safe:group-open/setting:fade-in-0 motion-safe:group-open/setting:duration-150">
        {children}
      </div>
    </details>
  )
}
