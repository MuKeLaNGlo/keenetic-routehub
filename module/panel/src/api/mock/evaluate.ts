/**
 * Policy evaluator (mock of the daemon's compiler/explainer).
 *
 * Implements the order from docs/DESIGN.md §5 and produces a layered
 * explanation. Pure: everything it needs is passed in.
 */
import type {
  Action,
  Capabilities,
  ClassifiedFlow,
  Config,
  Coverage,
  Family,
  Match,
  Policy,
  Rule,
  Runtime,
  Topology,
  TraceQuery,
  TraceResult,
  TraceStep,
  ZapretServiceId,
} from '../contract'
import { actionLabel, profileName, type LabelCtx } from '@/lib/labels'

/** Tiny stand-in for GeoSite / GeoIP databases. */
const GEOSITE: Record<string, string[]> = {
  'ru-blocked': ['instagram.com', 'facebook.com', 'x.com', 'linkedin.com', 'riotgames.com'],
  'category-ads-all': ['doubleclick.net', 'adservice.google.com', 'ads.example'],
  netflix: ['netflix.com', 'nflxvideo.net'],
  disney: ['disneyplus.com'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'],
  tiktok: ['tiktok.com', 'tiktokcdn.com'],
}
const GEOIP: Record<string, string[]> = { ru: ['95.0.0.0/8', '213.0.0.0/8'] }

const ZAPRET_DOMAINS: Record<ZapretServiceId, string[]> = {
  youtube: ['youtube.com', 'googlevideo.com', 'ytimg.com', 'youtu.be', 'youtubei.googleapis.com'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'],
}

const PROTECTED: { test: (t: string) => boolean; why: string }[] = [
  { test: (t) => t === 'my.keenetic.net' || t === '192.168.1.1', why: 'Управление роутером' },
  { test: (t) => t.endsWith('.local') || t.endsWith('.lan') || t.endsWith('.home.arpa'), why: 'Локальное имя — обслуживает штатный резолвер' },
  { test: (t) => /\.in-addr\.arpa$/.test(t), why: 'Обратный запрос к частному адресу' },
]

export const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':')
const familyOf = (s: string): Family => (s.includes(':') ? 'v6' : 'v4')

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}
export function inCidr(ip: string, cidr: string): boolean {
  if (ip.includes(':') || cidr.includes(':')) return ip.startsWith(cidr.split('::')[0])
  const [base, bitsS] = cidr.split('/')
  const bits = Number(bitsS ?? 32)
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask)
}
const suffixMatch = (host: string, suffix: string) => host === suffix || host.endsWith('.' + suffix)

export interface EvalCtx {
  config: Config
  topology: Topology
  runtime: Runtime
  caps: Capabilities
  flows: ClassifiedFlow[]
}

interface Subject {
  domain?: string
  ip?: string
  port: number
  proto: TraceQuery['proto']
  family: Family
}

/** Returns a human description of the first matching condition, or null. */
function matchOne(m: Match, s: Subject, config: Config): string | null {
  switch (m.type) {
    case 'domain':
      return s.domain === m.value ? `домен ${m.value}` : null
    case 'suffix':
      return s.domain && suffixMatch(s.domain, m.value) ? `домен *.${m.value}` : null
    case 'ip':
      return s.ip === m.value ? `IP ${m.value}` : null
    case 'cidr':
      return s.ip && inCidr(s.ip, m.value) ? `IP ${s.ip} ∈ ${m.value}` : null
    case 'port': {
      const [a, b] = m.value.split('-').map(Number)
      return s.port >= a && s.port <= (b ?? a) ? `порт ${s.port} ∈ ${m.value}` : null
    }
    case 'geosite': {
      const list = GEOSITE[m.value] ?? []
      return s.domain && list.some((d) => suffixMatch(s.domain!, d)) ? `geosite:${m.value}` : null
    }
    case 'geoip': {
      const list = GEOIP[m.value] ?? []
      return s.ip && list.some((c) => inCidr(s.ip!, c)) ? `geoip:${m.value}` : null
    }
    case 'set': {
      const set = config.sets.find((x) => x.id === m.value)
      if (!set) return null
      const hit =
        set.kind === 'domains'
          ? s.domain && set.entries.some((d) => suffixMatch(s.domain!, d))
          : s.ip && set.entries.some((c) => inCidr(s.ip!, c))
      return hit ? `набор «${set.name}»` : null
    }
  }
}

