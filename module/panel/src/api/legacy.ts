import type {
  Action, Config, Coverage, Device, DnsPolicy, DnsServer, EngineId, Family, GamePreset, Match, NamedSet, Policy, Profile,
  Proto, Rule, Runtime, SavedCheck, Segment, Subscription, Topology, ZapretServiceId,
} from './contract'

export interface LegacyRule {
  name: string
  domain?: string
  exact?: boolean
  match?: string
  cidr?: string
  geoIP?: string
  geoSite?: string
  geoSource?: string
  set?: string
  disabled?: boolean
  network?: string
  port?: number
  target: string
}

export interface LegacyDevice {
  mac: string
  label?: string
  addresses?: string[]
  mode?: string
  defaultTarget?: string
  rules?: LegacyRule[]
}

export interface LegacyProfile {
  xrayGroup?: boolean
  groupSize?: number
  id: string
  protocol: Profile['protocol']
  label?: string
  location?: string
  server?: string
  awgVersion?: string
  awgNative?: boolean
  awgConfig?: string
  interface?: string
  uri?: string
  outbound?: unknown
  subscriptionId?: string
  upstreamName?: string
  upstreamKey?: string
  subscriptionMissing?: boolean
}

export interface LegacyGeoSource { id: string; name: string; asset: string; repository: string; frequency: number; auto: boolean }
type LegacyNamedSet = Omit<NamedSet, 'source'>

export interface LegacyPlan {
  revision: string
  panelHost?: string
  panelNetwork?: string
  defaultTarget?: string
  rules: LegacyRule[]
  profiles: LegacyProfile[]
  devices?: LegacyDevice[]
  transparent?: { interface: string; source: string; mode?: string }
  geoSources?: LegacyGeoSource[]
  namedSets?: LegacyNamedSet[]
  savedChecks?: SavedCheck[]
  games?: GamePreset[]
  subscriptions?: Subscription[]
}

export interface LegacyPlanUpdate {
  revision: string
  rules: LegacyRule[]
  profiles: LegacyProfile[]
  devices: LegacyDevice[]
  defaultTarget: string
  geoSources?: LegacyGeoSource[]
  namedSets?: LegacyNamedSet[]
  savedChecks?: SavedCheck[]
  games?: GamePreset[]
}

export interface LegacyRuntime {
  vpn: NonNullable<Runtime['vpn']>
  xrayVersion?: string
  zapret: {
    available: boolean
    youtube: { enabled: boolean; strategy: string }
    discord: { enabled: boolean; strategy: string }
    strategies: { id: string; label: string; services: ZapretServiceId[] }[]
  }
  boot: { vpn: boolean; profile: string; zapretYouTube: boolean; zapretDiscord: boolean }
  lan: boolean
}

export interface LegacyDNS {
  protocol: 'plain' | 'doh' | 'dot'
  primary: string
  secondary: string
  cache: boolean
  adblock: boolean
  lan?: boolean
  lists: string[]
  exceptions: string[]
  enabled: boolean
  lanAvailable: boolean
  lanActive: boolean
  error?: string
}

export interface LegacyInventory {
  neighbors: { mac: string; address: string; label: string; fixed: boolean }[]
  configured: { mac: string; active: boolean; mode?: string; reason?: string }[]
}

export const GLOBAL_ID = 'global'
export const DNS_ID = 'router-dns'
export const WAN_ID = 'isp-main'
export const dateUnknown = '1970-01-01T00:00:00Z'
export const noCapability = { available: false, reason: 'Эта операция недоступна в текущем режиме RouteHub.' }
export const zapretIds = ['youtube', 'discord'] as const
export const directAction: Action = { kind: 'direct', uplinkId: WAN_ID }
const inherit: Action = { kind: 'inherit' }

export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function family(value: string): Family {
  return value.includes(':') ? 'v6' : 'v4'
}

