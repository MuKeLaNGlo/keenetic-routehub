import { diffConfig } from '@/lib/configDiff'
import { subscriptionPreviewFailure } from '@/lib/subscriptions'
import type {
  ApplyPlan, ApplyResult, Capabilities, ChangeTopic, CheckComparison, Config, ConnectionObservation, DnsCheckResult, EngineInfo,
  GeoSource, JournalEvent, ProfileImportCandidate, ProfileImportOptions, ProbeResult, ProfileProbeUpdate, Revision, RouteHubApi,
  RouterResources, RuleImportOptions, RuleImportPreview, Runtime, ServiceCheckItem, ServiceLogStorage, SubscriptionInput, SubscriptionPreview, SubscriptionStatus, SupportReport,
  Task, TaskKind, Topology, TraceQuery, TraceResult, TrafficPeriod, TrafficSeries, UpdateComponent, UpdateInfo,
  ZapretAutoSelectResult, ZapretCheckResult, ZapretServiceId, ZapretStrategy,
} from './contract'
import {
  dateUnknown, DNS_ID, encodeDNS, encodePlan, fromProfile, fromRule, fromTarget, GLOBAL_ID, knownSegment,
  makeTopology, noCapability, projectConfig, revisionKey, same, toTarget, untestedCoverage, WAN_ID, zapretIds,
  type LegacyDNS, type LegacyInventory, type LegacyPlan, type LegacyPlanUpdate, type LegacyProfile, type LegacyRule, type LegacyRuntime,
} from './legacy'

class RequestError extends Error {
  readonly status: number
  readonly retryAfterMs: number | undefined

  constructor(status: number, description: string, retryAfter: string | null = null) {
    super(description)
    this.status = status
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      this.retryAfterMs = Number(retryAfter) * 1000
    } else if (retryAfter) {
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) this.retryAfterMs = Math.max(0, date - Date.now())
    }
  }
}

async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
  const multipart = body instanceof FormData
  const response = await fetch(path, {
    method,
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined ? {} : {
      headers: multipart ? undefined : { 'Content-Type': 'application/json' },
      body: multipart ? body : JSON.stringify(body),
    }),
  })
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('routehub-session-expired'))
    const value = await response.json().catch(() => null) as { error?: string } | null
    throw new RequestError(response.status, value?.error || `RouteHub: HTTP ${response.status}`, response.headers.get('Retry-After'))
  }
  return response
}

export async function json<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  return (await request(path, method, body, signal)).json() as Promise<T>
}

async function optional<T>(path: string): Promise<T | null> {
  try {
    return await json<T>(path)
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return null
    throw error
  }
}

interface Snapshot {
  config: Config
  plan: LegacyPlan
  runtime: LegacyRuntime | null
  dns: LegacyDNS | null
}

interface CheckResponse {
  id?: string
  role?: string
  status: string
  message: string
  latencyMs?: number
}

interface LegacyRevision {
  revision: string
  createdAt: string
  by: string
  note: string
}

type PlanWrite = LegacyPlanUpdate
  | Required<Pick<LegacyPlanUpdate, 'revision' | 'savedChecks'>>
  | Required<Pick<LegacyPlanUpdate, 'revision' | 'games'>>
type Write = { path: string; method: 'PUT'; body: unknown; legacyPlan?: PlanWrite }
type Listener = (topic: ChangeTopic) => void
const emptyInventory: LegacyInventory = { neighbors: [], configured: [] }
const emptyList = async () => []
const unsupported = async (): Promise<never> => { throw new Error(noCapability.reason) }
const now = () => new Date().toISOString()
const probeQueueTimeoutMs = 15_000