function matchRule(rule: Rule, s: Subject, config: Config): string | null {
  if (!rule.protos.includes(s.proto)) return null
  if (!rule.families.includes(s.family)) return null
  for (const m of rule.matches) {
    const hit = matchOne(m, s, config)
    if (hit) return hit
  }
  return null
}

const policyById = (c: Config, id?: string | null) => (id ? c.policies.find((p) => p.id === id) : undefined)

/** Walks parentId links; detects cycles. */
export function policyChain(config: Config, startId: string): { chain: Policy[]; cycle: boolean } {
  const chain: Policy[] = []
  const seen = new Set<string>()
  let cur = policyById(config, startId)
  while (cur) {
    if (seen.has(cur.id)) return { chain, cycle: true }
    seen.add(cur.id)
    chain.push(cur)
    cur = policyById(config, cur.parentId)
  }
  return { chain, cycle: false }
}

/** Effective default action of a chain: first non-inherit default, else Keenetic. */
function chainDefault(chain: Policy[]): { action: Action; from: string } {
  for (const p of chain) if (p.defaultAction.kind !== 'inherit') return { action: p.defaultAction, from: p.name }
  return { action: { kind: 'keenetic' }, from: 'встроенное значение' }
}

function isExplicitHard(a: Action) {
  return a.kind === 'block' || a.kind === 'vpn'
}