export function fromTarget(target = 'direct'): Action {
  if (target === 'direct') return directAction
  if (target === '@block') return { kind: 'block' }
  if (target === '@vpn') return { kind: 'vpn', target: { type: 'primary' } }
  if (target === 'zapret') return { kind: 'zapret', strategyId: '', exit: 'direct' }
  return { kind: 'vpn', target: { type: 'profile', profileId: target } }
}

export function toTarget(action: Action): string {
  switch (action.kind) {
    case 'keenetic': throw new Error('Выбор отдельной политики Keenetic недоступен. Используйте обычный WAN.')
    case 'direct':
      if (action.uplinkId !== WAN_ID) throw new Error('Выбор физического WAN для правила в текущем режиме недоступен.')
      return 'direct'
    case 'block': return '@block'
    case 'vpn':
      if (action.target.type === 'group') throw new Error('Группы VPN не поддерживаются текущим обработчиком маршрутов.')
      return action.target.type === 'primary' ? '@vpn' : action.target.profileId
    case 'zapret':
      if (action.strategyId || action.exit !== 'direct') throw new Error('Отдельная стратегия Zapret в произвольном правиле недоступна.')
      return 'zapret'
    case 'inherit': throw new Error('Выберите явное действие для правила.')
  }
}

export function fromRule(source: LegacyRule, id: string): Rule {
  const matches: Match[] = []
  let condition: string | undefined
  if (source.domain) {
    const mode = source.match ?? (source.exact ? 'exact' : 'auto')
    condition = ['keyword', 'regex', 'wildcard'].includes(mode) ? mode : undefined
    matches.push({
      type: mode === 'exact' ? 'domain' : 'suffix',
      value: source.domain,
      ...(condition ? { legacyMode: condition } : {}),
    })
  }
  if (source.cidr) matches.push({
    type: /\/(?:32|128)$/.test(source.cidr) && source.cidr.endsWith(family(source.cidr) === 'v4' ? '/32' : '/128') ? 'ip' : 'cidr',
    value: source.cidr.replace(family(source.cidr) === 'v4' ? /\/32$/ : /\/128$/, ''),
  })
  if (source.geoIP) matches.push({ type: 'geoip', value: source.geoIP, geoSource: source.geoSource })
  if (source.geoSite) matches.push({ type: 'geosite', value: source.geoSite, geoSource: source.geoSource })
  if (source.set) matches.push({ type: 'set', value: source.set })
  const protos: Proto[] = source.network === 'tcp' || source.network === 'udp' ? [source.network] : ['tcp', 'udp']
  return {
    id, name: source.name,
    matches,
    families: source.cidr ? [family(source.cidr)] : ['v4', 'v6'],
    protos,
    ...(source.port ? { ports: String(source.port) } : {}),
    action: fromTarget(source.target),
    enabled: !source.disabled,
    source: { type: 'migration' },
    ...(condition ? { note: `Условие RouteHub · ${condition}` } : {}),
  }
}

export function revisionKey(value: string): number {
  // An exact opaque plan token remains in the HTTP request. The numeric key is
  // only a compact identity for the supplied panel's revision UI.
  let upper = 0x811c9dc5
  let lower = 0x9e3779b9
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    upper = Math.imul(upper ^ code, 0x01000193)
    lower = Math.imul(lower ^ code, 0x85ebca6b)
  }
  return (upper >>> 12) * 2 ** 32 + (lower >>> 0)
}

function ruleList(rules: LegacyRule[], policyId: string): Rule[] {
  const duplicates = new Map<number, number>()
  return rules.map((rule) => {
    // A temporary activation change must preserve the row and its focus.
    const hash = revisionKey(JSON.stringify({ ...rule, disabled: undefined }))
    const index = duplicates.get(hash) ?? 0
    duplicates.set(hash, index + 1)
    return fromRule(rule, `${policyId}-${hash.toString(36)}-${index}`)
  })
}

