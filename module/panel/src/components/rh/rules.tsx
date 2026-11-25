import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, Reorder, useDragControls, useReducedMotion } from 'motion/react'
import { ChevronDown, GripVertical, Pencil, Plus, Trash2, X, Route, CornerDownRight, EyeOff } from 'lucide-react'
import type { Family, Match, MatchType, NamedSet, Proto, Rule } from '@/api/contract'
import { isDemo } from '@/api/mode'
import { MATCH_TYPE_LABEL } from '@/lib/labels'
import { ActionChip, ActionPicker } from './action'
import { DetailSheet } from './sheet'
import { SimpleSelect, Mono, WriteButton, type SelectOption } from './controls'
import { DraftMark } from './truth'
import { StatusBadge } from './status'
import { SavingSwitch, Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useCanWrite, useCaps, useGeo, useServerConfig } from '@/state/resource'
import type { EntityChange } from '@/api/contract'
import { href, useRoute } from '@/state/router'
import { EDITOR_ENTRY_PAGE_SIZE, entryPage, matchingEntryIndexes, parseEntryIndex } from '@/lib/rule-entries'
import { EntryPagination } from './entry-pagination'

/* ───────────── summary helpers ───────────── */

export function matchSummary(matches: Match[], max = 3, sets?: NamedSet[]): string {
  const parts = matches.slice(0, max).map((match) => {
    if (match.type === 'domain' || match.type === 'ip' || match.type === 'cidr') return match.value
    const value = match.type === 'set' ? sets?.find(({ id }) => id === match.value)?.name ?? match.value : match.value
    return `${MATCH_TYPE_LABEL[match.type]}: ${value}`
  })
  return parts.join(', ') + (matches.length > max ? ` и ещё ${matches.length - max}` : '')
}

export function FamProto({ rule }: { rule: Pick<Rule, 'families' | 'protos'> }) {
  const all = rule.families.length === 2 && rule.protos.length === 2
  if (all) return null
  return (
    <span className="text-[11.5px] text-muted-foreground">
      {rule.families.map((f) => (f === 'v4' ? 'IPv4' : 'IPv6')).join('/')} · {rule.protos.map((p) => p.toUpperCase()).join('/')}
    </span>
  )
}

/* ───────────── a rule row ───────────── */

export function RuleRow({
  rule,
  index,
  change,
  onToggle,
  onOpen,
  dragHandle,
  muted,
  extra,
  traceTarget,
}: {
  rule: Rule
  index?: number
  change?: EntityChange | boolean
  onToggle?: (enabled: boolean) => Promise<boolean>
  onOpen?: () => void
  dragHandle?: ReactNode
  muted?: boolean
  extra?: ReactNode
  /** Link "Почему так?" prefilled with the first match of this rule. */
  traceTarget?: { source: string; path: string }
}) {
  const can = useCanWrite()
  const { data: config } = useServerConfig()
  const firstTarget = rule.matches.map((match) => {
    if (match.type === 'set') return config?.sets.find(({ id }) => id === match.value)?.entries[0]
    return ['domain', 'suffix', 'ip', 'cidr'].includes(match.type) ? match.value : undefined
  }).find(Boolean)?.replace(/\/\d+$/, '')
  return (
    // Each row is its own size container: in a narrow sheet the action moves
    // under the name instead of squeezing it to a few letters.
    <div className="@container">
    <div className={cn('group flex items-center gap-3 bg-card px-3 py-2.5', (!rule.enabled || muted) && 'bg-muted/30')}>
      {dragHandle}
      {index != null && <span className="tabular w-5 min-w-max shrink-0 text-right text-[11.5px] text-muted-foreground">{index + 1}</span>}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none focus-visible:underline" disabled={!onOpen}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-[13.5px] font-medium', (!rule.enabled || muted) && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{rule.name}</span>
          {typeof change === 'object' ? <DraftMark change={change} /> : change ? <StatusBadge tone="draft" className="shrink-0">изменено</StatusBadge> : null}
          {rule.source.type !== 'manual' && <span className="hidden shrink-0 text-[11px] text-muted-foreground @xl:inline">{rule.source.label ?? rule.source.type}</span>}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] text-muted-foreground">{matchSummary(rule.matches, 3, config?.sets)}</span>
          <FamProto rule={rule} />
        </div>
        <ActionChip action={rule.action} className="mt-1.5 max-w-full @lg:hidden" />
      </button>
      {extra}
      <ActionChip action={rule.action} className="hidden max-w-[240px] shrink-0 @lg:inline-flex" />
      {traceTarget && firstTarget && (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={href(traceTarget.path, { src: traceTarget.source, t: firstTarget })}
                className="hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 md:inline-flex"
                aria-label="Почему так?"
              />
            }
          >
            <Route className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Проверить маршрут: {firstTarget}</TooltipContent>
        </Tooltip>
      )}
      {onToggle && <SavingSwitch checked={rule.enabled} onSave={onToggle} disabled={!can} aria-label={`Правило «${rule.name}»`} />}
    </div>
    </div>
  )
}