export function evaluate(ctx: EvalCtx, q: TraceQuery): TraceResult {
  const { config, topology, runtime, caps } = ctx
  const label: LabelCtx = { config, caps }
  const steps: TraceStep[] = []
  const limits: string[] = []

  const targetIsIp = isIp(q.target)
  const subject: Subject = {
    domain: targetIsIp ? undefined : q.target.toLowerCase(),
    ip: targetIsIp ? q.target : q.resolvedIp,
    port: q.port,
    proto: q.proto,
    family: familyOf(targetIsIp ? q.target : (q.resolvedIp ?? '0.0.0.0')),
  }

  // ── who is asking
  const device = q.source.type === 'device' ? topology.devices.find((d) => d.id === (q.source as { deviceId: string }).deviceId) : undefined
  const segmentId = device ? device.segmentId : (q.source as { segmentId: string }).segmentId
  const segment = topology.segments.find((s) => s.id === segmentId)
  const ssid = device?.ssidId ? topology.ssids.find((s) => s.id === device.ssidId)?.name : undefined
  const segPol = config.segmentPolicies.find((s) => s.segmentId === segmentId)
  const devPol = device ? config.devicePolicies.find((d) => d.deviceId === device.id) : undefined
  const bindingOk = !device || device.binding === 'confirmed'

  const recognition: TraceResult['recognition'] = targetIsIp
    ? {
        via: 'ip',
        detail: 'Известен только IP-адрес назначения (нет имени: общий CDN, ECH или клиентский DoH). Доменные правила не участвуют.',
        confidence: 'weak',
      }
    : q.resolvedIp
      ? { via: 'sni', detail: `Имя из TLS SNI, адрес ${q.resolvedIp} из DNS-ассоциации (TTL 300 с)`, confidence: 'exact' }
      : { via: 'domain', detail: 'Доменное имя из запроса', confidence: 'exact' }

  const result = (configured: Action, policyChainOut: TraceResult['policyChain'], extraLimits: string[] = []): TraceResult => {
    const eff = resolveEffective(ctx, configured)
    return {
      query: q,
      physical: { segmentId, segmentName: segment?.name ?? segmentId, ssid },
      policyChain: policyChainOut,
      recognition,
      steps,
      configured,
      configuredLabel: actionLabel(label, configured),
      effective: eff,
      coverage: coverageFor(caps, configured, segPol?.mode === 'managed' && segmentId === 'Bridge0'),
      limits: [...limits, ...extraLimits],
    }
  }

  // ── 0. protected system traffic
  const prot = subject.domain ? PROTECTED.find((p) => p.test(subject.domain!)) : PROTECTED.find((p) => p.test(q.target))
  if (prot) {
    steps.push({ layer: 'system', scopeLabel: 'Системный трафик', outcome: 'matched', note: `${prot.why}. Не перехватывается RouteHub.` })
    return result({ kind: 'keenetic' }, [])
  }
  steps.push({ layer: 'system', scopeLabel: 'Системный трафик', outcome: 'no-match', note: 'Не относится к управлению роутером, туннелю, DHCP или локальным именам.' })

  if (!segPol || segPol.mode === 'excluded') {
    steps.push({ layer: 'policy', scopeLabel: `Сеть «${segment?.name ?? segmentId}»`, outcome: 'not-applicable', note: 'Сегмент исключён из обработки RouteHub — решение принимает KeeneticOS.' })
    return result({ kind: 'keenetic' }, [])
  }

  // Determine chain of policies for the device
  const mode = devPol?.mode ?? 'inherit-actual'
  const segPolicyId = segPol.policyId
  let deviceOwn: Policy | undefined
  let sourceId: string | undefined = segPolicyId
  const disabled = new Set<string>()

  if (device && devPol && !bindingOk && mode !== 'inherit-actual') {
    limits.push(`Привязка «${device.hostname}» не подтверждена (${device.binding}). Личная политика не исполняется — действует политика сегмента «${segment?.name}».`)
  }
  const personalActive = !!device && !!devPol && bindingOk

  if (personalActive && devPol) {
    if (mode === 'fixed-exit' && devPol.fixedExit) {
      steps.push({
        layer: 'device', scopeLabel: `Устройство «${devPol.alias ?? device!.hostname}»`, outcome: 'matched',
        rule: { id: 'fixed', name: 'Фиксированный выход', match: 'весь трафик устройства', action: devPol.fixedExit, source: 'Режим устройства' },
        note: 'Режим «фиксированный выход»: область и точка завершения заданы явно.',
      })
      return result(devPol.fixedExit, [{ id: 'fixed', name: 'Фиксированный выход', kind: 'device' }])
    }
    if (mode === 'local-overrides' || mode === 'independent') deviceOwn = policyById(config, devPol.policyId)
    if (mode === 'inherit-selected' || mode === 'local-overrides') sourceId = devPol.sourcePolicyId ?? segPolicyId
    if (mode === 'independent') sourceId = undefined
    deviceOwn?.disabledParentRuleIds.forEach((id) => disabled.add(id))
  }

  const groups = personalActive && device ? config.deviceGroups.filter((g) => g.deviceIds.includes(device.id)).sort((a, b) => a.priority - b.priority) : []

  const { chain: inheritedChain, cycle } = sourceId ? policyChain(config, sourceId) : { chain: [], cycle: false }
  if (cycle) limits.push('Обнаружена циклическая ссылка между политиками — цепочка оборвана. Применение такой конфигурации будет отклонено.')
  inheritedChain.forEach((p) => p.disabledParentRuleIds.forEach((id) => disabled.add(id)))

  const policyChainOut: TraceResult['policyChain'] = [
    ...(deviceOwn ? [{ id: deviceOwn.id, name: deviceOwn.name, kind: deviceOwn.kind }] : []),
    ...groups.map((g) => ({ id: g.policyId, name: `Группа «${g.name}»`, kind: 'device' as const })),
    ...inheritedChain.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
  ]

  /** Evaluate one policy's own rules. */
  const scan = (p: Policy, layer: TraceStep['layer'], scopeLabel: string): { rule: Rule; hit: string } | null => {
    const considered: NonNullable<TraceStep['considered']> = []
    for (const rule of p.rules) {
      if (!rule.enabled) {
        considered.push({ ruleId: rule.id, name: rule.name, why: 'Временно отключено' })
        continue
      }
      if (disabled.has(rule.id) && p.id !== deviceOwn?.id) {
        considered.push({ ruleId: rule.id, name: rule.name, why: 'Отключено в дочерней области' })
        continue
      }
      const hit = matchRule(rule, subject, config)
      if (hit) {
        steps.push({
          layer, scopeLabel, policyId: p.id, outcome: 'matched',
          rule: { id: rule.id, name: rule.name, match: hit, action: rule.action, source: sourceLabel(rule) },
          note: `Первое подходящее включённое правило (#${p.rules.indexOf(rule) + 1}).`, considered,
        })
        return { rule, hit }
      }
      considered.push({ ruleId: rule.id, name: rule.name, why: whyNot(rule, subject) })
    }
    steps.push({ layer, scopeLabel, policyId: p.id, outcome: 'no-match', note: p.rules.length ? `Ни одно из ${p.rules.length} правил не подошло.` : 'Своих правил нет.', considered })
    return null
  }

  // Pre-compute later explicit hard rules (for game-yield decision) without recording steps.
  const silentFirst = (pols: Policy[]): Rule | undefined => {
    for (const p of pols)
      for (const rule of p.rules)
        if (rule.enabled && !(disabled.has(rule.id) && p.id !== deviceOwn?.id) && matchRule(rule, subject, config)) return rule
    return undefined
  }

  // ── 1. device-local rules (+ device groups)
  if (deviceOwn) {
    const hit = scan(deviceOwn, 'device', `Устройство «${devPol?.alias ?? device!.hostname}»`)
    if (hit) return finish(hit.rule.action)
  } else if (device) {
    steps.push({ layer: 'device', scopeLabel: `Устройство «${devPol?.alias ?? device.hostname}»`, outcome: 'skipped', note: personalActive ? 'Своих правил нет — режим наследования.' : 'Личная политика не исполняется.' })
  }
  for (const g of groups) {
    const gp = policyById(config, g.policyId)
    if (!gp) continue
    const hit = scan(gp, 'device', `Группа устройств «${g.name}»`)
    if (hit) return finish(hit.rule.action)
  }

  // ── 2. Zapret service rules
  const svc = subject.domain
    ? (Object.keys(ZAPRET_DOMAINS) as ZapretServiceId[]).find((k) => ZAPRET_DOMAINS[k].some((d) => suffixMatch(subject.domain!, d)))
    : undefined
  if (svc) {
    const z = config.zapret.find((x) => x.id === svc)
    const inScope = z && (z.segmentIds.length === 0 || z.segmentIds.includes(segmentId))
    const svcName = svc === 'youtube' ? 'YouTube' : 'Discord'
    if (z?.enabled && inScope && subject.proto === 'tcp') {
      const zr = runtime.zapret[svc]
      if (zr.engine === 'running') {
        const a: Action = { kind: 'zapret', strategyId: z.strategyId, exit: 'direct' }
        steps.push({
          layer: 'zapret', scopeLabel: `Сервисное правило · ${svcName}`, outcome: 'matched',
          rule: { id: `zapret-${svc}`, name: `Zapret для ${svcName}`, match: `сервис ${svcName}`, action: a, source: 'Сервисные правила Zapret' },
          note: 'Сервисное переопределение действует для этого сегмента.',
        })
        return finish(a)
      }
      steps.push({
        layer: 'zapret', scopeLabel: `Сервисное правило · ${svcName}`, outcome: 'matched',
        rule: { id: `zapret-${svc}-fail`, name: `Отказ Zapret для ${svcName}`, match: `сервис ${svcName}`, action: z.failAction, source: 'Действие при отказе Zapret' },
        note: `Очередь Zapret не работает (${zr.engine}). Применено настроенное действие при отказе.`,
      })
      if (z.failAction.kind !== 'inherit') return finish(z.failAction)
    } else if (z) {
      steps.push({
        layer: 'zapret', scopeLabel: `Сервисное правило · ${svcName}`, outcome: 'not-applicable',
        note: !z.enabled
          ? `Zapret для ${svcName} выключен — сервис следует обычным правилам устройства и сети.`
          : !inScope
            ? `Сегмент «${segment?.name}» не входит в область Zapret для ${svcName}.`
            : 'UDP/QUIC не обрабатывается выбранной стратегией.',
      })
    }
  }

  // ── 3. game signal
  if (q.flowId) {
    const f = ctx.flows.find((x) => x.id === q.flowId)
    const preset = f && config.games.find((g) => g.name === f.app && g.enabled)
    const later = silentFirst([...(deviceOwn ? [deviceOwn] : []), ...inheritedChain])
    if (!f || !preset || f.confidence === 'none' || f.category === 'unknown') {
      steps.push({ layer: 'game', scopeLabel: 'Игровой сигнал', outcome: 'not-applicable', note: 'Классификация недоступна или неуверенна — действует обычная политика.' })
    } else if (later && isExplicitHard(later.action)) {
      steps.push({ layer: 'game', scopeLabel: `Игровой сигнал · ${f.app}`, outcome: 'yielded', note: `Сигнал «${f.category}» уступил явному правилу «${later.name}» (${actionLabel(label, later.action)}).` })
    } else if (f.detectedAt === 'late') {
      steps.push({ layer: 'game', scopeLabel: `Игровой сигнал · ${f.app}`, outcome: 'skipped', note: 'Сигнал получен после открытия соединения: для этого потока доступны только приоритет и диагностика.' })
    } else if (f.category === 'match' || f.category === 'voice') {
      steps.push({
        layer: 'game', scopeLabel: `Игровой сигнал · ${f.app}`, outcome: 'matched',
        rule: { id: preset.id, name: `Пресет «${preset.name}»`, match: `${f.category} · уверенность ${f.confidence}`, action: preset.routeAction, source: `Сигнатуры ${preset.version}` },
        note: 'Уверенная классификация при открытии соединения. Остальной трафик устройства следует своей политике.',
      })
      if (preset.routeAction.kind !== 'inherit') return finish(preset.routeAction)
    } else {
      steps.push({ layer: 'game', scopeLabel: `Игровой сигнал · ${f.app}`, outcome: 'not-applicable', note: `Категория «${f.category}» не входит в автоматику маршрута — штатная политика.` })
    }
  }

  // ── 4./5. inherited chain
  for (const p of inheritedChain) {
    const layer = p.kind === 'global' ? 'global' : 'policy'
    const scope = p.kind === 'global' ? 'Общие правила' : p.kind === 'template' ? `Шаблон «${p.name}»` : `Политика сети «${p.name}»`
    const hit = scan(p, layer, scope)
    if (hit) return finish(hit.rule.action)
  }

  // ── 6. default
  const terminal = deviceOwn && mode === 'independent' ? [deviceOwn] : [...(deviceOwn ? [deviceOwn] : []), ...inheritedChain]
  const d = chainDefault(terminal)
  steps.push({ layer: 'default', scopeLabel: 'Действие по умолчанию', outcome: 'matched', note: `Взято из «${d.from}».` })
  return finish(d.action)

  function finish(a: Action): TraceResult {
    const extra: string[] = []
    if (recognition.via === 'ip' && subject.ip && inCidr(subject.ip, '151.101.0.0/16'))
      extra.push('Адрес принадлежит общему CDN: по нему обслуживается много сайтов. Правило по IP затронет их все.')
    return result(a, policyChainOut, extra)
  }
}