function toRule(rule: Rule, old: LegacyRule | undefined, plan: LegacyPlan): LegacyRule[] {
  if (old && same(fromRule(old, rule.id), rule)) return [old]
  if (!rule.protos.length || !rule.families.length) throw new Error('Выберите семейство IP и транспорт для каждого правила.')
  const target = toTarget(rule.action)
  const ports = rule.ports?.trim() ?? ''
  const port = ports ? Number(ports) : 0
  if (ports && (!/^\d+$/.test(ports) || port < 1 || port > 65535)) throw new Error('В правиле можно задать один порт от 1 до 65535.')
  const base: LegacyRule = {
    name: rule.name,
    target,
    ...(rule.enabled ? {} : { disabled: true }),
    ...(rule.protos.length === 1 ? { network: rule.protos[0] } : {}),
  }
  if (old && same(fromRule(old, rule.id).matches, rule.matches) && same(fromRule(old, rule.id).families, rule.families)) {
    const unchanged = { ...old, ...base, disabled: !rule.enabled, network: base.network, port: port || undefined }
    return [unchanged]
  }
  if (!rule.matches.length) throw new Error('Добавьте домен, IP, подсеть, набор или условие GeoIP/GeoSite.')
  return rule.matches.map((match, index) => {
    const unique = rule.matches.length > 1 ? `${base.name} · ${index + 1}` : base.name
    const next: LegacyRule = { ...base, name: unique, ...(port ? { port } : {}) }
    if (!['ip', 'cidr'].includes(match.type) && rule.families.length !== 2) {
      throw new Error('Ограничение по семейству IP применяется только к IP-адресам и подсетям.')
    }
    switch (match.type) {
      case 'domain':
        return { ...next, domain: match.value, exact: true, match: 'exact' }
      case 'suffix':
        return { ...next, domain: match.value, match: match.legacyMode ?? (match.value.startsWith('*.') ? 'wildcard' : 'suffix') }
      case 'ip':
      case 'cidr': {
        if (!rule.families.includes(family(match.value))) throw new Error('Семейство адреса не совпадает с настройками правила.')
        return { ...next, cidr: match.value.includes('/') ? match.value : `${match.value}/${family(match.value) === 'v4' ? 32 : 128}` }
      }
      case 'geoip':
      case 'geosite': {
        const [prefix, ...parts] = match.value.split(':')
        const value = ['geoip', 'geosite'].includes(prefix) ? parts.join(':') : match.value
        const geoSource = match.geoSource ?? plan.geoSources?.find((item) => item.asset.toLowerCase().includes(match.type))?.id
        if (!geoSource) throw new Error('Источник геоданных для выбранного условия не настроен.')
        return match.type === 'geoip' ? { ...next, geoIP: value, geoSource } : { ...next, geoSite: value, geoSource }
      }
      case 'port': throw new Error('Порт задаётся дополнительно к домену, IP или подсети в настройках протокола правила.')
      case 'set': return { ...next, set: match.value }
    }
  })
}

export function fromProfile(source: LegacyProfile): Profile {
  const engine: EngineId = source.protocol === 'awg' ? source.interface || source.awgNative ? 'awg-keenetic' : 'awg-routehub' : 'xray'
  const upstreamName = source.upstreamName || source.label || source.id
  return {
    id: source.id,
    name: upstreamName,
    ...(source.subscriptionId && source.label && source.label !== upstreamName ? { alias: source.label } : {}),
    tags: [],
    protocol: source.protocol,
    xrayGroup: source.xrayGroup,
    groupSize: source.groupSize,
    transport: source.protocol === 'awg' ? `AWG${source.awgVersion ? ` ${source.awgVersion}` : ''}` : source.protocol === 'hysteria2' ? 'QUIC' : '',
    server: source.server ?? '',
    country: source.location ?? '',
    origin: source.subscriptionId ? {
      type: 'subscription',
      subscriptionId: source.subscriptionId,
      upstreamName,
      upstreamKey: source.upstreamKey ?? source.id,
    } : { type: 'manual' },
    adapter: { mode: 'auto', engine, reason: 'По типу сохранённого профиля RouteHub' },
    enabled: true,
    favorite: false,
    lifecycle: source.subscriptionMissing ? 'missing-upstream' : 'active',
  }
}

