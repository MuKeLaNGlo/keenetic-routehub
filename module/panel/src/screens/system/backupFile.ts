/**
 * Full-config copy with redacted secrets.
 *
 * The file keeps the shape of `Config` (plus a small envelope with the format
 * version and the number of masked fields) so a copy can be inspected against
 * the router's current config before anything is changed.
 */
import type { Action, Config, EntityChange } from '@/api/contract'
import { COLLECTIONS, COLLECTION_LABEL, diffConfig, entityId } from '@/lib/configDiff'
import { count } from '@/lib/format'

export const MASK = '••••'
const FORMAT = 'routehub-config-copy'
const FORMAT_VERSION = 1

const SECRET_KEY = /(secret|password|passwd|token|uuid|private_?key|pbk|psk|^server$|^url$)/i

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function maskWalk(v: unknown, key = ''): { value: unknown; masked: number } {
  if (Array.isArray(v)) {
    let masked = 0
    const value = v.map((x) => {
      const r = maskWalk(x)
      masked += r.masked
      return r.value
    })
    return { value, masked }
  }
  if (isRecord(v)) {
    let masked = 0
    const value: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      const r = maskWalk(val, k)
      masked += r.masked
      value[k] = r.value
    }
    return { value, masked }
  }
  if (typeof v === 'string' && key && SECRET_KEY.test(key) && v.length > 0 && !v.includes(MASK)) {
    const at = v.indexOf('://')
    return { value: at >= 0 ? `${v.slice(0, at + 3)}${MASK}` : MASK, masked: 1 }
  }
  return { value: v, masked: 0 }
}

/** Config with every secret-looking value replaced; the count drives the UI hint. */
export function maskConfig(config: Config): { config: Config; masked: number } {
  const { value, masked } = maskWalk(config)
  return { config: value as Config, masked }
}

export function exportCopy(config: Config): { text: string; masked: number; bytes: number } {
  const { config: maskedConfig, masked } = maskConfig(config)
  const envelope = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    revision: config.revision,
    secretsRedacted: true,
    redactedFields: masked,
    config: maskedConfig,
  }
  const text = JSON.stringify(envelope, null, 2)
  return { text, masked, bytes: new Blob([text]).size }
}

export function copyFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `routehub-config-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`
}

export function downloadJson(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* ───────────────────────────── reading a copy ───────────────────────────── */

export interface CopyError {
  error: string
}

function missingSections(raw: Record<string, unknown>): string[] {
  return COLLECTIONS.filter((k) => !Array.isArray(raw[k])).map((k) => COLLECTION_LABEL[k])
}

function isConfig(v: unknown): v is Config {
  if (!isRecord(v)) return false
  if (typeof v.revision !== 'number' || typeof v.primaryProfileId !== 'string') return false
  if (!isRecord(v.autostart)) return false
  const a = v.autostart
  if (typeof a.vpn !== 'boolean' || typeof a.zapret !== 'boolean' || typeof a.dns !== 'boolean') return false
  if (!['last-applied', 'direct-until-vpn', 'suspend-until-vpn'].includes(String(a.initialPolicy))) return false
  if (typeof a.waitForWanSec !== 'number') return false
  return COLLECTIONS.every((k) => Array.isArray(v[k]))
}

function countMasked(v: unknown): number {
  if (typeof v === 'string') return v.includes(MASK) ? 1 : 0
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + countMasked(x), 0)
  if (isRecord(v)) return Object.values(v).reduce<number>((n, x) => n + countMasked(x), 0)
  return 0
}

export interface ParsedCopy {
  config: Config
  /** Copy metadata, when the file carries the envelope. */
  meta: { formatVersion: number | null; exportedAt: string | null; secretsRedacted: boolean }
  maskedFields: number
}

export function parseCopy(text: string): ParsedCopy | CopyError {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { error: `Файл не читается как JSON: ${(e as Error).message}` }
  }
  if (!isRecord(raw)) return { error: 'Файл не похож на копию конфигурации RouteHub' }

  const envelope = isRecord(raw.config) ? raw : null
  const body = envelope ? envelope.config : raw
  const formatVersion = envelope && typeof envelope.formatVersion === 'number' ? envelope.formatVersion : null

  if (formatVersion !== null && formatVersion > FORMAT_VERSION)
    return { error: `Копия создана более новой версией RouteHub (формат ${formatVersion}); эта панель понимает формат ${FORMAT_VERSION}` }

  if (isRecord(body)) {
    const missing = missingSections(body)
    if (missing.length) return { error: `В файле нет разделов: ${missing.join(', ')} — это не полная копия конфигурации` }
  }
  if (!isConfig(body))
    return { error: 'Структура файла не совпадает с конфигурацией RouteHub: проверьте разделы, автозапуск и основной профиль' }

  return {
    config: body,
    meta: {
      formatVersion,
      exportedAt: envelope && typeof envelope.exportedAt === 'string' ? envelope.exportedAt : null,
      secretsRedacted: !!(envelope && envelope.secretsRedacted === true),
    },
    maskedFields: envelope && typeof envelope.redactedFields === 'number' ? envelope.redactedFields : countMasked(body),
  }
}

/* ───────────────────────────── inspection ───────────────────────────── */

export interface CopyInspection {
  /** Blocking problems: the copy cannot be loaded. */
  problems: string[]
  /** Things the operator must know before loading. */
  warnings: string[]
  changes: EntityChange[]
}