function waitForProbeSlot(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const finish = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function toProbe(reply: CheckResponse): ProbeResult {
  const state = reply.status === 'ok' || reply.status === 'verified' ? 'ok'
    : ['failed', 'timeout', 'unavailable'].includes(reply.status) ? 'down' : 'untested'
  return { state, method: 'https', medianMs: reply.latencyMs, measuredAt: now(), samples: 1, note: reply.message }
}

function checkItem(reply: CheckResponse, id: string, label: string, proto: string): ServiceCheckItem {
  const state = reply.status === 'ok' || reply.status === 'verified'
    ? 'ok' : reply.status === 'failed' || reply.status === 'timeout' ? 'fail' : reply.status === 'unverified' ? 'untested' : reply.status === 'canceled' ? 'interrupted' : 'unavailable'
  return { id, label, proto, state, ms: reply.latencyMs, detail: reply.message }
}

const zapretName = (id: ZapretServiceId) => id === 'youtube' ? 'YouTube' : 'Discord'

function actionLabel(legacy: string, config: Config): string {
  switch (legacy) {
    case 'direct': return 'Напрямую через обычный WAN'
    case '@block': return 'Заблокировать'
    case '@vpn': return 'Основной VPN'
    case 'zapret': return 'Zapret'
    default: return config.profiles.find(({ id }) => id === legacy)?.name ?? legacy
  }
}

function newTask(kind: TaskKind, title: string, scope: string): Task {
  return {
    id: `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    kind, title, scope, state: 'running', startedAt: now(),
    steps: [{ label: title, state: 'running' }], cancellable: false,
  }
}

function finalize(task: Task, result?: unknown, error?: unknown): Task {
  const detail = error instanceof Error ? error.message : undefined
  return {
    ...task,
    state: detail ? 'error' : 'done',
    finishedAt: now(),
    steps: [{ label: task.title, state: detail ? 'error' : 'done', detail }],
    error: detail,
    result,
  }
}

function preflightError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class HttpRouteHub implements RouteHubApi {
  private listeners = new Set<Listener>()
  private pollCount = 0
  private poll: number | undefined
  private freshRead: Promise<Snapshot> | null = null
  private snapshot: Snapshot | null = null
  private cacheUntil = 0
  private recent = new Map<number, Config>()
  private revisions = new Map<number, string>()
  private localTasks = new Map<string, Task>()
  private localEvents = new Map<string, JournalEvent>()
  private profileProbeBusy = false
  private capabilitiesRead: Promise<Capabilities> | null = null
  private lastApply: Runtime['lastApply'] | undefined
  private previews = new Map<string, LegacyProfile>()
  private imported = new Map<string, LegacyProfile>()
  private probes: Runtime['profiles'] = {}
  private dnsProbe: { revision: number; result: Runtime['dns'][string] } | undefined
  private zapretProbe = new Map<ZapretServiceId, { enabled: boolean; strategy: string; reply: CheckResponse }>()

  private publish(...topics: ChangeTopic[]) {
    topics.forEach((topic) => this.listeners.forEach((listener) => listener(topic)))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.poll === undefined) this.poll = window.setInterval(() => {
      if (document.hidden) return
      this.publish('runtime', 'tasks', 'events')
      if (++this.pollCount % 3 === 0) this.publish('config')
      if (this.pollCount % 6 === 0) this.publish('topology', 'capabilities')
    }, 5000)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        window.clearInterval(this.poll)
        this.poll = undefined
      }
    }
  }

  private remember(snapshot: Snapshot) {
    this.snapshot = snapshot
    this.cacheUntil = Date.now() + 800
    this.recent.set(snapshot.config.revision, snapshot.config)
    while (this.recent.size > 10) this.recent.delete(this.recent.keys().next().value!)
    return snapshot
  }

  private async readConfig(force = false): Promise<Snapshot> {
    if (!force && this.snapshot && Date.now() < this.cacheUntil) return this.snapshot
    if (this.freshRead) {
      if (!force) return this.freshRead
      await this.freshRead
      return this.readConfig(true)
    }
    const promise = Promise.all([
      json<LegacyPlan>('/api/plan'), optional<LegacyRuntime>('/api/runtime'), optional<LegacyDNS>('/api/dns'),
    ]).then(([plan, runtime, dns]) => this.remember({ plan, runtime, dns, config: projectConfig(plan, runtime, dns) }))
    this.freshRead = promise
    try {
      return await promise
    } finally {
      if (this.freshRead === promise) this.freshRead = null
    }
  }

  async getConfig(): Promise<Config> {
    return (await this.readConfig()).config
  }

  async getCapabilities(): Promise<Capabilities> {
    if (this.capabilitiesRead) return this.capabilitiesRead
    const read = json<Capabilities>('/api/panel/capabilities')
    this.capabilitiesRead = read
    try {
      return await read
    } finally {
      this.capabilitiesRead = null
    }
  }

  getSavedCheckResults(): Promise<CheckComparison[]> {
    return json<CheckComparison[]>('/api/panel/saved-checks/results')
  }

  private getInventory() {
    return json<LegacyInventory>('/api/devices')
  }

  async getTopology(): Promise<Topology> {
    const topology = await optional<Topology>('/api/panel/topology')
    if (topology) return topology
    const [plan, inventory] = await Promise.all([json<LegacyPlan>('/api/plan'), this.getInventory()])
    return makeTopology(plan, inventory, now())
  }

  async getRuntime(): Promise<Runtime> {
    const started = performance.now()
    const [snapshot, traffic, status] = await Promise.all([
      this.readConfig(),
      this.getTraffic('5m').catch(() => ({ state: 'error' as const, object: 'Счётчики WAN недоступны' })),
      json<{ version: string; startedAt?: string }>('/api/status'),
    ])
    const { config, runtime, dns } = snapshot
    const activeDNS = this.dnsProbe?.revision === config.revision ? this.dnsProbe.result : undefined
    const state = (enabled?: boolean) => enabled ? 'running' as const : 'stopped' as const
    const awgProfiles = config.profiles.filter(({ protocol }) => protocol === 'awg')
    const engine = (id: EngineInfo['id'], name: string, installed: string | null, usedBy: number, running = false, capabilities: string[] = [], source = 'RouteHub'): EngineInfo => ({
      id, name, installed, available: null, source, ramMb: 0, diskMb: 0,
      status: installed ? state(running) : 'not-installed', usedBy, capabilities,
    })
    const profiles = Object.fromEntries(config.profiles.filter(({ id }) => this.probes[id]).map(({ id }) => [id, this.probes[id]]))
    const zapret = Object.fromEntries(zapretIds.map((id) => {
      const service = runtime?.zapret[id]
      const it = this.zapretProbe.get(id)
      const previous = it?.strategy === service?.strategy && it?.enabled === service?.enabled ? it : undefined
      const packetsSeen = previous?.reply.status === 'verified'
      return [id, {
        engine: state(service?.enabled), packetsSeen,
        payloadCheck: previous ? toProbe(previous.reply).state : 'untested',
        effective: service?.enabled ? 'Назначен Zapret' : 'По обычным правилам',
      }]
    })) as Runtime['zapret']
    // The kernel counters below only identify the default WAN interface. They
    // cannot attest end-to-end internet access or an external address.
    return {
      link: { state: 'online', latencyMs: Math.round(performance.now() - started), lastSyncAt: now() },
      wan: { state: 'unknown', uplinkId: WAN_ID, publicIp: '' },
      vpn: runtime?.vpn,
      loadedRevision: config.revision,
      lastApply: this.lastApply ?? { revision: config.revision, at: status.startedAt ?? dateUnknown, result: 'ok' },
      networkChecks: { passed: 0, failed: 0, untested: 0, at: dateUnknown },
      services: {
        core: { state: 'running', label: 'Ядро RouteHub', detail: runtime?.vpn.enabled ? 'VPN включён' : 'VPN выключен' },
        zapret: { state: runtime ? state(runtime.zapret.youtube.enabled || runtime.zapret.discord.enabled) : 'not-installed', label: 'Zapret' },
        dns: { state: dns?.error ? 'degraded' : dns ? state(dns.enabled) : 'not-installed', label: 'Резолвер RouteHub', detail: dns?.error },
        collector: { state: traffic.state === 'error' ? 'failed' : traffic.state === 'stale' ? 'degraded' : 'running', label: traffic.object },
      },
      profiles,
      groups: {}, sets: {}, dns: dns?.enabled ? { [DNS_ID]: activeDNS ?? { primary: { state: 'untested', method: 'tcp' }, fallback: null, active: 'unknown' } } : {}, zapret,
      engines: [
        engine('xray', 'Xray', runtime?.xrayVersion?.trim() || 'версия не сообщена', config.profiles.length - awgProfiles.length, true,
          ['VLESS', 'Hysteria2', 'Trojan'], 'Пакет RouteHub или GitHub Releases'),
        engine('sing-box', 'sing-box', null, 0, false),
        engine('awg-routehub', 'AmneziaWG RouteHub', `пакет RouteHub ${status.version}`,
          awgProfiles.filter(({ adapter }) => adapter.engine === 'awg-routehub').length,
          runtime?.vpn.enabled && awgProfiles.some(({ id, adapter }) => id === runtime.vpn.profile && adapter.engine === 'awg-routehub'),
          ['AmneziaWG'], 'Обновляется с пакетом RouteHub'),
        ...(awgProfiles.some(({ adapter }) => adapter.engine === 'awg-keenetic')
          ? [engine('awg-keenetic', 'Keenetic WireGuard ASC', 'настроено',
            awgProfiles.filter(({ adapter }) => adapter.engine === 'awg-keenetic').length,
            runtime?.vpn.enabled && awgProfiles.some(({ id, adapter }) => id === runtime.vpn.profile && adapter.engine === 'awg-keenetic'),
            ['WireGuard ASC'], 'Обновляется с KeeneticOS')]
          : []),
      ],
      trial: null,
    }
  }

  getRouterResources(): Promise<RouterResources> {
    return json<RouterResources>('/api/panel/router-resources')
  }

  getServiceLogStorage(): Promise<ServiceLogStorage> {
    return json<ServiceLogStorage>('/api/panel/log-storage')
  }

  async getTraffic(period: TrafficPeriod): Promise<TrafficSeries> {
    const result = await json<{
      interface?: string; startedAt?: string
      samples: { at: string; receiveMbit: number; sendMbit: number }[]
    }>('/api/traffic')
    const seconds = { '5m': 300, '15m': 900, '1h': 3600 }[period]
    const stepSec = 5
    const interval = stepSec * 1000
    const base = Math.floor(Date.now() / interval) * interval - seconds * 1000 + interval
    const points: TrafficSeries['points'] = Array.from({ length: seconds / stepSec }, () => null)
    const count = new Uint16Array(points.length)
    const samples = result.samples ?? []
    for (const sample of samples) {
      const t = Date.parse(sample.at)
      const index = Math.floor((t - base) / interval)
      if (!Number.isInteger(index) || index < 0 || index >= points.length) continue
      const previous = points[index] ?? { t: base + index * interval, rx: 0, tx: 0 }
      const n = ++count[index]
      previous.rx += (sample.receiveMbit * 125_000 - previous.rx) / n
      previous.tx += (sample.sendMbit * 125_000 - previous.tx) / n
      points[index] = previous
    }
    const lastSampleAt = samples.at(-1)?.at ?? null
    return {
      period, stepSec, points,
      historySec: result.startedAt ? Math.max(0, Math.min(seconds, Math.round((Date.now() - Date.parse(result.startedAt)) / 1000))) : 0,
      lastSampleAt,
      state: !lastSampleAt ? 'no-data' : Date.now() - Date.parse(lastSampleAt) > 20_000 ? 'stale' : points.some(Boolean) ? 'ok' : 'no-data',
      object: result.interface ? `WAN · ${result.interface}` : 'Счётчик WAN недоступен',
    }
  }

  private runTask(kind: TaskKind, title: string, scope: string, perform: () => Promise<unknown>): Task {
    const task = newTask(kind, title, scope)
    this.storeTask(task)
    void Promise.resolve().then(perform).then((result) => {
      this.storeTask(finalize(task, result))
    }).catch((error: unknown) => {
      this.storeTask(finalize(task, undefined, error instanceof Error ? error : new Error(String(error))))
    })
    return task
  }

  private storeTask(task: Task) {
    this.localTasks.set(task.id, task)
    if (task.state === 'done' || task.state === 'error') {
      const eventType: JournalEvent['type'] = task.kind === 'apply' || task.kind === 'rollback' ? task.kind
        : task.kind === 'dns-check' ? 'dns' : task.kind === 'zapret-check' ? 'zapret' : 'task'
      this.localEvents.set(task.id, {
        id: task.id, at: task.finishedAt ?? task.startedAt, type: eventType, severity: task.state === 'done' ? 'ok' : 'error',
        object: { kind: 'panel', name: task.scope }, title: task.title, detail: task.error,
      })
    }
    while (this.localTasks.size > 40) this.localTasks.delete(this.localTasks.keys().next().value!)
    while (this.localEvents.size > 40) this.localEvents.delete(this.localEvents.keys().next().value!)
    this.publish('tasks', 'events', 'runtime')
  }

  async getTasks(): Promise<Task[]> {
    const server = await json<Task[]>('/api/panel/tasks')
    return [...this.localTasks.values(), ...(server ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async getEvents(): Promise<JournalEvent[]> {
    const server = await json<JournalEvent[]>('/api/panel/events')
    return [...this.localEvents.values(), ...(server ?? [])].sort((a, b) => b.at.localeCompare(a.at))
  }

  async getRevisions(): Promise<Revision[]> {
    const revisions = await json<LegacyRevision[]>('/api/panel/revisions')
    const active = await this.readConfig()
    this.revisions.clear()
    return (revisions ?? []).map((item) => {
      const revision = item.revision === active.plan.revision ? active.config.revision : revisionKey(item.revision)
      this.revisions.set(revision, item.revision)
      return { revision, at: item.createdAt, by: item.by, summary: item.note, result: 'ok', changes: 0 }
    })
  }

  async getGeoSources(): Promise<GeoSource[]> {
    const { plan } = await this.readConfig()
    const { sources } = await json<{ sources: { id: string; status: string; version?: string; updatedAt?: string; countries?: string[]; sites?: string[] }[] }>('/api/geoip')
    return (sources ?? []).map((item) => {
      const source = plan.geoSources?.find(({ id }) => id === item.id)
      const tags = [...(item.countries ?? []), ...(item.sites ?? [])]
      const uses = (plan.rules ?? []).filter((rule) => rule.geoSource === item.id)
      return {
        id: item.id, name: source?.name ?? item.id, version: item.version ?? '—', sizeKb: 0,
        tags: tags.length, kind: source?.asset.includes('geosite') ? 'geosite' : 'geoip',
        lastCheck: item.updatedAt ?? dateUnknown,
        status: item.version ? 'ok' : 'failed',
        usedTags: [...new Set(uses.map((rule) => rule.geoIP || rule.geoSite || '').filter(Boolean))],
      }
    })
  }

  getClassifiedFlows = emptyList
  async getUpdates(): Promise<UpdateInfo[]> {
    return (await optional<UpdateInfo[]>('/api/panel/cores/updates')) ?? []
  }

  checkUpdate(component: UpdateComponent): Promise<Task> {
    return this.startCoreUpdate(component, 'check')
  }

  runUpdate(component: UpdateComponent): Promise<Task> {
    return this.startCoreUpdate(component, 'install')
  }

  private async startCoreUpdate(component: UpdateComponent, action: 'check' | 'install') {
    if (component !== 'xray') throw new Error('Из панели обновляется Xray.')
    const task = await json<Task>(`/api/panel/cores/xray/${action}`, 'POST', {})
    this.cacheUntil = 0
    this.publish('tasks', 'runtime', 'events')
    return task
  }
  observeConnections(seconds: number, deviceId?: string) {
    return json<ConnectionObservation>('/api/panel/connections/observe', 'POST', { seconds, deviceId })
  }
  confirmTrial = unsupported
  rollbackTrial = unsupported
  cancelTask = unsupported

  async getSubscriptionStatus(): Promise<SubscriptionStatus[]> {
    const snapshot = await optional<{ statuses: SubscriptionStatus[] }>('/api/panel/subscriptions')
    return snapshot?.statuses ?? []
  }

  async previewSubscription(id: string): Promise<SubscriptionPreview> {
    try {
      const preview = await json<SubscriptionPreview | null>('/api/panel/subscriptions/preview', 'POST', { id })
      if (!preview || preview.subscriptionId !== id || typeof preview.ok !== 'boolean' ||
        !Number.isFinite(Date.parse(preview.fetchedAt)) ||
        ![preview.added, preview.changed, preview.missing, preview.incompatible, preview.ambiguous].every(Array.isArray)) {
        return subscriptionPreviewFailure(id, 'Роутер вернул ответ API в неожиданном формате.')
      }
      return preview
    } catch (error) {
      if (error instanceof RequestError) {
        const status = `HTTP ${error.status}`
        const detail = error.message.endsWith(status) ? error.message : `Панель вернула ${status}. ${error.message}`
        return subscriptionPreviewFailure(id, detail)
      }
      return subscriptionPreviewFailure(id, error instanceof SyntaxError
        ? 'Роутер вернул ответ API в неожиданном формате.'
        : 'Нет ответа от панели. Проверьте связь с роутером и повторите запрос.')
    } finally {
      this.publish('events')
    }
  }

  async probeSubscriptionProfile(subscriptionId: string, previewToken: string, profileId: string): Promise<ProbeResult> {
    return this.withProfileProbe(() =>
      this.requestProfileProbe('/api/panel/subscriptions/probe', { subscriptionId, previewToken, profileId }))
  }

  async probeSubscriptionProfiles(subscriptionId: string, previewToken: string, ids: string[], report: (update: ProfileProbeUpdate) => void, signal?: AbortSignal) {
    return this.withProfileProbe(() => this.runProbePool(
      [...new Set(ids)], '/api/panel/subscriptions/probe', (profileId) => ({ subscriptionId, previewToken, profileId }), report, signal,
    ))
  }

  async saveSubscription(input: SubscriptionInput, baseRevision: number): Promise<void> {
    const active = await this.readConfig(true)
    if (active.config.revision !== baseRevision) throw new Error('Настройки изменились. Откройте форму заново.')
    await json('/api/panel/subscriptions', 'PUT', { ...input, revision: active.plan.revision })
    this.cacheUntil = 0
    this.publish('config', 'events')
  }

  async deleteSubscription(id: string, baseRevision: number): Promise<void> {
    const active = await this.readConfig(true)
    if (active.config.revision !== baseRevision) throw new Error('Настройки изменились. Откройте форму заново.')
    await json('/api/panel/subscriptions', 'DELETE', { id, revision: active.plan.revision })
    this.cacheUntil = 0
    this.publish('config', 'events')
  }

  async refreshSubscription(id: string, token?: string): Promise<Task> {
    if (!token) throw new Error('Сначала загрузите предпросмотр подписки.')
    const active = await this.readConfig()
    const name = active.config.subscriptions.find((item) => item.id === id)?.name ?? 'Подписка'
    return this.runTask('subscription-refresh', 'Обновление подписки', name, async () => {
      try {
        return await json('/api/panel/subscriptions/refresh', 'POST', { id, token })
      } finally {
        this.cacheUntil = 0
        this.publish('config', 'events')
      }
    })
  }

  async getZapretStrategies(): Promise<ZapretStrategy[]> {
    const runtime = await optional<LegacyRuntime>('/api/runtime')
    return (runtime?.zapret.strategies ?? []).flatMap((item) => item.services.map((service): ZapretStrategy => ({
      id: item.id, name: item.label, service, protos: ['tcp'], readiness: 'ready',
      kernelDependency: 'NFQUEUE', queueOwner: 'RouteHub',
    })))
  }

  private async prepare(config: Config, active: Snapshot): Promise<Write | null> {
    const { plan, runtime } = active
    const base = active.config
    const changes = diffConfig(base, config)
    if (!changes.length) return null
    const collections = new Set(changes.map(({ collection }) => collection))
    const unsupportedCollection = [...collections].find((name) =>
      !['policies', 'devicePolicies', 'profiles', 'sets', 'checks', 'games', 'dns', 'zapret', 'autostart', 'primaryProfileId'].includes(name))
    if (unsupportedCollection) throw new Error('Эти настройки не поддерживаются текущим обработчиком маршрутов.')

    const subsystem = (collection: string) => ['policies', 'devicePolicies', 'profiles', 'sets', 'checks', 'games'].includes(collection) ? 'plan' : collection
    if (new Set([...collections].map(subsystem)).size > 1) throw new Error('Правила, DNS, Zapret, VPN и автозапуск применяются по отдельности. Сохраните изменения по одной области.')

    if (collections.size === 1 && collections.has('games')) {
      const payload = { revision: plan.revision, games: config.games }
      return { path: '/api/plan', method: 'PUT', body: payload, legacyPlan: payload }
    }

    if (collections.size === 1 && collections.has('checks')) {
      const payload = { revision: plan.revision, savedChecks: config.checks }
      return { path: '/api/plan', method: 'PUT', body: payload, legacyPlan: payload }
    }

    if (collections.has('dns')) {
      if (base.dns.length !== 1 || config.dns.length !== 1) throw new Error('Настраивается единственный резолвер этого роутера.')
      const body = encodeDNS(config.dns[0], base.dns[0])
      if (body.lan && !active.dns?.lanAvailable) throw new Error('Перехват DNS в локальной сети недоступен на этой установке.')
      return { path: '/api/dns', method: 'PUT', body }
    }

    if (collections.has('autostart')) {
      if (!runtime) throw new Error('Управление автозапуском недоступно.')
      const next = config.autostart
      if (next.dns !== base.autostart.dns || next.initialPolicy !== 'last-applied' || next.waitForWanSec !== 0) {
        throw new Error('Настраивается автозапуск VPN и стратегий Zapret.')
      }
      const enabled = next.zapret !== base.autostart.zapret ? next.zapret : undefined
      return {
        path: '/api/runtime/boot', method: 'PUT',
        body: {
          vpn: next.vpn, profile: next.profileId ?? runtime.boot.profile,
          zapretYouTube: next.zapretYouTube !== base.autostart.zapretYouTube ? next.zapretYouTube : enabled ?? runtime.boot.zapretYouTube,
          zapretDiscord: next.zapretDiscord !== base.autostart.zapretDiscord ? next.zapretDiscord : enabled ?? runtime.boot.zapretDiscord,
        },
      }
    }

    if (collections.has('primaryProfileId')) {
      if (!runtime || !config.profiles.some(({ id }) => id === config.primaryProfileId)) throw new Error('Выберите существующий профиль VPN.')
      return { path: '/api/runtime/vpn', method: 'PUT', body: { enabled: runtime.vpn.enabled, profile: config.primaryProfileId } }
    }

    if (collections.has('zapret')) {
      const changed = config.zapret.filter((service) => !same(service, base.zapret.find(({ id }) => id === service.id)))
      if (changed.length !== 1 || config.zapret.length !== base.zapret.length) throw new Error('Применяйте изменения Zapret отдельно для каждого сервиса.')
      const next = changed[0]
      if (next.segmentIds.length || next.failAction.kind !== 'inherit' || next.selectionMode && next.selectionMode !== 'manual') {
        throw new Error('Текущее ядро применяет выбранную стратегию во всём управляемом сегменте, обычные правила действуют без Zapret.')
      }
      if (!runtime?.zapret.available) throw new Error('Zapret отключён в настройках RouteHub.')
      return { path: '/api/runtime/zapret', method: 'PUT', body: { service: next.id, enabled: next.enabled, strategy: next.strategyId } }
    }

    const currentDevices = base.devicePolicies.map(({ policyId }) => policyId).filter(Boolean)
    const deviceChange = changes.some(({ collection, id }) => collection === 'devicePolicies' || collection === 'policies' && id !== GLOBAL_ID && currentDevices.includes(id))
    const inventory = deviceChange ? await this.getInventory() : emptyInventory
    const payload = encodePlan(config, base, plan, inventory, this.imported)
    return { path: '/api/plan', method: 'PUT', body: payload, legacyPlan: payload }
  }

  private applyDetails(draft: Config, active: Snapshot, baseRevision: number): ApplyPlan {
    const changes = diffConfig(active.config, draft)
    return {
      baseRevision, changes, affected: {
        segments: knownSegment(active.plan) ? [knownSegment(active.plan)!.name] : [],
        devices: changes.filter(({ collection }) => collection === 'devicePolicies').map(({ label }) => label),
        rules: changes.some(({ collection }) => collection === 'policies') ? draft.policies.reduce((count, policy) => count + policy.rules.length, 0) : 0,
        profiles: changes.filter(({ collection }) => collection === 'profiles' || collection === 'primaryProfileId').map(({ label }) => label),
      },
      restarts: [],
      warnings: [], checks: [], errors: [], trial: noCapability,
    }
  }

  async previewApply(draft: Config, baseRevision: number): Promise<ApplyPlan> {
    const active = await this.readConfig(true)
    const details = this.applyDetails(draft, active, baseRevision)
    if (active.config.revision !== baseRevision) {
      details.errors = ['Настройки изменились. Загрузите текущую конфигурацию и повторите проверку.']
      return details
    }
    try {
      const write = await this.prepare(draft, active)
      if (write?.legacyPlan) {
        const check = await json<Partial<Pick<ApplyPlan, 'warnings' | 'errors' | 'checks' | 'restarts'>>>('/api/panel/apply/preview', 'POST', write.legacyPlan)
        details.warnings = check.warnings ?? []
        details.errors = check.errors ?? []
        details.checks = check.checks ?? []
        details.restarts = check.restarts ?? []
      }
    } catch (error) {
      details.errors = [preflightError(error)]
    }
    return details
  }

  private async writeConfig(config: Config, active: Snapshot): Promise<Config> {
    const write = await this.prepare(config, active)
    if (!write) return active.config
    if (write.legacyPlan) {
      const plan = await json<LegacyPlan>(write.path, write.method, write.body)
      config.profiles.forEach(({ id }) => this.imported.delete(id))
      const applied = this.remember({ ...active, plan, config: projectConfig(plan, active.runtime, active.dns) }).config
      this.lastApply = { revision: applied.revision, at: now(), result: 'ok' }
      this.publish('runtime', 'capabilities', 'events', 'topology')
      return applied
    }
    // Acknowledge each dedicated runtime write from its server representation
    // and retain a matching configuration snapshot even if a refresh fails.
    const next = { ...active }
    if (write.path === '/api/dns') next.dns = await json<LegacyDNS>(write.path, write.method, write.body)
    else next.runtime = await json<LegacyRuntime>(write.path, write.method, write.body)
    next.config = projectConfig(next.plan, next.runtime, next.dns)
    const applied = this.remember(next).config
    this.lastApply = { revision: applied.revision, at: now(), result: 'ok' }
    this.publish('runtime', 'capabilities', 'events')
    return applied
  }

  async saveSettings(config: Config, baseRevision: number): Promise<Config> {
    const active = await this.readConfig(true)
    if (active.config.revision !== baseRevision) throw new Error('Настройки уже изменились. Повторите редактирование с новой ревизии.')
    return this.writeConfig(config, active)
  }

  async apply(draft: Config, baseRevision: number, opts: { mode: 'full' } | { mode: 'trial'; deviceId: string; seconds: number }): Promise<ApplyResult> {
    if (opts.mode === 'trial') return unsupported()
    const active = await this.readConfig(true)
    const conflict = (current: Config): ApplyResult => ({
      ok: false, conflict: {
        serverRevision: current.revision,
        theirChanges: this.recent.has(baseRevision) ? diffConfig(this.recent.get(baseRevision)!, current) : [],
        by: 'RouteHub', at: now(),
      },
    })
    if (active.config.revision !== baseRevision) return conflict(active.config)
    const task = newTask('apply', 'Применить настройки', 'Роутер')
    try {
      await this.writeConfig(draft, active)
      const complete = finalize(task)
      this.storeTask(complete)
      this.publish('config')
      return { ok: true, task: complete }
    } catch (error) {
      if (error instanceof RequestError && error.status === 409 && this.recent.has(baseRevision)) {
        const current = (await this.readConfig(true)).config
        if (current.revision !== baseRevision) return conflict(current)
      }
      const failed = finalize(task, undefined, error)
      this.storeTask(failed)
      return { ok: true, task: failed }
    }
  }

  async rollbackTo(revision: number): Promise<Task> {
    const target = this.revisions.get(revision)
    if (!target) throw new Error('Эта ревизия недоступна. Обновите историю.')
    return this.runTask('rollback', 'Восстановить ревизию', 'Таблица маршрутизации', async () => {
      const active = await this.readConfig(true)
      await json<LegacyPlan>('/api/panel/revisions/restore', 'POST', { revision: target, baseRevision: active.plan.revision })
      this.cacheUntil = 0
      this.publish('config', 'topology', 'capabilities')
    })
  }

  async setVpnEnabled(enabled: boolean, profileId?: string): Promise<void> {
    const active = await this.readConfig(true)
    if (!active.runtime?.vpn.available) throw new Error('Добавьте профиль VPN.')
    const runtime = await json<LegacyRuntime>('/api/runtime/vpn', 'PUT', { enabled, profile: profileId ?? active.runtime.vpn.profile })
    this.remember({ ...active, runtime, config: projectConfig(active.plan, runtime, active.dns) })
    this.publish('config', 'runtime')
  }

  async evaluate(query: TraceQuery, config?: Config): Promise<TraceResult> {
    const active = await this.readConfig()
    if (config && !same(config, active.config)) throw new Error('Трассировка доступна для применённых правил.')
    const [topology, caps] = await Promise.all([this.getTopology(), this.getCapabilities()])
    const source = query.source
    const client = source.type === 'device' ? topology.devices.find(({ id }) => id === source.deviceId) : undefined
    if (source.type === 'device' && !client) throw new Error('Не удалось подтвердить сегмент этого устройства.')
    const segmentId = source.type === 'segment' ? source.segmentId : client?.segmentId
    const segment = topology.segments.find(({ id }) => id === segmentId)
    if (!segment?.routable.available) throw new Error('Этот сегмент не перехватывается RouteHub.')
    const clientMac = client?.mac
    const decision = await json<{
      rule?: string; target: string; scope: string; configuredTarget?: string; runtimeReason?: string; gamePresetId?: string
      clientPolicy?: { mode: string; active: boolean; reason?: string }
    }>('/api/evaluate', 'POST', {
      host: query.target, targetIP: query.resolvedIp, network: query.proto, port: query.port, clientMAC: clientMac,
    })
    const local = decision.scope === 'device'
    const device = active.config.devicePolicies.find(({ deviceId }) => deviceId === clientMac)
    const personal = active.config.policies.find(({ id }) => id === device?.policyId)
    const global = active.config.policies.find(({ id }) => id === GLOBAL_ID)
    const matched = local ? personal : global
    const rule = matched?.rules.find(({ name }) => name === decision.rule)
    const configuredTarget = decision.configuredTarget ?? decision.target
    const configured = fromTarget(configuredTarget)
    const effective = fromTarget(decision.target)
    const label = actionLabel(decision.target, active.config)
    const ip = query.target.includes(':') || /^(?:\d+\.){3}\d+$/.test(query.target)
    const family = (query.resolvedIp ?? query.target).includes(':') ? 'v6' : 'v4'
    const coverage = caps.interception.coverage ?? untestedCoverage()
    const supported = coverage[`${family}${query.proto}`].state !== 'unsupported'
    const limits = ['Расчёт по применённому плану. Для проверки соединения запустите сетевой тест.']
    if (!supported) limits.push('Такой транспорт или семейство IP не перехватывается в текущем режиме.')
    const steps: TraceResult['steps'] = []
    const personalLabel = personal?.name ?? device?.alias ?? client?.hostname ?? 'Устройство'
    const fixed = local && (decision.clientPolicy?.mode === 'fixed' || device?.mode === 'fixed-exit')
    if (client && !local) {
      const activePersonal = decision.clientPolicy?.active === true
      const inactiveNotes: Record<string, string> = {
        'global-only': 'Для устройства выбраны общие правила.',
        'lan-disabled': 'Перехват домашней сети выключен.',
        'missing-address': 'В политике нет закреплённого IPv4 устройства.',
        'unverified-address': 'Keenetic не подтвердил привязку IPv4 к этому устройству.',
      }
      steps.push({
        layer: 'device', scopeLabel: personalLabel, policyId: personal?.id,
        outcome: activePersonal ? 'no-match' : 'not-applicable',
        note: activePersonal ? 'Личные правила просмотрены. Подходящего правила нет, проверяются общие правила.'
          : inactiveNotes[decision.clientPolicy?.reason ?? '']
            ?? (device ? 'Применённый план передал трафик общим правилам.' : 'Личная политика не настроена.'),
      })
    }
    const scopeLabel = decision.gamePresetId ? 'Игровые пресеты' : matched?.name ?? (local ? personalLabel : 'Общие правила')
    if (!decision.rule && !fixed && !decision.gamePresetId) steps.push({
      layer: local ? 'device' : 'global', scopeLabel, policyId: matched?.id,
      outcome: 'no-match', note: 'Включённые правила этой области не совпали с запросом.',
    })
    if (decision.gamePresetId) {
      const preset = active.config.games.find(({ id }) => id === decision.gamePresetId)
      steps.push({
        layer: 'game', scopeLabel, outcome: 'matched',
        note: 'Точное совпадение игрового пресета после явных правил маршрутизации.',
        rule: {
          id: decision.gamePresetId, name: preset?.name ?? decision.rule ?? 'Игровой пресет', action: configured,
          match: `${query.resolvedIp ?? query.target}:${query.port} · ${query.proto.toUpperCase()}`, source: 'RouteHub',
        },
      })
    } else {
      steps.push({
        layer: decision.rule || fixed ? (local ? 'device' : 'global') : 'default',
        scopeLabel: decision.rule || fixed ? scopeLabel : local ? 'Выход по умолчанию устройства' : 'Общий выход по умолчанию',
        outcome: 'matched', policyId: matched?.id,
        note: fixed ? 'Для устройства указан единый выход.' : decision.rule || 'Применён выход по умолчанию.',
        ...(rule ? { rule: { id: rule.id, name: rule.name, action: configured, match: rule.matches.map(({ value }) => value).join(', '), source: 'RouteHub' } } : {}),
      })
    }
    const traversed = [decision.clientPolicy?.active || local ? personal : undefined, !local ? global : undefined]
    const policyChain = traversed.flatMap((policy) => policy ? [{ id: policy.id, name: policy.name, kind: policy.kind }] : [])
    const fallbackReason = supported ? ({
      'vpn-disabled': 'VPN выключен. Трафик по этому правилу направляется через обычный WAN.',
      'zapret-disabled': 'Обработка Zapret выключена. Трафик по этому правилу направляется через обычный WAN.',
    } as Record<string, string>)[decision.runtimeReason ?? ''] : undefined
    return {
      query,
      physical: { segmentId: segment.id, segmentName: segment.name, ssid: topology.ssids.find(({ id }) => id === client?.ssidId)?.name },
      policyChain,
      recognition: {
        via: ip ? 'ip' : 'domain', confidence: 'exact',
        detail: query.resolvedIp ? `Проверены домен и указанный IP ${query.resolvedIp}.` : 'Сопоставление запроса с применёнными правилами',
      },
      steps, configured, configuredLabel: actionLabel(configuredTarget, active.config),
      effective: { label: supported ? label : 'Перехват недоступен', viaFallback: !!fallbackReason, fallbackReason, suspended: supported && effective.kind === 'block' },
      coverage, limits,
    }
  }

  realTest(query: TraceQuery): Promise<Task> {
    return json<Task>('/api/panel/real-test', 'POST', query)
  }

  buildSupportReport(): Promise<SupportReport> {
    return json<SupportReport>('/api/panel/support-report')
  }

  async previewRuleImport(text: string, targetPolicyId: string, config: Config, input?: File | RuleImportOptions): Promise<RuleImportPreview> {
    const policy = config.policies.find(({ id }) => id === targetPolicyId)
    if (!policy) throw new Error('Выбранная политика недоступна.')
    const options = input instanceof File ? { files: [input] } : input ?? {}
    const action = options.action ?? (policy.defaultAction.kind === 'inherit' ? config.policies.find(({ id }) => id === GLOBAL_ID)?.defaultAction : policy.defaultAction)
    if (!action) throw new Error('Выберите маршрут для импортируемых правил.')
    const files = [...(options.files ?? [])]
    if (text.trim()) files.push(new File([text], 'pasted-rules.txt', { type: 'text/plain' }))
    const rows: RuleImportPreview['rows'] = []
    const matchKey = ({ name: _name, ...rule }: Omit<import('./contract').Rule, 'id'>) => JSON.stringify([
      rule.matches, rule.families, rule.protos, rule.ports, rule.action, rule.enabled,
    ])
    const previous = new Set(policy.rules.map(matchKey))
    for (const file of files) {
      const data = new FormData()
      data.set('file', file)
      data.set('target', toTarget(action))
      for (const key of ['format', 'type', 'domainMatch', 'template', 'geoSource'] as const) {
        if (options[key]) data.set(key, options[key])
      }
      const { rules } = await json<{ rules: LegacyRule[] }>('/api/import', 'POST', data)
      for (const item of rules ?? []) {
        if (rows.length >= 20_000) throw new Error('За один импорт допускается до 20 000 правил из всех источников.')
        const { id: _id, ...parsedRule } = fromRule(item, '')
        parsedRule.source = { type: 'import', label: file.name, at: now() }
        const key = matchKey(parsedRule)
        const duplicate = previous.has(key)
        previous.add(key)
        rows.push({ line: rows.length + 1, raw: item.name, match: parsedRule.matches[0], parsedRule, status: duplicate ? 'duplicate' : 'add' })
      }
    }
    return { rows, targetPolicyId, detected: 'RouteHub', format: options.format || 'Автоопределение RouteHub', limits: { maxBytes: 2 * 2 ** 20, maxLines: 20_000 } }
  }

  async previewProfileImport(text: string, options?: ProfileImportOptions): Promise<ProfileImportCandidate[]> {
    const file = options?.file ?? new File([text], options?.fileName ?? 'pasted-profile.txt', { type: 'text/plain' })
    const data = new FormData()
    data.set('file', file)
    if (options?.awgVersion) data.set('awgVersion', options.awgVersion)
    if (options?.interface) data.set('interface', options.interface)
    const response = await json<{ profiles: LegacyProfile[]; note?: string }>('/api/profiles/import', 'POST', data)
    this.previews.clear()
    return response.profiles.map((item) => {
      const profile = fromProfile(item)
      this.previews.set(item.id, item)
      return {
        key: item.id, raw: '', protocol: item.protocol, name: profile.name, transport: profile.transport,
        server: profile.server, status: 'ok', adapter: profile.adapter.engine,
        alternatives: [], requires: [], reason: response.note ?? profile.adapter.reason,
      }
    })
  }

  stageImportedProfile(key: string, profileId: string) {
    const profile = this.previews.get(key)
    if (!profile) throw new Error('Создайте новый предпросмотр профиля.')
    this.imported.set(profileId, profile)
    this.previews.delete(key)
    while (this.imported.size > 256) this.imported.delete(this.imported.keys().next().value!)
  }

  async probeImportedProfile(key: string): Promise<ProbeResult> {
    const entry = this.previews.get(key)
    if (!entry || entry.protocol !== 'vless' || (!entry.uri && !entry.outbound)) {
      throw new Error('Для проверки до добавления нужен профиль VLESS.')
    }
    return this.withProfileProbe(() =>
      this.requestProfileProbe('/api/panel/profiles/import/probe', { uri: entry.uri, outbound: entry.outbound }))
  }

  async replaceProfileConnection(profileId: string, key: string): Promise<Config> {
    const imported = this.previews.get(key)
    if (!imported) throw new Error('Создайте новый предпросмотр профиля.')
    const active = await this.readConfig(true)
    const oldProfile = active.plan.profiles.find(({ id }) => id === profileId)
    if (!oldProfile) throw new Error('Профиль удалён. Обновите список.')
    if (imported.protocol !== oldProfile.protocol) throw new Error('Добавьте новый профиль, чтобы использовать другой протокол.')
    const payload = encodePlan(active.config, active.config, active.plan, emptyInventory, this.imported)
    const { awgNative: _kind, server: _server, label: _label, location: _location, ...secret } = imported
    payload.profiles = payload.profiles.map((profile) => profile.id === profileId
      ? { ...profile, ...secret, id: profileId }
      : profile)
    const plan = await json<LegacyPlan>('/api/plan', 'PUT', payload)
    this.previews.delete(key)
    delete this.probes[profileId]
    const config = this.remember({ ...active, plan, config: projectConfig(plan, active.runtime, active.dns) }).config
    this.lastApply = { revision: config.revision, at: now(), result: 'ok' }
    this.publish('config', 'runtime', 'capabilities', 'events')
    return config
  }

  async probeProfiles(ids: string[]): Promise<Task> {
    const profiles = [...new Set(ids)]
    if (!profiles.length) throw new Error('Выберите профили для проверки.')
    const labels = new Map(this.snapshot?.config.profiles.map(({ id, alias, name }) => [id, alias ?? name]))
    const task = newTask('probe', 'Проверка профилей VPN', 'HTTPS через профиль')
    task.steps = profiles.map((id) => ({ label: labels.get(id) ?? id, state: 'pending' }))
    this.acquireProfileProbe()
    this.storeTask(task)
    void this.runProfileProbes(task, profiles).catch((error: unknown) => {
      this.storeTask(finalize(task, undefined, error instanceof Error ? error : new Error(String(error))))
    }).finally(() => { this.profileProbeBusy = false })
    return task
  }

  private acquireProfileProbe() {
    if (this.profileProbeBusy) throw new Error('Дождитесь завершения текущей проверки профилей.')
    this.profileProbeBusy = true
  }

  private async withProfileProbe<T>(run: () => Promise<T>): Promise<T> {
    this.acquireProfileProbe()
    try {
      return await run()
    } finally {
      this.profileProbeBusy = false
    }
  }

  private async requestProfileProbe(path: string, body: object, signal?: AbortSignal, shouldRetry = () => true): Promise<ProbeResult> {
    const deadline = performance.now() + probeQueueTimeoutMs
    for (;;) {
      try {
        return toProbe(await json<CheckResponse>(path, 'POST', body, signal))
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 429 || !shouldRetry()) throw error
        const delay = Math.max(250, error.retryAfterMs ?? 1000)
        if (performance.now() + delay >= deadline) throw error
        await waitForProbeSlot(delay, signal)
        if (!shouldRetry()) throw error
      }
    }
  }

  private async runProbePool(
    profiles: string[], path: string, body: (profileId: string) => object, report: (update: ProfileProbeUpdate) => void, signal?: AbortSignal,
  ) {
    if (!profiles.length || signal?.aborted) return
    const count = profiles.length > 1 ? (await this.getCapabilities()).profileProbeConcurrency : 1
    const concurrency = count && Number.isSafeInteger(count) && count > 0 ? Math.min(count, 4) : 1
    let nextIndex = 0
    let stopped: string | undefined
    const worker = async () => {
      while (!stopped && !signal?.aborted && nextIndex < profiles.length) {
        const profileId = profiles[nextIndex++]
        report({ profileId, state: 'running' })
        try {
          const result = await this.requestProfileProbe(path, body(profileId), signal, () => !stopped && !signal?.aborted)
          if (!signal?.aborted) report({ profileId, state: 'done', result })
        } catch (error) {
          const detail = preflightError(error)
          if (error instanceof RequestError && [401, 403, 409].includes(error.status)) stopped = detail
          if (!signal?.aborted) report({ profileId, state: 'error', error: detail })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(profiles.length, concurrency) }, worker))
    if (stopped && !signal?.aborted) {
      for (const profileId of profiles.slice(nextIndex)) report({ profileId, state: 'skipped', error: stopped })
    }
  }

  private async runProfileProbes(task: Task, profiles: string[]) {
    const steps = [...task.steps]
    const positions = new Map(profiles.map((id, index) => [id, index]))
    const results = new Map<string, ProbeResult>()
    let passed = 0
    let skipped = 0

    await this.runProbePool(profiles, '/api/runtime/latency', (profile) => ({ profile }), (update) => {
      const { profileId, state } = update
      const index = positions.get(profileId)!
      const label = task.steps[index].label
      if (state === 'running') {
        this.probes[profileId] = { state: 'probing', method: 'https' }
        steps[index] = { label, state }
      } else if (state === 'skipped') {
        skipped++
        steps[index] = { label, state }
      } else {
        const probe: ProbeResult = state === 'done' ? update.result : { state: 'untested', method: 'https', note: update.error }
        this.probes[profileId] = probe
        results.set(profileId, probe)
        if (probe.state === 'ok') passed++
        steps[index] = {
          label,
          state: probe.state === 'ok' ? 'done' : 'error',
          detail: probe.medianMs == null ? probe.note : `${probe.medianMs} мс`,
        }
      }
      const running = steps.filter(({ state }) => state === 'running').length
      this.storeTask({ ...task, steps: [...steps], summary: `Проверено ${results.size} из ${profiles.length}. Одновременно проверяется: ${running}.` })
    })

    const ordered = profiles.flatMap((profileId) => {
      const result = results.get(profileId)
      return result ? [{ profileId, ...result }] : []
    })
    this.storeTask({
      ...task, steps, result: ordered,
      state: passed ? 'done' : 'error', finishedAt: now(),
      summary: `Доступно профилей: ${passed} из ${profiles.length}.` + (skipped ? ` Пропущено: ${skipped}.` : ''),
    })
  }

  async zapretCheck(service: ZapretServiceId, strategyId: string, phase: ZapretCheckResult['phase']): Promise<Task> {
    const active = await this.readConfig(true)
    const selected = active.runtime?.zapret[service]
    if (!selected?.enabled || selected.strategy !== strategyId) throw new Error('Проверка применяется только к активной стратегии этого сервиса.')
    return this.runTask('zapret-check', `Проверить ${zapretName(service)}`, 'Zapret', async (): Promise<ZapretCheckResult> => {
      const reply = await json<CheckResponse>('/api/zapret/check', 'POST', { service })
      this.zapretProbe.set(service, { enabled: selected.enabled, strategy: selected.strategy, reply })
      return { service, strategyId, phase, items: [checkItem(reply, service, 'HTTPS через очередь Zapret', 'TCP')], at: now() }
    })
  }

  async zapretAutoSelect(service: ZapretServiceId, _preferred: string): Promise<Task> {
    return this.runTask('zapret-check', `Подобрать стратегию для ${zapretName(service)}`, 'Zapret', async (): Promise<ZapretAutoSelectResult> => {
      const active = await this.readConfig(true)
      const { checks, runtime } = await json<{ checks: CheckResponse[]; runtime: LegacyRuntime }>('/api/runtime/zapret/auto', 'POST', { service })
      this.remember({ ...active, runtime, config: projectConfig(active.plan, runtime, active.dns) })
      this.publish('config')
      return {
        service, applied: true, strategyId: checks.some(({ status }) => status === 'verified') ? runtime.zapret[service].strategy || null : null,
        lastCandidateId: checks.at(-1)?.id ?? null,
        items: checks.map((row, index) => checkItem(row, row.id ?? String(index), row.id ?? 'Проверка стратегии', 'TCP')),
      }
    })
  }

  async dnsCheck(policyId: string): Promise<Task> {
    const { config, dns } = await this.readConfig(true)
    if (!dns || policyId !== DNS_ID) throw new Error('Этот резолвер недоступен.')
    return this.runTask('dns-check', 'Проверить DNS', 'Резолвер RouteHub', async (): Promise<DnsCheckResult> => {
      const { servers } = await json<{ servers: CheckResponse[] }>('/api/dns/test', 'POST', {
        protocol: dns.protocol, primary: dns.primary, secondary: dns.secondary ?? '',
      })
      const primary = servers.find(({ role }) => role === 'primary')
      const fallback = servers.find(({ role }) => role === 'secondary')
      const dnsProbe = (reply: CheckResponse): ProbeResult => ({ ...toProbe(reply), method: dns.protocol === 'doh' ? 'https' : 'tcp' })
      if (primary) {
        this.dnsProbe = {
          revision: config.revision,
          result: { primary: dnsProbe(primary), fallback: fallback ? dnsProbe(fallback) : null, active: 'unknown' },
        }
      }
      return {
        policyId, at: now(),
        items: servers.map((server, index) => checkItem(server, server.role ?? String(index), server.role === 'primary' ? 'Основной сервер DNS' : 'Резервный сервер DNS', dns.protocol === 'plain' ? 'UDP' : dns.protocol.toUpperCase())),
      }
    })
  }

  async exportBackup(scope: 'rules' | 'configuration', deviceMAC?: string): Promise<Blob> {
    return (await request('/api/backup', 'POST', { scope, ...(deviceMAC ? { deviceMAC } : {}) })).blob()
  }

  async checkBoot(): Promise<{ id: string; status: string; message: string }[]> {
    const result = await json<{ checks: { id: string; status: string; message: string }[] }>('/api/runtime/boot/check', 'POST', {})
    return result.checks
  }
}