/** Drag-reorderable list of rules (order = priority). */
export function RuleList({
  rules,
  indexOffset = 0,
  onReorder,
  onToggle,
  onOpen,
  changeOf,
  selectionFor,
  traceSource,
  tracePath = '/trace',
  empty,
}: {
  rules: Rule[]
  indexOffset?: number
  onReorder?: (ids: string[]) => void
  onToggle?: (id: string, enabled: boolean) => Promise<boolean>
  onOpen?: (id: string) => void
  changeOf?: (id: string) => EntityChange | boolean | undefined
  selectionFor?: (rule: Rule) => ReactNode
  traceSource?: string
  tracePath?: string
  empty?: ReactNode
}) {
  const can = useCanWrite()
  const [order, setOrder] = useState(rules.map((r) => r.id))
  useEffect(() => setOrder(rules.map((r) => r.id)), [rules])
  if (!rules.length) return <>{empty ?? <div className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">Правил нет</div>}</>
  const byId = new Map(rules.map((r) => [r.id, r]))
  const traceTarget = traceSource ? { source: traceSource, path: tracePath } : undefined
  if (!onReorder || !can || selectionFor)
    return (
      <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
        {rules.map((r, i) => (
          <RuleRow key={r.id} rule={r} index={indexOffset + i} change={changeOf?.(r.id)} dragHandle={selectionFor?.(r)} onToggle={!selectionFor && onToggle ? (v) => onToggle(r.id, v) : undefined} onOpen={onOpen && (() => onOpen(r.id))} traceTarget={traceTarget} />
        ))}
      </div>
    )
  return (
    <Reorder.Group axis="y" values={order} onReorder={setOrder} className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
      {order.map((id, i) => {
        const r = byId.get(id)
        if (!r) return null
        return (
          <DraggableRule key={id} id={id} onDrop={() => order.join() !== rules.map((x) => x.id).join() && onReorder(order)}>
            {(handle) => (
              <RuleRow rule={r} index={indexOffset + i} change={changeOf?.(r.id)} dragHandle={handle} onToggle={onToggle && ((v) => onToggle(r.id, v))} onOpen={onOpen && (() => onOpen(r.id))} traceTarget={traceTarget} />
            )}
          </DraggableRule>
        )
      })}
    </Reorder.Group>
  )
}

function DraggableRule({ id, children, onDrop }: { id: string; children: (handle: ReactNode) => ReactNode; onDrop: () => void }) {
  const controls = useDragControls()
  return (
    <Reorder.Item
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="relative bg-card"
      whileDrag={{ scale: 1.01, boxShadow: '0 12px 28px -12px rgb(0 0 0 / 0.35)', zIndex: 10 }}
      transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
    >
      {children(
        <span
          onPointerDown={(e) => controls.start(e)}
          className="-ml-1 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground active:cursor-grabbing"
          aria-label="Перетащить, чтобы изменить порядок"
        >
          <GripVertical className="size-3.5" />
        </span>,
      )}
    </Reorder.Item>
  )
}

/** Inherited rule from a parent policy, with a per-scope "disable here" toggle. */
export function InheritedRuleRow({ rule, from, disabledHere, onToggleHere, change, index }: { rule: Rule; from: string; disabledHere: boolean; onToggleHere?: (disabled: boolean) => Promise<boolean>; change?: boolean; index?: number }) {
  const can = useCanWrite()
  return (
    <div className="@container">
      <div className={cn('flex items-center gap-3 bg-card px-3 py-2', disabledHere && 'bg-muted/40')}>
        <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground/60" />
        {index != null && <span className="tabular w-5 min-w-max shrink-0 text-right text-[11.5px] text-muted-foreground">{index + 1}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate text-[13px]', (disabledHere || !rule.enabled) && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{rule.name}</span>
            {change && (
              <StatusBadge tone="draft" className="shrink-0">
                изменено
              </StatusBadge>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {disabledHere && (
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground/70">
                <EyeOff className="size-3" /> отключено здесь ·
              </span>
            )}
            <span className="truncate">
              из «{from}» · {matchSummary(rule.matches, 2)}
            </span>
          </div>
          <ActionChip action={rule.action} className="mt-1.5 max-w-full @lg:hidden" />
        </div>
        <ActionChip action={rule.action} className="hidden max-w-[240px] shrink-0 @lg:inline-flex" />
        {onToggleHere && (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <SavingSwitch checked={!disabledHere} disabled={!can || !rule.enabled} onSave={(v) => onToggleHere(!v)} aria-label="Действует в этой области" />
            </TooltipTrigger>
            <TooltipContent>{!rule.enabled ? 'Выключено в исходной политике' : disabledHere ? 'Включить для этой области' : 'Отключить только для этой области — родитель не меняется'}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/* ───────────── rule editor ───────────── */

const MATCH_TYPES: MatchType[] = ['suffix', 'domain', 'cidr', 'ip', 'geosite', 'geoip', 'set', 'port']
const MATCH_OPTIONS = MATCH_TYPES.map((type) => ({ value: type, label: MATCH_TYPE_LABEL[type] }))
const MATCH_EXAMPLES: Record<MatchType, string> = {
  suffix: 'example.com', domain: 'example.com', cidr: '10.0.0.0/8', ip: '192.0.2.10',
  geosite: 'youtube', geoip: 'ru', set: 'Имя набора', port: '443',
}

const DOMAIN_MODES = [
  { value: 'suffix', label: 'Домен и поддомены' },
  { value: 'wildcard', label: 'Только поддомены' },
  { value: 'keyword', label: 'Ключевое слово' },
  { value: 'regex', label: 'Регулярное выражение RE2' },
]

function domainMode(match: Match) {
  return match.legacyMode ?? (match.value.trim().startsWith('*.') ? 'wildcard' : 'suffix')
}

function validRoutingName(input: string): boolean {
  if (/[\s/:?#@%\\]/u.test(input)) return false
  try {
    const host = new URL(`http://${input}`).hostname.replace(/\.$/, '')
    const labels = host.split('.')
    return host.length <= 253 && !/^\d+(?:\.\d+){3}$/.test(host) && labels.every((label, index) => {
      const name = index < labels.length - 1 ? label.replace(/^_/, '') : label
      return label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(name)
    })
  } catch {
    return false
  }
}

function validateMatch(m: Match): string | null {
  const v = m.value.trim()
  if (!v) return 'Пустое значение'
  if (m.type === 'domain' || m.type === 'suffix') {
    const mode = m.type === 'domain' ? 'exact' : domainMode(m)
    if (mode === 'regex' || mode === 'keyword') {
      return new TextEncoder().encode(v).length <= 2048 && !/[\u0000\r\n]/u.test(v) ? null : 'Укажите выражение на одной строке до 2048 байт'
    }
    return validRoutingName(mode === 'wildcard' ? v.replace(/^\*\./, '') : v) ? null : 'Не похоже на домен'
  }
  if (m.type === 'ip') return /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || v.includes(':') ? null : 'Не похоже на IP-адрес'
  if (m.type === 'cidr') return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(v) || /^[0-9a-f:]+\/\d{1,3}$/i.test(v) ? null : 'Ожидается подсеть вида 10.0.0.0/8'
  if (m.type === 'port') return /^\d{1,5}(-\d{1,5})?$/.test(v) ? null : 'Порт или диапазон 1000-2000'
  return null
}

export function emptyRule(id: string): Rule {
  return { id, name: '', matches: [{ type: 'suffix', value: '' }], families: ['v4', 'v6'], protos: ['tcp', 'udp'], action: { kind: 'vpn', target: { type: 'primary' } }, enabled: true, source: { type: 'manual' } }
}

export function RuleEditor({
  open,
  rule,
  isNew,
  scopeLabel,
  onSave,
  onDelete,
  transfer,
  onClose,
  traceSource,
  tracePath = '/trace',
  compact = false,
}: {
  open: boolean
  rule: Rule | null
  isNew?: boolean
  scopeLabel: string
  onSave: (rule: Rule, original: Rule | null) => Promise<boolean>
  onDelete?: (original: Rule) => Promise<boolean>
  transfer?: { destinations: SelectOption[]; onMove: (rule: Rule, original: Rule, target: string) => Promise<boolean> }
  onClose: () => void
  traceSource?: string
  tracePath?: string
  compact?: boolean
}) {
  const [r, setR] = useState<Rule | null>(rule)
  const [touched, setTouched] = useState(false)
  const [editing, setEditing] = useState<'name' | 'action' | number | null>(isNew && rule?.matches.length ? 0 : null)
  const [checkedCondition, setCheckedCondition] = useState<number | null>(null)
  const [checkedName, setCheckedName] = useState(false)
  const [matchSearch, setMatchSearch] = useState('')
  const [matchPage, setMatchPage] = useState(0)
  const [destination, setDestination] = useState('')
  const [saving, setSaving] = useState<'save' | 'delete' | null>(null)
  const request = useRef(0)
  const original = useRef(rule)
  const reduceMotion = useReducedMotion()
  const { data: caps } = useCaps()
  const { data: geo } = useGeo()
  const { data: config } = useServerConfig()
  const canWrite = useCanWrite()
  const editorId = useId()
  const form = useRef<HTMLFormElement>(null)
  const advanced = useRef<HTMLDetailsElement>(null)
  const route = useRoute()
  const linkedMatch = compact && route.path === '/rules-preview' ? parseEntryIndex(route.query.get('match')) : undefined
  const selectedMatch = linkedMatch !== undefined && rule?.matches[linkedMatch] ? linkedMatch : undefined
  const editorKey = route.query.get('rule') ?? rule?.id
  const matches = r?.matches
  const sets = config?.sets
  const errs = useMemo(() => matches?.map((match) => {
    if (match.type !== 'set') return validateMatch(match)
    if (!match.value) return 'Выберите набор'
    const set = sets?.find(({ id }) => id === match.value)
    return !set ? 'Набор не найден' : set.entries.length ? null : 'Добавьте хотя бы одну запись в набор'
  }) ?? [], [matches, sets])
  const matchIndexes = useMemo(() => compact && matches ? matchingEntryIndexes(matches, matchSearch, (match) => match.value) : [], [compact, matches, matchSearch])

  useEffect(() => {
    request.current += 1
    original.current = rule
    setR(rule)
    setSaving(null)
    setTouched(false)
    setEditing(selectedMatch ?? (isNew && rule?.matches.length ? 0 : null))
    setCheckedCondition(null)
    setCheckedName(false)
    setMatchSearch('')
    setDestination('')
    setMatchPage(Math.floor((selectedMatch ?? 0) / EDITOR_ENTRY_PAGE_SIZE))
    if (advanced.current) advanced.current.open = false
    return () => { request.current += 1 }
    // Keep a form's local values and its original version across server refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey, open, isNew, linkedMatch])

  useEffect(() => {
    if (!open || selectedMatch === undefined) return
    const rowId = `${editorId}-condition-${selectedMatch}`
    let settleFrame: number | undefined
    const frame = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => {
        const currentForm = form.current
        const target = document.getElementById(canWrite ? `${rowId}-value` : rowId)
        if (!target || !currentForm?.contains(target)) return
        target.scrollIntoView({ block: 'nearest' })
        const active = document.activeElement
        if (canWrite && (active === currentForm.parentElement || active === document.body)) target.focus({ preventScroll: true })
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (settleFrame !== undefined) cancelAnimationFrame(settleFrame)
    }
  }, [open, selectedMatch, editorId, canWrite])

  if (!r) return <DetailSheet open={open} onClose={onClose} title="Правило не найдено">Это правило удалено или ещё не создано.</DetailSheet>

  const pagination = entryPage(matchPage, matchIndexes.length, EDITOR_ENTRY_PAGE_SIZE)
  const browseMatches = r.matches.length > EDITOR_ENTRY_PAGE_SIZE || !!matchSearch
  const visibleMatches = matchIndexes.slice(pagination.start, pagination.end)
  if (typeof editing === 'number' && r.matches[editing] && !visibleMatches.includes(editing)) {
    // Keep an open field mounted while its value is changed past the current search filter.
    visibleMatches.push(editing)
    visibleMatches.sort((a, b) => a - b)
  }
  const nameErr = !r.name.trim() ? 'Назовите правило — так его будет проще найти в проверке маршрута' : null
  const nameInvalid = (touched || checkedName) && !!nameErr
  const missingConditions = compact && r.matches.length === 0
  const missingFamilies = r.families.length === 0
  const missingProtos = r.protos.length === 0
  const port = r.ports?.trim() ?? ''
  const invalidPort = !!port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  const invalid = !!nameErr || missingConditions || errs.some(Boolean) || missingFamilies || missingProtos || invalidPort
  const readonly = !canWrite
  const set = (p: Partial<Rule>) => {
    if (!readonly && !saving) setR((current) => (current ? { ...current, ...p } : current))
  }
  const setMatch = (i: number, p: Partial<Match>) => set({ matches: r.matches.map((m, j) => (j === i ? { ...m, ...p } : m)) })
  const matchOptions = isDemo ? MATCH_OPTIONS : MATCH_OPTIONS.filter(({ value }) =>
    value !== 'port' && (value !== 'set' || caps?.features?.namedSets?.available === true))
  const selectMatchType = (index: number, value: string) => {
    const current = r.matches[index]
    const clear = (current.type === 'set' || value === 'set') && current.type !== value
    setMatch(index, { type: value as MatchType, legacyMode: undefined, geoSource: undefined, ...(clear ? { value: '' } : {}) })
  }
  const setSelector = (match: Match, index: number, id?: string) => (
    <SimpleSelect id={id} className="w-full min-w-0" aria-label={`Набор для условия ${index + 1}`}
      value={match.value || null} placeholder={sets?.length ? 'Выберите набор' : 'Создайте набор во вкладке «Наборы»'}
      options={(sets ?? []).map(({ id, name, kind, entries }) => ({
        value: id, label: name, group: kind === 'domains' ? 'Домены' : 'IP-адреса и подсети', disabled: entries.length === 0,
      }))}
      onChange={(value) => setMatch(index, { value })} />
  )
  const moreMatchOptions = (match: Match, index: number) => {
    if (match.type === 'suffix') {
      return <SimpleSelect className="w-full" aria-label={`Совпадение домена ${index + 1}`} value={domainMode(match)} options={DOMAIN_MODES} onChange={(legacyMode) => setMatch(index, { legacyMode, value: match.value.trim().replace(/^\*\./, '') })} />
    }
    if (match.type === 'geoip' || match.type === 'geosite') {
      const sources = (geo ?? []).filter(({ kind }) => kind === match.type)
      if (sources.length) {
        return <SimpleSelect className="w-full" aria-label={`Источник геоданных ${index + 1}`} value={match.geoSource ?? sources[0].id} options={sources.map(({ id, name }) => ({ value: id, label: name }))} onChange={(geoSource) => setMatch(index, { geoSource })} />
      }
    }
    return null
  }
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const v6Untested = r.families.includes('v6') && caps?.interception.coverage.v6tcp.state === 'untested'
  const udpPartial = r.protos.includes('udp') && caps?.interception.coverage.v4udp.state === 'partial'
  const udpVpnPartial = udpPartial && r.action.kind === 'vpn'
  const unavailableAction = caps?.actions[r.action.kind]
  const title = isNew ? 'Новое правило' : r.name || 'Правило'
  const destinationValid = !destination || transfer?.destinations.some(({ value }) => value === destination)
  const saveLabel = isNew ? 'Добавить правило' : destination ? 'Сохранить и перенести' : 'Сохранить'
  const domainHint = r.matches.some((m) => m.type === 'domain' || m.type === 'suffix') && (
    <p className="text-[12px] leading-relaxed text-muted-foreground">Домен распознаётся по DNS-ответу и SNI. Если сайт делит IP с другими (CDN), правило по IP затронет их все — сравните в проверке маршрута.</p>
  )

  function focusEditorField(id: string, selector?: string) {
    const previous = document.activeElement
    // The sheet refocuses its popup on the next frame when an editor unmounts.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const editor = form.current
        const target = document.getElementById(`${editorId}-${id}`)
        if (!editor || !target || !editor.contains(target)) return
        const active = document.activeElement
        if (active !== previous && active !== document.body && active !== editor.closest('[role="dialog"]')) return
        const field = selector ? target.querySelector<HTMLElement>(selector) : target
        field?.focus()
      })
    })
  }

  function editCondition(index: number, focusValue = false) {
    const position = matchIndexes.indexOf(index)
    if (position < 0) setMatchSearch('')
    setMatchPage(Math.floor((position >= 0 ? position : index) / EDITOR_ENTRY_PAGE_SIZE))
    setEditing(index)
    if (advanced.current) advanced.current.open = false
    focusEditorField(focusValue ? `condition-${index}-value` : `condition-${index}-type`, focusValue ? undefined : '[role="combobox"]')
  }

  function finishCondition(index: number) {
    if (errs[index]) {
      setCheckedCondition(index)
      focusEditorField(`condition-${index}-value`)
    } else {
      setEditing(null)
      const position = matchIndexes.indexOf(index)
      if (position >= 0) setMatchPage(Math.floor(position / EDITOR_ENTRY_PAGE_SIZE))
      focusEditorField(position >= 0 ? `condition-${index}` : 'condition-search')
    }
  }

  function addCondition() {
    if (!r) return
    set({ matches: [...r.matches, { type: 'suffix', value: '' }] })
    if (compact) editCondition(r.matches.length, true)
  }

  function removeCondition(index: number) {
    if (!r || r.matches.length < 2) return
    set({ matches: r.matches.filter((_, row) => row !== index) })
    if (compact) {
      setEditing(null)
      setCheckedCondition(null)
      const remaining = matchIndexes.filter((other) => other !== index)
      const following = remaining.findIndex((other) => other > index)
      const position = following >= 0 ? following : remaining.length - 1
      if (position < 0) {
        focusEditorField('condition-search')
      } else {
        const next = remaining[position]
        setMatchPage(Math.floor(position / EDITOR_ENTRY_PAGE_SIZE))
        focusEditorField(`condition-${next > index ? next - 1 : next}`)
      }
    }
  }

  function editAction(open: boolean) {
    setEditing(open ? 'action' : null)
    if (open && advanced.current) advanced.current.open = false
    focusEditorField(open ? 'action-controls' : 'action-toggle', open ? '[role="combobox"]' : undefined)
  }

  function editName() {
    setEditing('name')
    if (advanced.current) advanced.current.open = false
    focusEditorField('name')
  }

  function finishName() {
    if (nameErr) {
      setCheckedName(true)
      focusEditorField('name')
    } else {
      setEditing(null)
      focusEditorField('name-toggle')
    }
  }

  async function commit(operation: 'save' | 'delete', action: () => Promise<boolean>) {
    if (readonly || saving) return
    const currentRequest = ++request.current
    setSaving(operation)
    try {
      if (await action() && currentRequest === request.current) onClose()
    } finally {
      if (currentRequest === request.current) setSaving(null)
    }
  }

  function save() {
    if (!r || readonly || saving || !destinationValid) return
    setTouched(true)
    if (invalid) {
      if (compact) {
        const invalidCondition = errs.findIndex(Boolean)
        if (nameErr) {
          editName()
          return
        }
        if (invalidCondition !== -1) {
          editCondition(invalidCondition, true)
          return
        }
        if ((missingFamilies || missingProtos || invalidPort) && advanced.current) advanced.current.open = true
        requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-rule-error]')?.focus())
      }
      return
    }
    const value = { ...r, name: r.name.trim(), ports: port || undefined, matches: r.matches.map((m) => ({ ...m, value: m.value.trim() })) }
    const initial = original.current
    if (destination && initial && transfer) {
      void commit('save', () => transfer.onMove(value, initial, destination))
      return
    }
    void commit('save', () => onSave(value, original.current))
  }

  const name = (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={`${editorId}-name`}>Название</Label>
      <Input
        id={`${editorId}-name`}
        className={compact ? 'h-9' : undefined}
        value={r.name}
        disabled={readonly}
        onChange={(e) => set({ name: e.target.value })}
        onKeyDown={compact && !isNew ? (event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            finishName()
          }
        } : undefined}
        placeholder={compact ? 'Например, рабочий портал' : 'Например: Рабочий портал через VPN'}
        aria-invalid={nameInvalid}
        aria-describedby={nameInvalid ? `${editorId}-name-error` : undefined}
        autoFocus={isNew}
      />
      {nameInvalid && <p id={`${editorId}-name-error`} className="text-[12px] text-bad">{nameErr}</p>}
    </div>
  )
  const toggle = (
    <label className={cn('flex min-w-0 items-center justify-between gap-3', compact ? 'min-h-9' : 'rounded-xl px-3.5 py-3 ring-1 ring-border')}>
      <div>
        <div className="text-[13.5px]">{compact ? (r.enabled ? 'Правило включено' : 'Правило выключено') : 'Правило включено'}</div>
        {!compact && <div className="text-[12px] text-muted-foreground">Выключенное правило остаётся в списке, но не участвует в расчёте</div>}
      </div>
      <Switch checked={r.enabled} disabled={readonly} onCheckedChange={(v) => set({ enabled: v })} aria-label={compact ? 'Правило включено' : undefined} />
    </label>
  )

  const networkFields = (
    <div className={compact ? 'grid grid-cols-2 gap-3' : 'grid gap-4 sm:grid-cols-2'}>
      <fieldset className="min-w-0 space-y-2" aria-describedby={compact && touched && missingFamilies ? `${editorId}-family-error` : undefined}>
        <legend className="mb-2 text-[13px] font-medium">Адреса</legend>
        {(['v4', 'v6'] as Family[]).map((f) => (
          <label key={f} className="flex min-w-0 items-center gap-2 text-[13px]">
            <Checkbox
              checked={r.families.includes(f)}
              disabled={readonly}
              aria-invalid={compact && touched && missingFamilies}
              aria-describedby={compact && touched && missingFamilies ? `${editorId}-family-error` : undefined}
              onCheckedChange={() => set({ families: toggleIn(r.families, f) })}
            />
            {f === 'v4' ? 'IPv4' : 'IPv6'}
          </label>
        ))}
        {compact && touched && missingFamilies && <p id={`${editorId}-family-error`} className="text-[12px] text-bad">Выберите IPv4 или IPv6.</p>}
        {!compact && v6Untested && <p className="text-[12px] text-muted-foreground">IPv6 на этой установке не испытан: правило сохранится, но гарантии перехвата нет.</p>}
      </fieldset>
      <fieldset className="min-w-0 space-y-2" aria-describedby={compact && touched && missingProtos ? `${editorId}-proto-error` : undefined}>
        <legend className="mb-2 text-[13px] font-medium">Протоколы</legend>
        {(['tcp', 'udp'] as Proto[]).map((p) => (
          <label key={p} className="flex min-w-0 items-center gap-2 text-[13px]">
            <Checkbox
              checked={r.protos.includes(p)}
              disabled={readonly}
              aria-invalid={compact && touched && missingProtos}
              aria-describedby={compact && touched && missingProtos ? `${editorId}-proto-error` : undefined}
              onCheckedChange={() => set({ protos: toggleIn(r.protos, p) })}
            />
            {p.toUpperCase()}
          </label>
        ))}
        {compact && touched && missingProtos && <p id={`${editorId}-proto-error`} className="text-[12px] text-bad">Выберите TCP или UDP.</p>}
        {!compact && udpPartial && <p className="text-[12px] text-muted-foreground">UDP через VPN работает только на части путей (TPROXY, SOCKS5).</p>}
      </fieldset>
    </div>
  )
  const note = (
    <div className="space-y-1.5">
      <Label htmlFor={`${editorId}-note`}>Заметка</Label>
      <Textarea id={`${editorId}-note`} rows={2} disabled={readonly} value={r.note ?? ''} onChange={(e) => set({ note: e.target.value || undefined })} placeholder="Зачем это правило — для себя в будущем" />
    </div>
  )
  const portField = (
    <div className="space-y-1.5">
      <Label htmlFor={`${editorId}-port`}>Порт назначения</Label>
      <Input
        id={`${editorId}-port`}
        inputMode="numeric"
        placeholder="Любой порт"
        value={r.ports ?? ''}
        disabled={readonly}
        aria-invalid={touched && invalidPort}
        aria-describedby={touched && invalidPort ? `${editorId}-port-error` : undefined}
        onChange={(event) => set({ ports: event.target.value })}
      />
      {touched && invalidPort && <p id={`${editorId}-port-error`} className="text-xs text-bad">Укажите один порт от 1 до 65535.</p>}
    </div>
  )

  const compactConditions = (
    <section aria-labelledby={`${editorId}-conditions`} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 id={`${editorId}-conditions`} className="text-sm font-semibold">Когда срабатывает</h2>
          {r.matches.length > 1 && <span className="text-[11.5px] text-muted-foreground">Достаточно одного совпадения</span>}
        </div>
        {!readonly && (
          <Button type="button" variant="outline" size="sm" className="min-h-9" data-rule-error={touched && missingConditions ? '' : undefined} onClick={addCondition}>
            <Plus aria-hidden="true" /> Добавить условие
          </Button>
        )}
      </div>

      {browseMatches && (
        <>
          <Input
            id={`${editorId}-condition-search`}
            type="search"
            className="h-9"
            aria-label="Поиск по условиям правила"
            placeholder="Найти условие"
            spellCheck={false}
            value={matchSearch}
            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }}
            onChange={(event) => {
              setMatchSearch(event.target.value)
              setMatchPage(0)
              if (typeof editing === 'number') setEditing(null)
            }}
          />
          <EntryPagination
            state={pagination}
            label="Страницы условий правила"
            onPageChange={(page) => {
              setMatchPage(page)
              if (typeof editing === 'number') setEditing(null)
            }}
          />
        </>
      )}
      {visibleMatches.length > 0 && (
        <ol className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {visibleMatches.map((index) => {
            const match = r.matches[index]
            const rowId = `${editorId}-condition-${index}`
            const errorId = `${rowId}-error`
            const error = touched || checkedCondition === index ? errs[index] : null
            const caption = match.type === 'suffix' ? DOMAIN_MODES.find(({ value }) => value === domainMode(match))?.label ?? MATCH_TYPE_LABEL.suffix : MATCH_TYPE_LABEL[match.type]
            const label = match.type === 'set' ? sets?.find(({ id }) => id === match.value)?.name ?? match.value : match.value
            const summary = (
              <span className="grid min-w-0 flex-1 items-baseline gap-x-3 gap-y-0.5 @min-[400px]:grid-cols-[minmax(100px,0.72fr)_minmax(0,1fr)]">
                <span className="text-[12px] font-medium text-muted-foreground">{caption}</span>
                <span className={cn('min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]', match.value.trim() ? 'font-mono' : 'text-muted-foreground')}>
                  {label.trim() || 'Значение не указано'}
                </span>
                {error && <span id={errorId} className="text-[12px] text-bad @min-[400px]:col-span-2">{error}</span>}
              </span>
            )

            return (
              <li key={index} value={index + 1} className="min-w-0">
                {editing === index && !readonly ? (
                  <motion.div
                    initial={reduceMotion ? false : { opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.16 }}
                    role="group"
                    aria-label={`Редактирование условия ${index + 1}`}
                    className="min-w-0 space-y-2.5 bg-muted/35 px-3 py-2.5"
                  >
                    <div className="grid min-w-0 items-start gap-2 @min-[380px]:grid-cols-[minmax(135px,0.85fr)_minmax(0,1fr)]">
                      <div id={`${rowId}-type`} className="min-w-0">
                        <SimpleSelect
                          className="w-full min-w-0 data-[size=default]:h-9"
                          aria-label={`Тип условия ${index + 1}`}
                          value={match.type}
                          onChange={(value) => selectMatchType(index, value)}
                          options={matchOptions}
                        />
                      </div>
                      <div className="min-w-0 space-y-1">
                        {match.type === 'set' ? setSelector(match, index, `${rowId}-value`) : <Input
                          id={`${rowId}-value`}
                          className="h-9 px-2 font-mono text-[13px]"
                          value={match.value}
                          onChange={(event) => setMatch(index, { value: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                              event.preventDefault()
                              finishCondition(index)
                            }
                          }}
                          placeholder={MATCH_EXAMPLES[match.type]}
                          spellCheck={false}
                          aria-label={`Значение условия ${index + 1}`}
                          aria-invalid={!!error}
                          aria-describedby={error ? errorId : undefined}
                        />}
                        {error && <p id={errorId} className="text-[12px] text-bad">{error}</p>}
                      </div>
                    </div>
                    {moreMatchOptions(match, index)}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {r.matches.length > 1 ? (
                        <Button type="button" variant="ghost" size="sm" className="min-h-9 text-muted-foreground" onClick={() => removeCondition(index)} aria-label={`Убрать условие ${index + 1}`}>
                          <X aria-hidden="true" /> Убрать
                        </Button>
                      ) : <span />}
                      <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={() => finishCondition(index)} aria-label={`Готово, условие ${index + 1}`}>
                        Готово
                      </Button>
                    </div>
                  </motion.div>
                ) : readonly ? (
                  <div id={rowId} className="flex min-h-11 items-center px-3 py-2">{summary}</div>
                ) : (
                  <button
                    id={rowId}
                    type="button"
                    className="flex min-h-11 w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    aria-label={`Редактировать условие ${index + 1}, ${caption}, ${label.trim() || 'значение не указано'}`}
                    aria-describedby={error ? errorId : undefined}
                    onClick={() => editCondition(index)}
                  >
                    {summary}
                    <Pencil aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {visibleMatches.length === 0 && matchSearch && <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">Условия не найдены</p>}
      {touched && missingConditions && <p className="text-[12px] text-bad">Добавьте хотя бы одно условие.</p>}
    </section>
  )

  const compactAction = (
    <section aria-labelledby={`${editorId}-action-heading`} className="min-w-0 space-y-2">
      <h2 id={`${editorId}-action-heading`} className="text-sm font-semibold">Куда направить</h2>
      <div className="min-w-0 rounded-xl border border-border bg-card">
        {editing === 'action' && !readonly ? (
          <motion.div
            id={`${editorId}-action-controls`}
            initial={reduceMotion ? false : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
            className="min-w-0 space-y-2.5 p-3 [&_[data-slot=select-trigger]]:h-9"
          >
            <ActionPicker value={r.action} aria-label="Маршрут правила" onChange={(a) => set({ action: a })} />
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={() => editAction(false)} aria-label="Готово, маршрут правила">Готово</Button>
            </div>
          </motion.div>
        ) : (
          <div className="min-w-0 px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <ActionChip action={r.action} className="h-auto min-h-6 max-w-full py-0.5 [&>span]:overflow-visible [&>span]:whitespace-normal [&>span]:[overflow-wrap:anywhere]" />
              {!readonly && (
                <Button id={`${editorId}-action-toggle`} type="button" variant="ghost" size="sm" className="ml-auto min-h-9" onClick={() => editAction(true)} aria-label="Изменить маршрут правила">
                  <Pencil aria-hidden="true" /> Изменить
                </Button>
              )}
            </div>
            {unavailableAction?.available === false && (
              <p className="mt-1 text-[12px] text-warn">{unavailableAction.reason ?? 'Этот маршрут недоступен на данной установке.'}</p>
            )}
          </div>
        )}
      </div>
    </section>
  )

  const fields = (
    <>
      {compact ? (
        <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2">
          {isNew ? (
            <div className="grid min-w-0 items-end gap-2.5 py-1 @min-[380px]:grid-cols-[minmax(0,1fr)_auto]">
              {name}{toggle}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                {toggle}
                {!readonly && editing !== 'name' && (
                  <Button id={`${editorId}-name-toggle`} type="button" variant="ghost" size="sm" className="ml-auto min-h-9" onClick={editName}>
                    <Pencil aria-hidden="true" /> Переименовать
                  </Button>
                )}
              </div>
              {editing === 'name' && !readonly && (
                <div className="mt-2.5 space-y-2.5 border-t border-border pt-2.5">
                  {name}
                  <div className="flex justify-end">
                    <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={finishName} aria-label="Готово, название правила">Готово</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : name}

      {compact ? <>{compactConditions}{compactAction}</> : (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <Label>Условия</Label>
              <span className="text-[11.5px] text-muted-foreground">совпадение любого условия</span>
            </div>
            <div className="space-y-2">
              {r.matches.map((match, index) => {
                const error = touched && errs[index]
                const errorId = `${editorId}-condition-${index}-error`
                return (
                  <div key={index} className="min-w-0 space-y-1">
                    <div className="flex gap-2">
                      <SimpleSelect className="w-44 min-w-0 shrink-0" value={match.type} onChange={(value) => selectMatchType(index, value)} options={matchOptions} />
                      {match.type === 'set' ? setSelector(match, index) : <Input
                        className="font-mono text-[13px]"
                        value={match.value}
                        onChange={(event) => setMatch(index, { value: event.target.value })}
                        placeholder={match.type === 'cidr' ? '10.0.0.0/8' : match.type === 'geosite' ? 'youtube' : 'example.com'}
                        aria-invalid={!!error}
                        aria-describedby={error ? errorId : undefined}
                      />}
                      <Button type="button" variant="ghost" size="icon" className="shrink-0 text-muted-foreground" disabled={r.matches.length === 1} onClick={() => removeCondition(index)} aria-label="Убрать условие">
                        <X aria-hidden="true" />
                      </Button>
                    </div>
                    {moreMatchOptions(match, index)}
                    {error && <p id={errorId} className="pl-46 text-[12px] text-bad">{error}</p>}
                  </div>
                )
              })}
              <Button type="button" variant="outline" size="sm" onClick={addCondition}>
                <Plus aria-hidden="true" /> Условие
              </Button>
            </div>
            {domainHint}
          </div>
          <div className="min-w-0 space-y-2">
            <Label>Действие</Label>
            <ActionPicker value={r.action} onChange={(a) => set({ action: a })} />
          </div>
        </>
      )}

      {compact ? (
        <div className="min-w-0 space-y-2">
          <details
            ref={advanced}
            className="group min-w-0 rounded-xl border border-border bg-card"
            onToggle={(event) => { if (event.currentTarget.open) setEditing(null) }}
          >
            <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 py-2 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span>Дополнительные параметры</span>
                {missingFamilies || missingProtos ? (
                  <span className="text-[11.5px] text-bad">{missingFamilies && missingProtos ? 'Выберите адреса и протоколы' : missingFamilies ? 'Выберите адреса' : 'Выберите протоколы'}</span>
                ) : (
                  <span className="text-[11.5px] font-normal text-muted-foreground">
                    {r.families.map((family) => family === 'v4' ? 'IPv4' : 'IPv6').join('/')} · {r.protos.map((proto) => proto.toUpperCase()).join('/')}
                  </span>
                )}
              </span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-border p-3">
              {networkFields}
              {portField}
              {note}
              {domainHint}
            </div>
          </details>
          {(v6Untested || udpVpnPartial) && (
            <p className="text-[12px] text-muted-foreground">
              {v6Untested && 'Перехват IPv6 ещё не испытан. '}
              {udpVpnPartial && 'UDP через VPN работает на части путей.'}
            </p>
          )}
        </div>
      ) : <>{networkFields}{portField}{note}{toggle}</>}

      {!isNew && traceSource && r.matches[0] && (
        <a
          href={href(tracePath, { src: traceSource, t: r.matches[0].value.replace(/\/\d+$/, '') })}
          className={cn('inline-flex items-center gap-1.5 text-[13px] text-info hover:underline', compact && 'min-h-9 rounded-md focus-visible:outline-2 focus-visible:outline-ring')}
        >
          <Route aria-hidden="true" className="size-3.5 shrink-0" />
          {compact ? 'Проверить маршрут' : <>Почему так? Проверить маршрут для <Mono>{r.matches[0].value}</Mono></>}
        </a>
      )}
    </>
  )

  return (
    <DetailSheet
      open={open}
      onClose={() => { if (!saving) onClose() }}
      title={compact ? <span className="[overflow-wrap:anywhere]">{title}</span> : title}
      description={<span className="[overflow-wrap:anywhere]">{scopeLabel}</span>}
      headerExtra={!canWrite ? <p className="text-xs font-medium text-muted-foreground">Только чтение</p> : undefined}
      footer={
        <div className={cn('flex items-center justify-between gap-2', compact && 'min-w-0 flex-wrap')}>
          {onDelete && !isNew ? (
            <WriteButton
              variant="ghost"
              className={cn('text-bad hover:text-bad', compact && 'min-h-9 px-2.5')}
              aria-label={compact ? 'Удалить правило' : undefined}
              title={compact ? 'Удалить правило' : undefined}
              disabled={!!saving}
              onClick={() => {
                const savedRule = original.current
                if (savedRule) void commit('delete', () => onDelete(savedRule))
              }}
            >
              <Trash2 aria-hidden="true" /> <span className={compact ? 'hidden min-[380px]:inline' : undefined}>{saving === 'delete' ? 'Удаляем…' : 'Удалить'}</span>
            </WriteButton>
          ) : (
            <span />
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" className={compact ? 'min-h-9 px-2.5' : undefined} disabled={!!saving} onClick={onClose}>
              Отмена
            </Button>
            <WriteButton
              type={compact ? 'submit' : 'button'}
              form={compact ? `${editorId}-form` : undefined}
              className={compact ? 'min-h-9 px-2.5' : undefined}
              aria-label={saving === 'save' ? 'Сохраняем…' : compact ? saveLabel : undefined}
              disabled={!!saving || !destinationValid || (!compact && touched && invalid)}
              reason={!compact && invalid ? 'Исправьте отмеченные поля' : undefined}
              onClick={compact ? undefined : save}
            >
              {saving === 'save' ? 'Сохраняем…' : saveLabel}
            </WriteButton>
          </div>
        </div>
      }
    >
      {compact ? (
        <form
          id={`${editorId}-form`}
          ref={form}
          className="@container min-w-0"
          aria-busy={!!saving}
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <fieldset disabled={!!saving} className="min-w-0 space-y-3.5">
            {fields}
            {!readonly && !isNew && transfer && (transfer.destinations.length > 0 || destination) && (
              <div className="space-y-1.5">
                <Label htmlFor={`${editorId}-destination`}>Куда перенести правило</Label>
                <SimpleSelect id={`${editorId}-destination`} className="w-full min-w-0"
                  options={[
                    { value: '', label: 'Оставить в текущей области' },
                    ...transfer.destinations,
                    ...(!destinationValid ? [{ value: destination, label: 'Область назначения недоступна', disabled: true }] : []),
                  ]}
                  value={destination} disabled={!!saving} onChange={setDestination}
                />
                {destination && <p className="text-xs text-muted-foreground">Правило будет удалено из текущей области и добавлено в конец выбранной.</p>}
              </div>
            )}
          </fieldset>
        </form>
      ) : (
        <fieldset disabled={!!saving} aria-busy={!!saving} className="min-w-0 space-y-6">{fields}</fieldset>
      )}
    </DetailSheet>
  )
}
