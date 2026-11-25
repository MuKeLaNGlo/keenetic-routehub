import { useMemo, useState } from 'react'
import { ArrowRight, ChevronRight, Search } from 'lucide-react'
import type { EventType, JournalEvent } from '@/api/contract'
import { SimpleSelect } from '@/components/rh/controls'
import { Gate, KV, Panel } from '@/components/rh/layout'
import { DetailSheet } from '@/components/rh/sheet'
import { StatusDot, type Tone } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { clock, dateTime } from '@/lib/format'
import { useEvents } from '@/state/resource'
import { closeQuery, href, useRoute } from '@/state/router'

type Severity = JournalEvent['severity']

const TYPES: Record<EventType, string> = {
  apply: 'Применение',
  rollback: 'Откат',
  failover: 'Переключение выхода',
  fallback: 'Резервный выход',
  engine: 'Ядро',
  profile: 'Профиль',
  dns: 'DNS',
  zapret: 'Zapret',
  update: 'Обновление',
  restore: 'Восстановление',
  task: 'Задача',
  compat: 'Совместимость',
  trial: 'Пробное применение',
  subscription: 'Подписка',
}

const SEVERITIES: Record<Severity, { label: string; tone: Tone }> = {
  error: { label: 'Ошибка', tone: 'bad' },
  warn: { label: 'Предупреждение', tone: 'warn' },
  ok: { label: 'Успех', tone: 'ok' },
  info: { label: 'Инфо', tone: 'info' },
}

const TYPE_OPTIONS: [string, string][] = [['', 'Все типы'], ...Object.entries(TYPES)]
const SEVERITY_OPTIONS: [string, string][] = [
  ['', 'Любая важность'],
  ...Object.entries(SEVERITIES).map(([value, { label }]): [string, string] => [value, label]),
]

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const dayName = (date: string | Date) => dateFormat.format(new Date(date))

function eventDestination(event: JournalEvent): { to: string; label: string } | undefined {
  const id = event.object.id
  switch (event.type) {
    case 'apply':
    case 'rollback':
    case 'restore':
      return { to: href('/system-preview', { tab: 'revisions' }), label: 'Ревизии' }
    case 'failover':
    case 'fallback':
      return { to: href('/exits-preview', { tab: 'groups', g: id }), label: 'Группы выходов' }
    case 'profile':
      return { to: href('/exits-preview', { tab: 'profiles', p: id }), label: 'Профили VPN' }
    case 'dns':
      return { to: href('/dns-preview'), label: 'DNS' }
    case 'zapret':
      return { to: href('/zapret-preview'), label: 'Zapret' }
    case 'engine':
    case 'update':
      return { to: href('/system-preview', { tab: 'updates' }), label: 'Обновления' }
    case 'trial':
      return id ? { to: href('/devices-preview', { d: id }), label: 'Устройство' } : { to: href('/trace-preview'), label: 'Проверка маршрута' }
    case 'subscription':
      return event.object.kind === 'set'
        ? { to: href('/rules-preview', { tab: 'sets' }), label: 'Наборы правил' }
        : { to: href('/exits-preview', { tab: 'subscriptions' }), label: 'Подписки' }
    default:
      return undefined
  }
}

function SeverityLabel({ severity }: { severity: Severity }) {
  const { label, tone } = SEVERITIES[severity]
  return <span className="inline-flex items-center gap-1.5"><StatusDot tone={tone} /> {label}</span>
}

function FilterSelect({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (value: string) => void
  options: [string, string][]
}) {
  return (
    <SimpleSelect
      aria-label={label}
      value={value || 'all'}
      onChange={(option) => onChange(option === 'all' ? '' : option)}
      options={options.map(([option, text]) => ({ value: option || 'all', label: text }))}
      className="w-full min-w-0 bg-card text-[13px] data-[size=default]:h-9"
    />
  )
}

