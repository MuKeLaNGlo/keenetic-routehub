/**
 * Scenario overlays for the mock: each flag is a pure transformation applied
 * on read, so toggling never corrupts persisted state. The Scenario Lab UI
 * flips these; production has no equivalent.
 */
import type { Action, Capabilities, Config, DnsServer, ProbeResult, Runtime, Topology, TrafficPeriod, TrafficSeries } from '../contract'
import { serverHost } from '@/lib/dnsAddress'
import { ago, seedConfig, seedStrategies } from './seed'

export type UpdateOutcome = 'ok' | 'no-space' | 'incompatible' | 'verify-fail'

export interface ScenarioFlags {
  readOnly: boolean
  link: 'online' | 'slow' | 'offline'
  nlDown: boolean
  nlEeDown: boolean
  streamDown: boolean
  dnsPrimaryFail: boolean
  zapretYtPartial: boolean
  zapretQueueFail: boolean
  subscriptionFails: boolean
  applyFails: boolean
  updateOutcome: UpdateOutcome
  telemetry: 'ok' | 'gap' | 'stale' | 'error' | 'fresh'
  iotMovedToGuest: boolean
}

export const DEFAULT_FLAGS: ScenarioFlags = {
  readOnly: false,
  link: 'online',
  nlDown: false,
  nlEeDown: false,
  streamDown: false,
  dnsPrimaryFail: false,
  zapretYtPartial: false,
  zapretQueueFail: false,
  subscriptionFails: false,
  applyFails: false,
  updateOutcome: 'ok',
  telemetry: 'ok',
  iotMovedToGuest: false,
}

export function overlayCaps(c: Capabilities, f: ScenarioFlags): Capabilities {
  return f.readOnly ? { ...c, access: 'read' } : c
}

export function overlayTopology(t: Topology, f: ScenarioFlags): Topology {
  if (!f.iotMovedToGuest) return t
  return {
    ...t,
    devices: t.devices.map((d) =>
      d.id === 'd-plug' || d.id === 'd-vacuum'
        ? { ...d, segmentId: 'Bridge1', ssidId: 'ssid-guest', addresses: d.addresses.map((a) => (a.family === 'v4' ? { ...a, addr: a.addr.replace('10.20.0.', '10.10.0.1') } : a)) }
        : d,
    ),
  }
}

const seededDns = new Map(seedConfig().dns.map((policy) => [policy.id, policy]))
const zapretStrategyNames = new Map(seedStrategies().map(({ id, name }) => [id, name]))

function demoProbe(server: DnsServer, seeded: DnsServer | null | undefined, base: ProbeResult | null | undefined, medianMs: number): ProbeResult {
  if (base && seeded && JSON.stringify(server) === JSON.stringify(seeded)) return base
  return { state: 'ok', method: server.protocol === 'doh' ? 'https' : server.protocol === 'dot' ? 'handshake' : 'tcp', medianMs, samples: 3, measuredAt: ago(1) }
}

