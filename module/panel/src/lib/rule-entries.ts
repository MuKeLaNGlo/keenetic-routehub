import type { Config, MatchType, NamedSet } from '@/api/contract'

export const ENTRY_PAGE_SIZE = 24
export const EDITOR_ENTRY_PAGE_SIZE = 12

export function entryPage(requested: number, total: number, pageSize = ENTRY_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(0, requested), pages - 1)
  const start = page * pageSize
  return { page, pages, start, end: Math.min(start + pageSize, total), total }
}

export function parseEntryIndex(value: string | null) {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const index = Number(value)
  return Number.isSafeInteger(index) ? index : undefined
}

export function matchingEntryIndexes<T>(entries: readonly T[], search: string, valueOf: (entry: T) => string) {
  const query = search.trim().toLowerCase()
  const indexes: number[] = []
  entries.forEach((entry, index) => {
    if (!query || valueOf(entry).toLowerCase().includes(query)) indexes.push(index)
  })
  return indexes
}

export const ENTRY_FILTERS = [
  { value: 'all', label: 'Все типы' }, { value: 'domain', label: 'Домены' }, { value: 'ip', label: 'IP-адреса' },
  { value: 'cidr', label: 'Подсети (CIDR)' }, { value: 'reference', label: 'Ссылки' }, { value: 'port', label: 'Порты' },
] as const

export type EntryFilter = (typeof ENTRY_FILTERS)[number]['value']
type EntryType = Exclude<EntryFilter, 'all'>

const MATCH_ENTRY_TYPE: Record<MatchType, EntryType> = {
  domain: 'domain', suffix: 'domain', ip: 'ip', cidr: 'cidr', set: 'reference', geosite: 'reference', geoip: 'reference', port: 'port',
}

/** Older demo snapshots use this label to mark entries absent from the model. */
export function isSetPreviewMarker(value: string) {
  return /^…\s*ещ[её]\s+\d[\d\s]*$/i.test(value.trim())
}

export function setEntryType(kind: NamedSet['kind'], value: string): 'domain' | 'cidr' | 'ip' {
  if (kind === 'domains') return 'domain'
  return value.includes('/') ? 'cidr' : 'ip'
}

type EntrySource =
  | { kind: 'rule'; id: string; name: string; scope: string; scopeId: string; enabled: boolean }
  | { kind: 'set'; id: string; name: string; fromUrl: boolean }

export interface RuleEntry {
  source: EntrySource
  index: number
  type: EntryType
  matchType?: MatchType
  value: string
  referenceName?: string
}

export function collectRuleEntries(config: Pick<Config, 'policies' | 'sets'>) {
  const records: RuleEntry[] = []
  const setNames = new Map(config.sets.map((set) => [set.id, set.name]))
  for (const policy of config.policies) {
    for (const rule of policy.rules) {
      const source: EntrySource = { kind: 'rule', id: rule.id, name: rule.name, scope: policy.name, scopeId: policy.id, enabled: rule.enabled }
      rule.matches.forEach(({ type, value }, index) => {
        records.push({ source, index, type: MATCH_ENTRY_TYPE[type], matchType: type, value, referenceName: type === 'set' ? setNames.get(value) : undefined })
      })
    }
  }
  for (const set of config.sets) {
    const source: EntrySource = { kind: 'set', id: set.id, name: set.name, fromUrl: set.source.type === 'url' }
    set.entries.forEach((value, index) => {
      if (!isSetPreviewMarker(value)) records.push({ source, index, type: setEntryType(set.kind, value), value })
    })
  }
  return records
}

export function filterRuleEntries(records: readonly RuleEntry[], type: EntryFilter, query: string) {
  const needle = query.trim().toLowerCase()
  return records.filter((entry) => (type === 'all' || entry.type === type) && (
    entry.value.toLowerCase().includes(needle) || entry.referenceName?.toLowerCase().includes(needle)
  ))
}

export const ENTRY_TYPE_LABEL = { domain: 'Домен', ip: 'IP-адрес', cidr: 'Подсеть (CIDR)', reference: 'Ссылка', port: 'Порт' } as const

function ipBits(address: string) {
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address) && address.split('.').every((part) => Number(part) <= 255)) return 32
  if (!address.includes(':') || !/^[a-f\d:.]+$/i.test(address)) return 0
  try {
    return new URL(`http://[${address}]/`).hostname.startsWith('[') ? 128 : 0
  } catch {
    return 0
  }
}

export function validateSetEntry(kind: NamedSet['kind'], input: string): { value: string } | { error: string } {
  const value = input.trim().toLowerCase()
  if (!value) return { error: 'Введите значение.' }
  if (kind === 'domains') {
    if (value.length > 253 || !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/.test(value)) {
      return { error: 'Введите домен в формате example.com.' }
    }
    return { value }
  }
  const [address, prefix, ...rest] = value.split('/')
  const bits = ipBits(address)
  if (rest.length || !bits || (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > bits))) {
    return { error: 'Введите IP-адрес или подсеть в формате 192.0.2.0/24.' }
  }
  return { value }
}