function EventRows({ events, eventBase }: { events: JournalEvent[]; eventBase: Record<string, string> }) {
  const dates = new Map<string, JournalEvent[]>()
  for (const event of events) {
    const day = dayName(event.at)
    const group = dates.get(day)
    if (group) group.push(event)
    else dates.set(day, [event])
  }

  const now = new Date()
  const today = dayName(now)
  now.setDate(now.getDate() - 1)
  const yesterday = dayName(now)

  return (
    <Panel className="overflow-hidden rounded-2xl">
      <div aria-hidden="true" className="journal-preview__row journal-preview__columns border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
        <span>Время</span><span>Важность</span><span>Событие</span><span>Объект</span>
      </div>
      {[...dates].map(([date, entries]) => (
        <div key={date} className="[&+&]:border-t [&+&]:border-border">
          <h2 className="border-b border-border bg-muted/45 px-3.5 py-1.5 text-xs font-medium text-muted-foreground" aria-label={date}>
            {date === today ? 'Сегодня' : date === yesterday ? 'Вчера' : date}
          </h2>
          <ul className="divide-y divide-border">
            {entries.map((event) => (
              <li key={event.id}>
                <a href={href('/journal-preview', { ...eventBase, e: event.id })} className="journal-preview__row journal-preview__event min-h-11 px-3.5 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/65">
                  <time dateTime={event.at} className="journal-preview__time tabular text-xs text-muted-foreground">{clock(event.at)}</time>
                  <span className="journal-preview__severity min-w-0 text-xs text-muted-foreground"><SeverityLabel severity={event.severity} /></span>
                  <span className="journal-preview__name min-w-0 text-[13px] font-medium leading-snug [overflow-wrap:anywhere]">{event.title}</span>
                  <span className="journal-preview__object min-w-0 truncate text-xs text-muted-foreground" title={event.object.name}>{event.object.name}</span>
                  <ChevronRight className="journal-preview__chevron size-3.5 text-muted-foreground" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Panel>
  )
}

export function EventList({ active }: { active: boolean }) {
  const resource = useEvents()
  const route = useRoute()
  const eventId = active ? route.query.get('e') : null
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [severity, setSeverity] = useState('')
  const needle = query.trim().toLocaleLowerCase('ru-RU')
  const hasFilters = !!(query || type || severity)
  const ordered = useMemo(() => [...(resource.data ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [resource.data])
  const filtered = ordered.filter((event) =>
    (!type || event.type === type) &&
    (!severity || event.severity === severity) &&
    (!needle || [event.title, event.object.name, event.detail ?? '', TYPES[event.type], ...(event.facts?.flat() ?? [])]
      .some((value) => value.toLocaleLowerCase('ru-RU').includes(needle))),
  )
  const selected = eventId ? ordered.find(({ id }) => id === eventId) : undefined
  const destination = selected && eventDestination(selected)

  function reset() {
    setQuery('')
    setType('')
    setSeverity('')
  }

  return (
    <>
      <div className="journal-preview__filters mb-3" role="group" aria-label="Фильтры событий">
        <div className="journal-preview__search relative min-w-0">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Поиск по журналу" aria-label="Поиск по журналу" className="h-9 bg-card pl-9" />
        </div>
        <FilterSelect label="Тип события" value={type} onChange={setType} options={TYPE_OPTIONS} />
        <FilterSelect label="Важность" value={severity} onChange={setSeverity} options={SEVERITY_OPTIONS} />
        {hasFilters && <Button className="journal-preview__reset h-9 text-muted-foreground" variant="ghost" type="button" onClick={reset}>Сбросить</Button>}
      </div>

      <Gate res={resource}>
        {() => filtered.length ? (
          <EventRows events={filtered} eventBase={Object.fromEntries(route.query)} />
        ) : (
          <Panel className="rounded-2xl px-4 py-8 text-center">
            <p role="status" className="text-sm text-muted-foreground">{ordered.length ? 'По этим фильтрам ничего не найдено' : 'Событий пока нет'}</p>
          </Panel>
        )}
      </Gate>

      <DetailSheet
        open={!!eventId}
        onClose={() => closeQuery('e')}
        title={selected?.title ?? 'Событие'}
        description={selected && <time dateTime={selected.at}>{dateTime(selected.at)}</time>}
        headerExtra={selected && <div className="text-xs text-muted-foreground"><SeverityLabel severity={selected.severity} /></div>}
        footer={destination && (
          <a href={destination.to} className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {destination.label} <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        )}
      >
        {selected ? (
          <div className="space-y-4">
            {selected.detail && <p className="text-[13px] leading-relaxed [overflow-wrap:anywhere]">{selected.detail}</p>}
            <KV items={[
              ['Объект', selected.object.name],
              ['Тип', TYPES[selected.type]],
              ...(selected.facts ?? []),
            ]} />
          </div>
        ) : resource.error ? (
          <div className="space-y-3 text-sm"><p>Не удалось загрузить событие.</p><Button variant="outline" onClick={() => void resource.refetch()}>Повторить</Button></div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">{resource.data ? 'Событие отсутствует в журнале.' : 'Загружается…'}</p>
        )}
      </DetailSheet>
    </>
  )
}