function overlayDns(out: Runtime, flags: ScenarioFlags, config: Pick<Config, 'dns' | 'primaryProfileId'>) {
  function routeUnavailable(route: Action) {
    if (route.kind !== 'vpn') return false
    if (route.target.type === 'group') return out.groups[route.target.groupId]?.state === 'failed'
    const profile = route.target.type === 'primary' ? config.primaryProfileId : route.target.profileId
    return ['down', 'disabled', 'missing', 'incompatible'].includes(out.profiles[profile]?.state)
  }

  const prior = out.dns
  out.dns = {}
  let fallbackHost: string | undefined
  let unavailable = false
  let changed = false

  for (const policy of config.dns) {
    if (!policy.managed) {
      out.dns[policy.id] = { primary: { state: 'untested', method: 'tcp' }, fallback: null, active: 'none' }
      continue
    }

    const seeded = seededDns.get(policy.id)
    const base = prior[policy.id]
    changed ||= JSON.stringify(policy.primary) !== JSON.stringify(seeded?.primary) || JSON.stringify(policy.fallback) !== JSON.stringify(seeded?.fallback)
    const primary = demoProbe(policy.primary, seeded?.primary, base?.primary, 31)
    const fallback = policy.fallback ? demoProbe(policy.fallback, seeded?.fallback, base?.fallback, 18) : null
    const brokenRoute = routeUnavailable(policy.primary.via)
    const primaryDown = brokenRoute || (policy.id === 'dns-main' && flags.dnsPrimaryFail)
    if (primaryDown) {
      primary.state = 'down'
      primary.failStage = brokenRoute ? 'connect' : policy.primary.protocol === 'udp' ? 'response' : 'tls'
      primary.note = brokenRoute ? 'Маршрут к резолверу через VPN недоступен.' : 'Резолвер не прошёл проверку.'
      primary.medianMs = undefined
      primary.lossPct = 100
    }

    if (policy.fallback && fallback) {
      const directBlocked = policy.primary.via.kind === 'vpn' && policy.fallback.via.kind === 'direct' && !policy.fallbackDirectAllowed
      if (directBlocked || routeUnavailable(policy.fallback.via)) {
        fallback.state = directBlocked ? 'disabled' : 'down'
        fallback.failStage = 'connect'
        fallback.note = directBlocked ? 'Прямой резерв запрещён политикой DNS.' : 'Маршрут к резервному серверу недоступен.'
        fallback.medianMs = undefined
      }
    }

    const active = !primaryDown ? 'primary' : fallback?.state === 'ok' ? 'fallback' : 'none'
    out.dns[policy.id] = { primary, fallback, active, since: primaryDown ? ago(4) : base?.since }
    if (active === 'fallback' && policy.fallback) fallbackHost = serverHost(policy.fallback.address)
    unavailable ||= active === 'none'
  }

  if (unavailable) out.services.dns = { state: 'degraded', label: 'Часть DNS-запросов не разрешается' }
  else if (fallbackHost) out.services.dns = { state: 'degraded', label: 'DNS: работает резервный сервер', detail: fallbackHost }
  else if (changed && out.services.dns.state === 'running') out.services.dns = { state: 'running', label: 'Служба DNS работает' }
}

export function overlayRuntime(r: Runtime, f: ScenarioFlags, config: Pick<Config, 'dns' | 'primaryProfileId' | 'zapret'>): Runtime {
  const out: Runtime = structuredClone(r)
  if (out.services.core.state === 'running') out.services.core.detail = `Конфигурация r${out.loadedRevision} загружена`
  if (f.link === 'slow') out.link = { state: 'slow', latencyMs: 1840, lastSyncAt: ago(0.4) }
  if (f.link === 'offline') out.link = { state: 'offline', latencyMs: 0, lastSyncAt: ago(3) }

  const down = (id: string, stage: 'connect' | 'tls' | 'timeout' = 'timeout') => {
    out.profiles[id] = { state: 'down', method: 'https', lossPct: 100, samples: 5, measuredAt: ago(0.5), failStage: stage, note: '5 из 5 проб не прошли' }
  }

  if (f.nlDown || f.nlEeDown) {
    down('p-nl-ams')
    out.groups['grp-nl-ee'] = {
      selectedProfileId: 'p-ee-tll', state: 'degraded', since: ago(2), fallback: null,
      reason: 'NL Amsterdam не прошёл 3 пробы подряд → следующий по порядку: EE Tallinn',
    }
  }
  if (f.nlEeDown) {
    down('p-ee-tll', 'tls')
    out.groups['grp-nl-ee'] = {
      selectedProfileId: null, state: 'failed', since: ago(1),
      reason: 'Все профили группы недоступны',
      fallback: { description: 'Новые подключения по правилам группы приостановлены', since: ago(1), reason: 'NL Amsterdam и EE Tallinn не проходят HTTPS-пробу' },
    }
  }
  if (f.streamDown) {
    ;['p-de-fra', 'p-fi-hel', 'p-nl-rtm', 'p-us-nyc'].forEach((id) => down(id))
    out.groups['grp-stream'] = {
      selectedProfileId: null, state: 'failed', since: ago(14),
      reason: 'Все профили группы недоступны',
      fallback: { description: 'Временный прямой выход · Ростелеком (разрешён администратором)', since: ago(14), reason: 'Ни один профиль не прошёл пробу 3 раза подряд' },
    }
  }
  overlayDns(out, f, config)
  for (const { id, enabled, strategyId } of config.zapret) {
    if (enabled && out.zapret[id].engine === 'running') {
      out.zapret[id].effective = `Zapret · стратегия «${zapretStrategyNames.get(strategyId) ?? strategyId}»`
    }
  }
  if (f.zapretQueueFail) {
    out.zapret.youtube = { engine: 'failed', packetsSeen: false, payloadCheck: 'down', effective: 'Отказ очереди → обычные правила сети' }
    out.zapret.discord = { engine: 'failed', packetsSeen: false, payloadCheck: 'down', effective: 'Отказ очереди → VPN «Нидерланды / Эстония»' }
    out.services.zapret = { state: 'failed', label: 'Zapret: очередь 200 не обслуживается', detail: 'nfqws завершился с кодом 1' }
  } else if (f.zapretYtPartial && config.zapret.some(({ id, enabled, strategyId }) => id === 'youtube' && enabled && strategyId === 'zs-yt-fake')) {
    out.zapret.youtube = { engine: 'running', packetsSeen: true, payloadCheck: 'degraded', effective: 'Zapret · страница открывается, видео и комментарии — нет' }
    out.services.zapret = { state: 'degraded', label: 'Zapret: YouTube работает частично' }
  }
  if (f.telemetry === 'error') out.services.collector = { state: 'failed', label: 'Сбор телеметрии остановлен', detail: 'Счётчик WAN недоступен' }
  out.networkChecks = f.nlEeDown
    ? { passed: 2, failed: 2, untested: 1, at: ago(0.5) }
    : f.nlDown || f.streamDown || f.dnsPrimaryFail
      ? { passed: 3, failed: 1, untested: 1, at: ago(1) }
      : out.networkChecks
  return out
}

