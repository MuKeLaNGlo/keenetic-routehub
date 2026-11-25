import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseEntryIndex, type entryPage } from '@/lib/rule-entries'

export function EntryPagination({ state, onPageChange, label, hideSinglePage = false }: {
  state: ReturnType<typeof entryPage>
  onPageChange: (page: number) => void
  label: string
  hideSinglePage?: boolean
}) {
  const [pageInput, setPageInput] = useState<string | null>(null)
  const { page, pages, start, end, total } = state
  const formattedTotal = total.toLocaleString('ru-RU')
  const status = (
    <p role="status" className="text-xs text-muted-foreground tabular-nums">
      {pages > 1 ? `${start + 1}–${end} из ${formattedTotal}` : `Найдено: ${formattedTotal}`}
    </p>
  )
  if (pages <= 1) return hideSinglePage ? null : status

  return (
    <nav aria-label={label} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      {status}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="outline" size="icon-sm" disabled={page === 0} onClick={() => onPageChange(page - 1)} aria-label="Предыдущая страница">
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Input
          type="text"
          inputMode="numeric"
          aria-label={`Номер страницы из ${pages}`}
          title="Введите номер страницы и нажмите Enter"
          className="tabular h-7 w-11 px-1 text-center text-xs"
          value={pageInput ?? String(page + 1)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => setPageInput(null)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            const target = parseEntryIndex(event.currentTarget.value)
            setPageInput(null)
            if (target !== undefined) onPageChange(Math.max(0, Math.min(pages - 1, target - 1)))
          }}
        />
        <span className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">/ {pages}</span>
        <Button type="button" variant="outline" size="icon-sm" disabled={page === pages - 1} onClick={() => onPageChange(page + 1)} aria-label="Следующая страница">
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  )
}