function sourceLabel(rule: Rule): string {
  switch (rule.source.type) {
    case 'manual':
      return 'Создано вручную'
    case 'import':
      return rule.source.label ?? 'Импорт'
    case 'migration':
      return rule.source.label ?? 'Миграция'
    case 'preset':
      return rule.source.label ?? 'Пресет'
  }
}

function whyNot(rule: Rule, s: Subject): string {
  if (!rule.protos.includes(s.proto)) return `Только ${rule.protos.join('/').toUpperCase()}`
  if (!rule.families.includes(s.family)) return `Только ${rule.families.map((f) => (f === 'v4' ? 'IPv4' : 'IPv6')).join('/')}`
  const types = rule.matches.map((m) => m.type)
  if (!s.domain && types.every((t) => ['domain', 'suffix', 'geosite'].includes(t))) return 'Доменное правило, а имя неизвестно'
  return 'Условие не совпало'
}

/** What actually carries the traffic: resolves groups/primary and fallbacks. */
export function resolveEffective(ctx: EvalCtx, a: Action): TraceResult['effective'] {
  const { config, runtime, caps } = ctx
  const label: LabelCtx = { config, caps }
  if (a.kind !== 'vpn') return { label: actionLabel(label, a), viaFallback: false }
  const t = a.target
  if (t.type === 'profile' || t.type === 'primary') {
    const pid = t.type === 'profile' ? t.profileId : config.primaryProfileId
    const pr = runtime.profiles[pid]
    if (pr?.state === 'down')
      return { label: `${profileName(label, pid)} недоступен — новые соединения приостановлены`, viaFallback: true, suspended: true, fallbackReason: 'Профиль не проходит проверку' }
    return { label: `VPN · ${profileName(label, pid)}`, viaFallback: false }
  }
  const g = config.exitGroups.find((x) => x.id === t.groupId)
  const gr = runtime.groups[t.groupId]
  if (!g || !gr) return { label: 'Группа не найдена', viaFallback: true, suspended: true }
  if (gr.state === 'failed') {
    if (g.failAction.kind === 'suspend')
      return { label: `Приостановлено: все профили группы «${g.name}» недоступны`, viaFallback: true, suspended: true, fallbackReason: gr.fallback?.reason ?? 'Полный отказ группы' }
    if (g.failAction.kind === 'direct')
      return { label: `Временный прямой выход · ${actionLabel(label, { kind: 'direct', uplinkId: g.failAction.uplinkId })}`, viaFallback: true, fallbackReason: gr.fallback?.reason ?? 'Полный отказ группы' }
    return { label: `Резервная группа «${config.exitGroups.find((x) => x.id === (g.failAction as { groupId: string }).groupId)?.name}»`, viaFallback: true, fallbackReason: 'Полный отказ группы' }
  }
  const sel = gr.selectedProfileId ? profileName(label, gr.selectedProfileId) : '—'
  const preferred = g.memberIds[0]
  return {
    label: `VPN · ${sel} (группа «${g.name}»)`,
    viaFallback: g.mode === 'failover' && gr.selectedProfileId !== preferred,
    fallbackReason: g.mode === 'failover' && gr.selectedProfileId !== preferred ? gr.reason : undefined,
  }
}

function coverageFor(caps: Capabilities, a: Action, interceptVerifiedSegment: boolean): Coverage {
  if (a.kind === 'keenetic' || a.kind === 'block')
    return {
      v4tcp: { state: 'verified' }, v4udp: { state: 'verified' },
      v6tcp: { state: a.kind === 'block' ? 'configured' : 'verified' }, v6udp: { state: a.kind === 'block' ? 'configured' : 'verified' },
    }
  const c = caps.interception.coverage
  if (!interceptVerifiedSegment)
    return { ...c, v4tcp: { state: 'configured', note: 'Перехват на этом сегменте ещё не подтверждён трафиком' } }
  if (a.kind === 'zapret') return { ...c, v4udp: { state: 'unsupported', note: 'Стратегия обрабатывает только TCP' } }
  return c
}