/* ───────────────────────────── telemetry ────────────────────────────── */

const PERIOD_SEC: Record<TrafficPeriod, number> = { '5m': 300, '15m': 900, '1h': 3600 }

/** Collector started 47 minutes ago (process restart), so 1h has less history. */
const COLLECTOR_UPTIME_SEC = 47 * 60

function wave(t: number) {
  const s = t / 1000
  const base = 18 + 10 * Math.sin(s / 97) + 6 * Math.sin(s / 23 + 1.3)
  const burst = Math.max(0, Math.sin(s / 41)) ** 8 * 70
  const rx = Math.max(0.4, base + burst + 3 * Math.sin(s * 1.7))
  const tx = Math.max(0.2, rx * 0.16 + 2 * Math.sin(s / 13 + 2))
  return { rx: rx * 1e6 / 8, tx: tx * 1e6 / 8 } // bytes/s
}

/** Independent demo counters, with different activity and burst patterns for each route. */
function routedWave(t: number) {
  const seconds = t / 1000
  const directBase = 11 + 5 * Math.sin(seconds / 73) + 4 * Math.sin(seconds / 17 + 1.2)
  const directBurst = Math.max(0, Math.sin(seconds / 38 + 0.6)) ** 8 * 39
  const vpnBase = 6.5 + 3 * Math.sin(seconds / 91 + 2) + 2.4 * Math.sin(seconds / 13)
  const vpnBurst = Math.max(0, Math.sin(seconds / 52 - 0.9)) ** 10 * 23
  return { direct: (directBase + directBurst) * 1e6 / 8, vpn: (vpnBase + vpnBurst) * 1e6 / 8 }
}

export function trafficSeries(period: TrafficPeriod, f: ScenarioFlags): TrafficSeries {
  const step = 5
  const now = Math.floor(Date.now() / 1000 / step) * step * 1000
  const n = PERIOD_SEC[period] / step
  const uptime = f.telemetry === 'fresh' ? 6 * 60 + 40 : COLLECTOR_UPTIME_SEC
  const historySec = Math.min(PERIOD_SEC[period], uptime)
  const object = 'WAN · GigabitEthernet1 (счётчик интерфейса, без туннелей)'

  if (f.telemetry === 'error')
    return { period, stepSec: step, points: [], historySec: 0, lastSampleAt: ago(6), state: 'error', error: 'Сборщик не может прочитать счётчик интерфейса (EACCES). Прошлые интервалы не дополняются.', object }

  const staleCut = f.telemetry === 'stale' ? 24 : 0 // last 2 minutes missing
  const points: TrafficSeries['points'] = []
  for (let i = n - 1; i >= 0; i--) {
    const t = now - i * step * 1000
    const age = i * step
    if (age > uptime) {
      points.push(null)
      continue
    }
    if (i < staleCut) continue
    if (f.telemetry === 'gap' && age > 150 && age < 215) {
      points.push(null)
      continue
    }
    points.push({ t, ...wave(t), routed: routedWave(t) })
  }
  const last = [...points].reverse().find(Boolean)
  return {
    period, stepSec: step, points, historySec, object,
    lastSampleAt: last ? new Date(last.t).toISOString() : null,
    state: f.telemetry === 'stale' ? 'stale' : points.some(Boolean) ? 'ok' : 'no-data',
  }
}