function checkAction(a: Action, where: string, ctx: { profiles: Set<string>; groups: Set<string> }): string[] {
  if (a.kind === 'vpn') {
    if (a.target.type === 'profile' && !ctx.profiles.has(a.target.profileId)) return [`${where}: правило ссылается на отсутствующий профиль «${a.target.profileId}»`]
    if (a.target.type === 'group' && !ctx.groups.has(a.target.groupId)) return [`${where}: правило ссылается на отсутствующую группу выходов «${a.target.groupId}»`]
  }
  return []
}

/** Duplicate ids, dangling references and the change volume against the current config. */
export function inspectCopy(candidate: Config, server: Config, meta: ParsedCopy['meta'], maskedFields: number): CopyInspection {
  const problems: string[] = []
  const warnings: string[] = []

  for (const c of COLLECTIONS) {
    const ids = (candidate[c] as unknown as Record<string, unknown>[]).map((e) => entityId(c, e))
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (dupes.length) problems.push(`${COLLECTION_LABEL[c]}: повторяющиеся идентификаторы — ${[...new Set(dupes)].join(', ')}`)
  }

  const policyIds = new Set(candidate.policies.map((p) => p.id))
  const profileIds = new Set(candidate.profiles.map((p) => p.id))
  const groupIds = new Set(candidate.exitGroups.map((g) => g.id))
  const setIds = new Set(candidate.sets.map((s) => s.id))

  for (const p of candidate.policies) {
    if (p.parentId && !policyIds.has(p.parentId)) problems.push(`Политика «${p.name}»: родительская политика «${p.parentId}» отсутствует`)
    problems.push(...checkAction(p.defaultAction, `Политика «${p.name}»`, { profiles: profileIds, groups: groupIds }))
    if (p.fallbackOverride) problems.push(...checkAction(p.fallbackOverride, `Политика «${p.name}» (запасной маршрут)`, { profiles: profileIds, groups: groupIds }))
    for (const r of p.rules) {
      problems.push(...checkAction(r.action, `Правило «${r.name}»`, { profiles: profileIds, groups: groupIds }))
      for (const m of r.matches) if (m.type === 'set' && !setIds.has(m.value)) problems.push(`Правило «${r.name}»: набор «${m.value}» отсутствует`)
    }
  }
  for (const sp of candidate.segmentPolicies)
    if (!policyIds.has(sp.policyId)) problems.push(`Сеть «${sp.segmentId}»: политика «${sp.policyId}» отсутствует`)
  for (const dp of candidate.devicePolicies) {
    if (dp.policyId && !policyIds.has(dp.policyId)) problems.push(`Устройство «${dp.deviceId}»: политика «${dp.policyId}» отсутствует`)
    if (dp.sourcePolicyId && !policyIds.has(dp.sourcePolicyId)) problems.push(`Устройство «${dp.deviceId}»: исходная политика «${dp.sourcePolicyId}» отсутствует`)
    if (dp.fixedExit) problems.push(...checkAction(dp.fixedExit, `Устройство «${dp.deviceId}»`, { profiles: profileIds, groups: groupIds }))
  }
  for (const g of candidate.deviceGroups) if (!policyIds.has(g.policyId)) problems.push(`Группа устройств «${g.name}»: политика «${g.policyId}» отсутствует`)
  for (const g of candidate.exitGroups) {
    for (const m of g.memberIds) if (!profileIds.has(m)) problems.push(`Группа «${g.name}»: профиль «${m}» отсутствует`)
    if (g.pin && !profileIds.has(g.pin.profileId)) problems.push(`Группа «${g.name}»: закреплённый профиль «${g.pin.profileId}» отсутствует`)
    if (g.failAction.kind === 'group' && !groupIds.has(g.failAction.groupId)) problems.push(`Группа «${g.name}»: запасная группа «${g.failAction.groupId}» отсутствует`)
  }
  for (const dp of candidate.dns) for (const srv of [dp.primary, dp.fallback]) if (srv) problems.push(...checkAction(srv.via, `DNS «${dp.name}»`, { profiles: profileIds, groups: groupIds }))

  if (candidate.revision !== server.revision)
    warnings.push(`Копия снята с r${candidate.revision}, на роутере сейчас r${server.revision}. Совпадающие разделы заменятся содержимым копии.`)
  if (meta.exportedAt) warnings.push(`Файл создан ${new Date(meta.exportedAt).toLocaleString('ru-RU')}.`)
  if (maskedFields > 0)
    warnings.push(
      `В копии ${count(maskedFields, ['замаскированное поле', 'замаскированных поля', 'замаскированных полей'])}: адреса профилей, ссылки подписок и другие секреты заменены на «••••». После применения такие профили не подключатся, пока вы не введёте секреты заново.`,
    )

  const changes = diffConfig(server, candidate)
  if (changes.length > 20) warnings.push(`Копия меняет ${count(changes.length, ['объект', 'объекта', 'объектов'])}. Просмотрите список перед восстановлением.`)

  return { problems, warnings, changes }
}

/** Copy the settings while retaining the active revision. */
export function applyCopyToConfig(target: Config, source: Config) {
  target.policies = structuredClone(source.policies)
  target.segmentPolicies = structuredClone(source.segmentPolicies)
  target.devicePolicies = structuredClone(source.devicePolicies)
  target.deviceGroups = structuredClone(source.deviceGroups)
  target.sets = structuredClone(source.sets)
  target.profiles = structuredClone(source.profiles)
  target.exitGroups = structuredClone(source.exitGroups)
  target.subscriptions = structuredClone(source.subscriptions)
  target.dns = structuredClone(source.dns)
  target.zapret = structuredClone(source.zapret)
  target.games = structuredClone(source.games)
  target.checks = structuredClone(source.checks)
  target.autostart = structuredClone(source.autostart)
  target.primaryProfileId = source.primaryProfileId
}