export function knownSegment(plan: LegacyPlan): Segment | undefined {
  const lan = plan.transparent
  if (!lan) return undefined
  return {
    id: lan.interface,
    name: lan.interface,
    iface: lan.interface,
    kind: lan.interface.startsWith('br') ? 'bridge' : 'l3',
    v4: [lan.source],
    v6: [],
    ssidIds: [],
    state: 'up',
    routable: { available: true },
    isolation: 'Управляется KeeneticOS',
  }
}

export function makeTopology(plan: LegacyPlan, inventory: LegacyInventory, at: string): Topology {
  const segment = knownSegment(plan)
  if (!segment) return { segments: [], devices: [], ssids: [], fetchedAt: at }
  const devices = new Map<string, Device>()
  const addressesByMac = new Map((plan.devices ?? []).map((item) => [item.mac.toLowerCase(), new Set(item.addresses ?? [])]))
  const owners = new Map<string, Set<string>>()
  for (const row of inventory.neighbors) {
    const seen = owners.get(row.address) ?? new Set()
    seen.add(row.mac.toLowerCase())
    owners.set(row.address, seen)
  }
  function ensureDevice(mac: string, label: string): Device {
    const id = mac.toLowerCase()
    const existing = devices.get(id)
    if (existing) return existing
    const device: Device = {
      id, mac: id, hostname: label || id, vendor: '', kind: 'unknown', segmentId: segment!.id,
      addresses: [], binding: 'observed', online: false, lastSeen: dateUnknown, connectionKnown: false,
    }
    devices.set(id, device)
    return device
  }
  for (const row of inventory.neighbors) {
    const device = ensureDevice(row.mac, row.label)
    const unambiguous = owners.get(row.address)?.size === 1
    const confirmed = row.fixed && unambiguous
    if (!device.addresses.some(({ addr }) => addr === row.address)) {
      device.addresses.push({ addr: row.address, family: 'v4', confirmed, source: row.fixed ? 'static' : 'arp' })
    }
    if (!unambiguous) device.binding = 'ambiguous'
    else if (confirmed && device.binding !== 'ambiguous') device.binding = 'confirmed'
  }
  for (const row of plan.devices ?? []) {
    const device = ensureDevice(row.mac, row.label ?? '')
    const configured = inventory.configured.find(({ mac }) => mac.toLowerCase() === device.id)
    if (configured && !configured.active && configured.mode !== 'global' && !device.addresses.some(({ addr, confirmed }) => confirmed && addressesByMac.get(device.id)?.has(addr))) {
      if (device.binding !== 'ambiguous') device.binding = 'lost'
      if (configured.reason) device.bindingNote = configured.reason
    }
    for (const addr of row.addresses ?? []) {
      if (!device.addresses.some((entry) => entry.addr === addr)) device.addresses.push({ addr, family: 'v4', confirmed: false, source: 'static' })
    }
  }
  return { segments: [segment], devices: [...devices.values()], ssids: [], fetchedAt: at }
}

function policy(id: string, name: string, kind: Policy['kind'], parentId: string | null, defaultAction: Action, rules: LegacyRule[]): Policy {
  return { id, name, kind, parentId, defaultAction, rules: ruleList(rules, id), disabledParentRuleIds: [], fallbackOverride: null }
}

