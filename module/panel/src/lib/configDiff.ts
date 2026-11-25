/**
 * Structural diff and three-way rebase of `Config`, keyed by stable entity ids.
 * Shared by the draft store (client) and the mock server (apply plan).
 */
import type { Config, ConfigCollection, EntityChange } from '@/api/contract'

export const COLLECTIONS: ConfigCollection[] = [
  'policies',
  'segmentPolicies',
  'devicePolicies',
  'deviceGroups',
  'sets',
  'profiles',
  'exitGroups',
  'subscriptions',
  'dns',
  'zapret',
  'games',
  'checks',
]

export const COLLECTION_LABEL: Record<EntityChange['collection'], string> = {
  policies: 'Политика',
  segmentPolicies: 'Сеть',
  devicePolicies: 'Устройство',
  deviceGroups: 'Группа устройств',
  sets: 'Набор',
  profiles: 'Профиль',
  exitGroups: 'Группа выходов',
  subscriptions: 'Подписка',
  dns: 'DNS',
  zapret: 'Zapret',
  games: 'Игровой пресет',
  checks: 'Проверка маршрута',
  autostart: 'Автозапуск',
  primaryProfileId: 'Основной профиль',
}

type Entity = Record<string, unknown>

export function entityId(collection: ConfigCollection, e: Entity): string {
  if (collection === 'segmentPolicies') return e.segmentId as string
  if (collection === 'devicePolicies') return e.deviceId as string
  return e.id as string
}

function entityLabel(e: Entity): string {
  return (e.alias as string) ?? (e.name as string) ?? (e.segmentId as string) ?? (e.deviceId as string) ?? (e.id as string)
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What a changed field means to a person. Unknown keys fold into one "прочие параметры". */
const FIELD_LABEL: Record<string, string> = {
  name: 'название',
  alias: 'имя',
  enabled: 'включено',
  paused: 'пауза',
  rules: 'правила',
  disabledParentRuleIds: 'отключённые унаследованные правила',
  defaultAction: 'действие по умолчанию',
  fallbackOverride: 'действие при отказе',
  parentId: 'родительский шаблон',
  mode: 'режим',
  policyId: 'политика',
  sourcePolicyId: 'источник политики',
  fixedExit: 'выход',
  deviceIds: 'устройства',
  segmentIds: 'сети',
  strategyId: 'стратегия',
  failAction: 'действие при отказе',
  members: 'профили группы',
  pinnedProfileId: 'закрепление',
  probe: 'параметры проверок',
  revertToPreferred: 'возврат к предпочтительному',
  engine: 'ядро',
  engineOverride: 'ядро',
  url: 'источник',
  intervalHours: 'интервал',
  primary: 'основной сервер',
  fallback: 'резервный сервер',
  fallbackDirectAllowed: 'прямой резерв',
  cache: 'кэш',
  blocklists: 'списки блокировки',
  exceptions: 'исключения',
  routeAction: 'маршрут',
  priority: 'приоритет',
  scope: 'область',
  expect: 'ожидаемый результат',
  required: 'обязательность',
  target: 'адрес',
  vpn: 'VPN при старте',
  zapret: 'Zapret при старте',
  dns: 'DNS при старте',
  initialPolicy: 'начальная политика',
  waitForWanSec: 'ожидание WAN',
}

/** Changed fields as a person reads them (`fields` itself stays raw keys for logic). */
export function fieldLabels(fields: string[] | undefined): string[] {
  return [...new Set((fields ?? []).map((k) => FIELD_LABEL[k] ?? 'прочие параметры'))]
}

function changedFields(a: Entity, b: Entity): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => !eq(a[k], b[k]))
}

/** Changes that turn `base` into `next`. */
export function diffConfig(base: Config, next: Config): EntityChange[] {
  const out: EntityChange[] = []
  for (const c of COLLECTIONS) {
    const a = new Map((base[c] as unknown as Entity[]).map((e) => [entityId(c, e), e]))
    const b = new Map((next[c] as unknown as Entity[]).map((e) => [entityId(c, e), e]))
    for (const [id, e] of b) {
      const prev = a.get(id)
      if (!prev) out.push({ collection: c, id, op: 'add', label: entityLabel(e) })
      else if (!eq(prev, e)) out.push({ collection: c, id, op: 'change', label: entityLabel(e), fields: changedFields(prev, e) })
    }
    for (const [id, e] of a) if (!b.has(id)) out.push({ collection: c, id, op: 'remove', label: entityLabel(e) })
  }
  if (!eq(base.autostart, next.autostart))
    out.push({ collection: 'autostart', id: 'autostart', op: 'change', label: 'Автозапуск', fields: changedFields(base.autostart as never, next.autostart as never) })
  if (base.primaryProfileId !== next.primaryProfileId)
    out.push({ collection: 'primaryProfileId', id: 'primary', op: 'change', label: 'Основной профиль' })
  return out
}

export interface RebaseResult {
  config: Config
  /** Entities changed both by us and by the other writer: ours were kept, theirs listed here. */
  conflicts: { collection: EntityChange['collection']; id: string; label: string }[]
}

/**
 * Three-way merge: replay `mine` (= changes from `base` to `draft`) onto
 * `theirs`. Entity-level: if the same entity changed on both sides, ours wins
 * and the entity is reported as a conflict for the user to review.
 */
export function rebase(base: Config, draft: Config, theirs: Config): RebaseResult {
  const mine = diffConfig(base, draft)
  const theirChanges = diffConfig(base, theirs)
  const theirKeys = new Set(theirChanges.map((c) => `${c.collection}/${c.id}`))
  const out: Config = structuredClone(theirs)
  const conflicts: RebaseResult['conflicts'] = []

  for (const ch of mine) {
    const key = `${ch.collection}/${ch.id}`
    if (theirKeys.has(key)) conflicts.push({ collection: ch.collection, id: ch.id, label: ch.label })
    if (ch.collection === 'autostart') {
      out.autostart = structuredClone(draft.autostart)
      continue
    }
    if (ch.collection === 'primaryProfileId') {
      out.primaryProfileId = draft.primaryProfileId
      continue
    }
    const coll = ch.collection
    const list = out[coll] as unknown as Entity[]
    const idx = list.findIndex((e) => entityId(coll, e) === ch.id)
    if (ch.op === 'remove') {
      if (idx >= 0) list.splice(idx, 1)
    } else {
      const mineEntity = (draft[coll] as unknown as Entity[]).find((e) => entityId(coll, e) === ch.id)!
      if (idx >= 0) list[idx] = structuredClone(mineEntity)
      else list.push(structuredClone(mineEntity))
    }
  }
  return { config: out, conflicts }
}
