import { EntryPagination } from '@/components/rh/entry-pagination'
import { entryPage } from '@/lib/rule-entries'

export const RULE_PAGE_SIZE = 50

export function rulePage(total: number, requested: number) {
  const { page, ...bounds } = entryPage(requested, total, RULE_PAGE_SIZE)
  return { index: page, ...bounds }
}

export function RulePagination({ label, page, onPage }: {
  label: string
  page: ReturnType<typeof rulePage>
  onPage: (index: number) => void
}) {
  const { index, ...bounds } = page
  return <EntryPagination label={label} state={{ page: index, ...bounds }} onPageChange={onPage} hideSinglePage />
}