export function projectConfig(plan: LegacyPlan, runtime: LegacyRuntime | null, dns: LegacyDNS | null): Config {
  const primaryProfileId = runtime?.vpn.profile ?? ''
  const segment = knownSegment(plan)
  const root = policy(GLOBAL_ID, 'Общие правила', 'global', null, fromTarget(plan.defaultTarget), plan.rules ?? [])
  const devicePolicies: Config['devicePolicies'] = []
  const policies = [root]
  for (const device of plan.devices ?? []) {
    const id = device.mac.toLowerCase()
    const alias = device.label || undefined
    const ipv4Bindings = device.addresses ?? []
    const fixed = device.mode === 'fixed'
    const global = device.mode === 'global' || (!device.mode && !device.rules?.length)
    const independent = device.mode === 'override'
    const devicePolicyId = !global && !fixed || device.rules?.length ? `device-${id}` : undefined
    if (devicePolicyId) {
      policies.push(policy(devicePolicyId, alias || id, 'device', independent ? null : GLOBAL_ID, independent ? fromTarget(device.defaultTarget) : inherit, device.rules ?? []))
    }
    if (global) {
      devicePolicies.push({ deviceId: id, alias, ipv4Bindings, mode: 'inherit-actual', policyId: devicePolicyId })
    } else if (fixed) {
      devicePolicies.push({ deviceId: id, alias, ipv4Bindings, mode: 'fixed-exit', policyId: devicePolicyId, fixedExit: fromTarget(device.defaultTarget) })
    } else {
      devicePolicies.push({ deviceId: id, alias, ipv4Bindings, mode: independent ? 'independent' : 'local-overrides', policyId: devicePolicyId })
    }
  }
  const resolver = dns && (dns.enabled || dns.primary) ? {
    id: DNS_ID,
    name: 'Резолвер RouteHub',
    segmentIds: segment ? [segment.id] : [],
    managed: dns.enabled,
    primary: { protocol: dns.protocol === 'plain' ? 'udp' as const : dns.protocol, address: dns.primary, via: directAction },
    fallback: dns.secondary ? { protocol: dns.protocol === 'plain' ? 'udp' as const : dns.protocol, address: dns.secondary, via: directAction } : null,
    fallbackDirectAllowed: true,
    cache: dns.cache,
    filteringEnabled: dns.adblock,
    blocklists: dns.lists ?? [],
    exceptions: dns.exceptions ?? [],
    lan: Boolean(dns.lan),
  } : null
  const autostart = {
    vpn: runtime?.boot.vpn ?? false,
    zapret: Boolean(runtime?.boot.zapretYouTube || runtime?.boot.zapretDiscord),
    profileId: runtime?.boot.profile ?? '',
    zapretYouTube: runtime?.boot.zapretYouTube ?? false,
    zapretDiscord: runtime?.boot.zapretDiscord ?? false,
    dns: dns?.enabled ?? false,
    initialPolicy: 'last-applied' as const,
    waitForWanSec: 0,
  }
  const zapret = runtime ? zapretIds.map((id) => ({
    id, enabled: runtime.zapret[id].enabled, strategyId: runtime.zapret[id].strategy,
    segmentIds: [], failAction: inherit,
  })) : []
  const revision = revisionKey(JSON.stringify([plan.revision, primaryProfileId, autostart, resolver, zapret, runtime?.boot]))
  return {
    revision, policies,
    segmentPolicies: segment ? [{ segmentId: segment.id, mode: 'managed', policyId: GLOBAL_ID }] : [],
    devicePolicies, profiles: (plan.profiles ?? []).map((item) => fromProfile(item)),
    dns: resolver ? [resolver] : [], zapret, autostart, primaryProfileId,
    sets: (plan.namedSets ?? []).map((set) => ({ ...set, entries: set.entries ?? [], source: { type: 'manual' } })),
    deviceGroups: [], exitGroups: [], subscriptions: plan.subscriptions ?? [], games: plan.games ?? [], checks: plan.savedChecks ?? [],
  }
}

