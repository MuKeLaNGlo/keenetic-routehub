import { useMemo } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import type { Config } from '@/api/contract'
import { SimpleSelect } from '@/components/rh/controls'
import { EntryPagination } from '@/components/rh/entry-pagination'
import { Input } from '@/components/ui/input'
import { MATCH_TYPE_LABEL } from '@/lib/labels'
import { collectRuleEntries, entryPage, ENTRY_FILTERS, ENTRY_TYPE_LABEL, filterRuleEntries, isSetPreviewMarker, parseEntryIndex, type RuleEntry } from '@/lib/rule-entries'
import { href, setQuery, useRoute } from '@/state/router'

function entryLabel(entry: RuleEntry) {
  if (entry.matchType === 'suffix') return 'Домен и поддомены'
  if (entry.matchType === 'set') return 'Ссылка на набор'
  if (entry.type === 'reference' && entry.matchType) return `Ссылка ${MATCH_TYPE_LABEL[entry.matchType]}`
  return ENTRY_TYPE_LABEL[entry.type]
}

export function EntriesTab({ config }: { config: Config }) {
  const route = useRoute()
  const search = route.query.get('q') ?? ''
  const filter = route.query.get('type')
  const type = ENTRY_FILTERS.find(({ value }) => value === filter)?.value ?? 'all'
  const includesReferences = type === 'all' || type === 'reference'
  const requested = (parseEntryIndex(route.query.get('page')) ?? 1) - 1
  const entries = useMemo(() => collectRuleEntries(config), [config.policies, config.sets])
  const results = useMemo(() => filterRuleEntries(entries, type, search), [entries, type, search])
  const partialSets = useMemo(() => config.sets.filter((set) => set.source.type === 'url' && set.entries.some(isSetPreviewMarker)), [config.sets])
  const page = entryPage(requested, results.length)

  function sourceLink(entry: RuleEntry) {
    const params = new URLSearchParams(route.query)
    for (const key of ['rule', 'match', 'set', 'entry']) params.delete(key)
    if (entry.source.kind === 'rule') {
      params.set('rule', entry.source.id)
      params.set('match', String(entry.index))
    } else {
      params.set('set', entry.source.id)
      params.set('entry', String(entry.index))
    }
    return href(route.path, Object.fromEntries(params))
  }

  return (
    <section className="min-w-0 space-y-3" aria-label="Все записи">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Поиск по значению записи"
            placeholder="Домен, IP-адрес или подсеть"
            className="h-10 min-w-0 pl-9"
            value={search}
            spellCheck={false}
            onChange={(event) => setQuery({ q: event.target.value, page: null }, { replace: true })}
          />
        </div>
        <SimpleSelect
          className="w-full min-w-0 data-[size=default]:h-10"
          aria-label="Тип записей"
          value={type}
          onChange={(value) => setQuery({ type: value === 'all' ? null : value, page: null })}
          options={[...ENTRY_FILTERS]}
        />
      </div>

      <EntryPagination state={page} onPageChange={(next) => setQuery({ page: next > 0 ? String(next + 1) : null })} label="Страницы всех записей" />
      {(includesReferences || partialSets.length > 0) && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {includesReferences && 'GeoSite и GeoIP показаны как ссылки на базы. '}
          {partialSets.length > 0 && `Из ${partialSets.map(({ name }) => `«${name}»`).join(', ')} учтены только записи, доступные в макете.`}
        </p>
      )}

      {page.total > 0 ? (
        <ul className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-label="Записи правил и наборов">
          {results.slice(page.start, page.end).map((entry) => {
            const { source } = entry
            const key = source.kind === 'rule' ? `${source.kind}/${source.scopeId}/${source.id}/${entry.index}` : `${source.kind}/${source.id}/${entry.index}`
            return (
              <li key={key}>
                <a
                  href={sourceLink(entry)}
                  className="grid min-h-13 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto]"
                >
                  <span className="min-w-0">
                    <span className="block text-[11.5px] text-muted-foreground">{entryLabel(entry)}</span>
                    <span className="block font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{entry.referenceName ?? (entry.value || 'Пустое значение')}</span>
                  </span>
                  <span className="col-start-1 min-w-0 text-xs [overflow-wrap:anywhere] sm:col-start-2">
                    <span className="font-medium">{source.name || 'Без названия'}</span>
                    <span className="ml-1 text-muted-foreground">· {source.kind === 'rule' ? `Правило · ${source.scope}${source.enabled ? '' : ' · выключено'}` : `Набор${source.fromUrl ? ' из источника' : ' · ручной'}`}</span>
                  </span>
                  <ChevronRight className="col-start-2 row-span-2 row-start-1 size-4 text-muted-foreground sm:col-start-3 sm:row-span-1" aria-hidden="true" />
                </a>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed px-4 py-7 text-center text-sm">
          {entries.length === 0 ? 'В правилах и наборах пока нет записей' : 'По вашему запросу ничего не найдено'}
        </div>
      )}

    </section>
  )
}