function encodeRules(policy: Policy, originals: Map<string, LegacyRule>, plan: LegacyPlan): LegacyRule[] {
  return policy.rules.flatMap((rule) => toRule(rule, originals.get(rule.id), plan))
}

function encodeDevice(entry: Config['devicePolicies'][number], candidate: Config, before: LegacyPlan, inventory: LegacyInventory, originals: Map<string, LegacyRule>): LegacyDevice {
  const old = before.devices?.find(({ mac }) => mac.toLowerCase() === entry.deviceId)
  if (entry.mode === 'inherit-selected' || entry.sourcePolicyId && entry.sourcePolicyId !== GLOBAL_ID) throw new Error('Текущее ядро поддерживает только наследование общей политики.')
  if (entry.mode === 'inherit-actual' && old?.mode === 'global' && !entry.policyId && same(entry.ipv4Bindings ?? [], old.addresses ?? [])) {
    return { ...old, label: entry.alias }
  }
  const kinds = { 'inherit-actual': 'global', 'local-overrides': 'inherit', independent: 'override', 'fixed-exit': 'fixed' } as const
  const devicePolicy = candidate.policies.find(({ id }) => id === entry.policyId)
  const mode = kinds[entry.mode]
  if (devicePolicy && (devicePolicy.disabledParentRuleIds.length || devicePolicy.fallbackOverride)) throw new Error('Отключение унаследованных правил и резерв устройства в текущем режиме недоступны.')
  const verified = [...new Set(inventory.neighbors.filter(({ mac, fixed, address }) =>
    mac.toLowerCase() === entry.deviceId && fixed &&
    !inventory.neighbors.some((row) => row.address === address && row.mac.toLowerCase() !== entry.deviceId)).map(({ address }) => address))]
  const previousBindings = old?.addresses ?? []
  const requestedBindings = entry.ipv4Bindings ?? previousBindings
  const addresses = !same(requestedBindings, previousBindings) ? requestedBindings : previousBindings.length ? previousBindings : verified
  if (!same(addresses, old?.addresses ?? []) && addresses.some((address) => !verified.includes(address))) {
    throw new Error('Один из выбранных IPv4-адресов сейчас не закреплён за этим устройством в KeeneticOS.')
  }
  if (mode !== 'global' && !addresses.length) throw new Error('Сначала закрепите IPv4-адрес этого устройства в KeeneticOS.')
  const action = entry.fixedExit ?? devicePolicy?.defaultAction
  if ((mode === 'override' || mode === 'fixed') && !action) throw new Error('Выберите маршрут по умолчанию для устройства.')
  if (mode === 'inherit' && devicePolicy?.defaultAction.kind !== 'inherit') throw new Error('Локальные правила используют общий маршрут по умолчанию.')
  return {
    mac: entry.deviceId, label: entry.alias, mode, addresses,
    ...(action && (mode === 'override' || mode === 'fixed') ? { defaultTarget: toTarget(action) } : {}),
    rules: devicePolicy ? encodeRules(devicePolicy, originals, before) : old?.rules ?? [],
  }
}

export function encodePlan(candidate: Config, base: Config, before: LegacyPlan, inventory: LegacyInventory, imports: Map<string, LegacyProfile>): LegacyPlanUpdate {
  const root = candidate.policies.find(({ id }) => id === GLOBAL_ID)
  if (!root || root.parentId || root.disabledParentRuleIds.length || root.fallbackOverride) throw new Error('Общая политика должна существовать без родителя и резервного выхода.')
  const unexpected = candidate.policies.find((item) => item.id !== GLOBAL_ID &&
    (item.kind !== 'device' || !candidate.devicePolicies.some(({ policyId }) => item.id === policyId)))
  if (unexpected) throw new Error('Текущее ядро поддерживает общую политику и правила отдельных устройств.')
  const namedSets = candidate.sets.map(({ source, ...set }) => {
    if (source.type !== 'manual') throw new Error('На роутере доступны ручные наборы.')
    return set
  })
  // Rule ids originate in the source scope. A move keeps the original
  // representation, including the legacy domain mode and port.
  const originals = new Map<string, LegacyRule>()
  function rememberRules(policyId: string, rules: LegacyRule[]) {
    ruleList(rules, policyId).forEach(({ id }, index) => originals.set(id, rules[index]))
  }
  rememberRules(GLOBAL_ID, before.rules ?? [])
  for (const device of before.devices ?? []) rememberRules(`device-${device.mac.toLowerCase()}`, device.rules ?? [])
  const profiles = candidate.profiles.map((entry) => {
    const old = before.profiles.find(({ id }) => id === entry.id)
    if (!old) {
      const imported = imports.get(entry.id)
      if (!imported) throw new Error('Заново откройте импорт и подтвердите профиль.')
      return { ...imported, id: entry.id, label: entry.alias || entry.name, location: entry.country }
    }
    const prev = base.profiles.find(({ id }) => id === entry.id)!
    const { name: _n, alias: _a, country: _c, ...oldSettings } = prev
    const { name: _newN, alias: _newA, country: _newC, ...settings } = entry
    if (!same(oldSettings, settings)) throw new Error('Текущее ядро позволяет изменять только имя и локацию существующего профиля.')
    return { id: old.id, protocol: old.protocol, label: entry.alias || entry.name, location: entry.country }
  })
  return {
    revision: before.revision,
    profiles,
    rules: encodeRules(root, originals, before),
    devices: candidate.devicePolicies.map((entry) => {
      const previous = base.devicePolicies.find(({ deviceId }) => deviceId === entry.deviceId)
      const previousPolicy = base.policies.find(({ id }) => id === previous?.policyId)
      const nextPolicy = candidate.policies.find(({ id }) => id === entry.policyId)
      const legacy = before.devices?.find(({ mac }) => mac.toLowerCase() === entry.deviceId)
      return legacy && same(entry, previous) && same(previousPolicy, nextPolicy)
        ? legacy : encodeDevice(entry, candidate, before, inventory, originals)
    }),
    defaultTarget: toTarget(root.defaultAction),
    ...(!same(candidate.sets, base.sets) ? { namedSets } : {}),
    ...(candidate.checks.length || before.savedChecks?.length ? { savedChecks: candidate.checks } : {}),
    ...(!same(candidate.games, base.games) ? { games: candidate.games } : {}),
  }
}

function dnsAddress(server: DnsServer) {
  if (server.via.kind !== 'direct' && server.via.kind !== 'keenetic') throw new Error('Текущий DNS-резолвер работает через обычный WAN.')
  return server.protocol === 'dot' ? server.address.replace(/^tls:\/\//i, '') : server.address
}

export function encodeDNS(policy: DnsPolicy, previous: DnsPolicy) {
  if (!policy.managed || !same(policy.segmentIds, previous.segmentIds)) throw new Error('DNS действует только в единственной настроенной сети.')
  if (policy.fallback && policy.fallback.protocol !== policy.primary.protocol) throw new Error('Основной и резервный DNS должны использовать один протокол.')
  if (policy.fallback && !policy.fallbackDirectAllowed) throw new Error('DNS через VPN недоступен в текущем режиме.')
  return {
    protocol: policy.primary.protocol === 'udp' ? 'plain' : policy.primary.protocol,
    primary: dnsAddress(policy.primary),
    secondary: policy.fallback ? dnsAddress(policy.fallback) : '',
    cache: policy.cache,
    adblock: policy.filteringEnabled ?? policy.blocklists.length > 0,
    lan: policy.lan ?? false,
    lists: policy.blocklists,
    exceptions: policy.exceptions,
  }
}

export function untestedCoverage(): Coverage {
  return { v4tcp: { state: 'untested' }, v4udp: { state: 'untested' }, v6tcp: { state: 'untested' }, v6udp: { state: 'untested' } }
}
