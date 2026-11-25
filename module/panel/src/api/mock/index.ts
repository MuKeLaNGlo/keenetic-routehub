/**
 * In-browser mock of the RouteHub daemon.
 *
 * Server state lives in localStorage, so two open tabs share one "router":
 * a revision applied in one tab really conflicts with a draft in the other.
 * Read latency, long-running tasks and the trial-apply timer are simulated.
 */
import type {
  ApplyPlan,
  ApplyResult,
  ChangeTopic,
  CheckComparison,
  Config,
  DnsCheckResult,
  EntityChange,
  JournalEvent,
  ProfileImportCandidate,
  Revision,
  RouteHubApi,
  RuleImportPreview,
  RuleImportRow,
  Runtime,
  ServiceCheckItem,
  SubscriptionPreview,
  SubscriptionStatus,
  Task,
  TaskKind,
  TaskStep,
  TraceQuery,
  UpdateComponent,
  UpdateInfo,
  ZapretAutoSelectResult,
  ZapretCheckResult,
  ZapretServiceId,
} from '../contract'
import { diffConfig } from '@/lib/configDiff'
import { serverHost, validDnsAddress } from '@/lib/dnsAddress'
import { evaluate, isIp, policyChain, type EvalCtx } from './evaluate'
import { DEFAULT_FLAGS, overlayCaps, overlayRuntime, overlayTopology, trafficSeries, type ScenarioFlags } from './scenarios'
import {
  ago,
  inMin,
  seedCapabilities,
  seedConfig,
  seedEvents,
  seedFlows,
  seedGeo,
  seedRevisions,
  seedRuntime,
  seedStrategies,
  seedSubscriptionStatus,
  seedTopology,
  seedUpdates,
} from './seed'

// Bump when the stored shape changes (v2: set fetch status moved from Config to Runtime).
const STORAGE_KEY = 'routehub-mock-server-v2'
const OFFLINE_ERROR = 'Нет связи с роутером: запрос не дошёл до демона RouteHub'

interface ServerState {
  config: Config
  runtime: Runtime
  revisions: Revision[]
  events: JournalEvent[]
  tasks: Task[]
  subs: SubscriptionStatus[]
  updates: UpdateInfo[]
  flags: ScenarioFlags
  /** Config to restore if a trial expires. */
  trialPrev: Config | null
  /** Snapshot of `config` before the last subscription refresh preview applied. */
  subscriptionApplied: boolean
  /** Full config per revision the daemon has loaded (bounded). */
  snapshots: Record<number, Config>
}

function fresh(): ServerState {
  const c148 = seedConfig()
  // r147: before the vacuum's local overrides
  const c147: Config = structuredClone(c148)
  c147.revision = 147
  c147.devicePolicies = c147.devicePolicies.filter((d) => d.deviceId !== 'd-vacuum')
  c147.policies = c147.policies.filter((p) => p.id !== 'pol-dev-vacuum')
  // r145: stream group still suspended on failure
  const c145: Config = structuredClone(c147)
  c145.revision = 145
  c145.exitGroups.find((g) => g.id === 'grp-stream')!.failAction = { kind: 'suspend' }
  return {
    config: c148,
    runtime: seedRuntime(),
    revisions: seedRevisions(),
    events: seedEvents(),
    tasks: [],
    subs: seedSubscriptionStatus(),
    updates: seedUpdates(),
    flags: { ...DEFAULT_FLAGS },
    trialPrev: null,
    subscriptionApplied: false,
    snapshots: { 145: c145, 147: c147, 148: structuredClone(c148) },
  }
}

const clone = <T,>(v: T): T => structuredClone(v)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export class MockRouteHub implements RouteHubApi {
  private s: ServerState
  private storedState: string | null = null
  private listeners = new Set<(t: ChangeTopic) => void>()
  private timers = new Map<string, number>()

  constructor() {
    this.s = this.load()
    window.addEventListener('storage', (e) => {
      if (e.key !== STORAGE_KEY) return
      this.s = this.load()
      ;(['config', 'runtime', 'events', 'tasks', 'topology', 'capabilities'] as ChangeTopic[]).forEach((t) => this.emit(t, false))
    })
    this.resumeTrial()
    // Runtime "ticks": link heartbeat + probe freshness.
    window.setInterval(() => {
      this.s.runtime.link.lastSyncAt = new Date().toISOString()
      this.emit('runtime', false)
    }, 5000)
  }

  /* ───────────── persistence / plumbing ───────────── */

  private load(): ServerState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      this.storedState = raw
      if (raw) return { ...fresh(), ...JSON.parse(raw) }
    } catch {
      /* corrupted → reseed */
    }
    return fresh()
  }
  private save() {
    const raw = JSON.stringify(this.s)
    localStorage.setItem(STORAGE_KEY, raw)
    this.storedState = raw
  }
  private emit(t: ChangeTopic, persist = true) {
    if (persist) this.save()
    this.listeners.forEach((l) => l(t))
  }
  private async latency(min = 120, max = 380) {
    const f = this.s.flags
    if (f.link === 'offline') {
      await sleep(900)
      throw new Error(OFFLINE_ERROR)
    }
    await sleep(f.link === 'slow' ? 1400 + Math.random() * 600 : min + Math.random() * (max - min))
  }
  private ctx(config?: Config): EvalCtx {
    return {
      config: config ?? this.s.config,
      topology: overlayTopology(seedTopology(), this.s.flags),
      runtime: overlayRuntime(this.s.runtime, this.s.flags, this.s.config),
      caps: overlayCaps(seedCapabilities(), this.s.flags),
      flows: seedFlows(),
    }
  }
  private addEvent(e: Omit<JournalEvent, 'id' | 'at'>) {
    this.s.events.unshift({ ...e, id: uid('e'), at: new Date().toISOString() })
  }
  private event(e: Omit<JournalEvent, 'id' | 'at'>) {
    this.addEvent(e)
    this.emit('events')
  }
  private requireWrite() {
    if (this.s.flags.readOnly) throw new Error('Доступ только на чтение: изменения запрещены для этого ключа панели')
  }
  private requireConfigIdle(allowOtherSubscriptions = false) {
    if (this.s.runtime.trial) throw new Error('Уже идёт пробное применение. Подтвердите или откатите его.')
    const writers = this.s.tasks.filter((task) =>
      task.state === 'running' && (task.kind === 'apply' || task.kind === 'trial' || task.kind === 'rollback' ||
        (!allowOtherSubscriptions && task.kind === 'subscription-refresh')),
    )
    const now = Date.now()
    // Mock steps take a few seconds. Closing the owning tab can leave the task marked as running.
    if (writers.some((task) => now - Date.parse(task.startedAt) < 30_000)) {
      throw new Error('Конфигурация уже обновляется. Дождитесь завершения текущей задачи.')
    }
    for (const task of writers) {
      task.state = 'error'
      task.error = 'Задача прервана до завершения проверок.'
      task.finishedAt = new Date(now).toISOString()
      task.steps.forEach((step) => {
        if (step.state === 'pending' || step.state === 'running') step.state = 'skipped'
      })
    }
    if (writers.length) this.emit('tasks')
  }

  subscribe(listener: (topic: ChangeTopic) => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /* ───────────── mock-only controls (Scenario Lab) ───────────── */

  getFlags(): ScenarioFlags {
    return clone(this.s.flags)
  }
  setFlags(patch: Partial<ScenarioFlags>) {
    const before = this.s.flags
    this.s.flags = { ...before, ...patch }
    if (patch.nlDown && !before.nlDown)
      this.event({ type: 'failover', severity: 'warn', object: { kind: 'group', id: 'grp-nl-ee', name: 'Нидерланды / Эстония' }, title: 'Переключение: NL Amsterdam → EE Tallinn', facts: [['Было', 'NL Amsterdam'], ['Стало', 'EE Tallinn'], ['Причина', '3 неуспешные HTTPS-пробы подряд'], ['Пробы EE', 'медиана 97 мс, 5/5'], ['Затронуто правил', '5']] })
    if (patch.nlEeDown && !before.nlEeDown)
      this.event({ type: 'fallback', severity: 'error', object: { kind: 'group', id: 'grp-nl-ee', name: 'Нидерланды / Эстония' }, title: 'Полный отказ группы — новые подключения приостановлены', detail: 'Правила с прямым выходом (Госуслуги, банки) продолжают работать.', facts: [['Действие при отказе', 'Приостановить (по умолчанию)'], ['Затронуто правил', '5']] })
    if (patch.streamDown && !before.streamDown)
      this.event({ type: 'fallback', severity: 'warn', object: { kind: 'group', id: 'grp-stream', name: 'Стриминг' }, title: 'Включён временный прямой выход', detail: 'Все профили группы недоступны. Разрешено настройкой группы.', facts: [['Выход', 'Напрямую · Ростелеком'], ['Причина', 'Ни один профиль не прошёл пробу 3 раза подряд']] })
    if (patch.dnsPrimaryFail && !before.dnsPrimaryFail) {
      const policy = this.s.config.dns.find((item) => item.id === 'dns-main' && item.managed)
      if (policy) {
        const live = overlayRuntime(this.s.runtime, this.s.flags, this.s.config).dns[policy.id]
        const reserve = live?.active === 'fallback' && policy.fallback
        this.event({ type: 'dns', severity: reserve ? 'warn' : 'error', object: { kind: 'dns', id: policy.id, name: policy.name }, title: reserve ? 'Основной DNS недоступен — работает резерв' : 'Основной DNS недоступен', detail: reserve ? `Резерв отвечает через ${serverHost(reserve.address)}.` : live?.fallback?.note ?? 'Рабочий резерв отсутствует.' })
      }
    }
    if (patch.zapretQueueFail && !before.zapretQueueFail)
      this.event({ type: 'zapret', severity: 'error', object: { kind: 'zapret', name: 'Zapret' }, title: 'Очередь Zapret не обслуживается', detail: 'YouTube → обычные правила сети, Discord → VPN по настройке отказа.' })
    if (patch.iotMovedToGuest !== undefined && patch.iotMovedToGuest !== before.iotMovedToGuest)
      this.emit('topology')
    if (patch.readOnly !== undefined) this.emit('capabilities')
    this.emit('runtime')
    this.emit('config', false)
  }
  /** Simulates another tab/admin saving a revision. */
  simulateOtherWriter() {
    const c = clone(this.s.config)
    const p = c.profiles.find((x) => x.id === 'p-nl-ams')!
    p.alias = 'Амстердам'
    const home = c.policies.find((x) => x.id === 'pol-seg-home')!
    const steam = home.rules.find((x) => x.id === 'h-steam')
    if (steam) steam.name = 'Steam и Epic загрузки напрямую'
    this.commit(c, 'Вкладка 2 · 192.168.1.34', 'Профиль NL: псевдоним; правило Steam', 'ok')
  }
  reset() {
    this.timers.forEach((t) => clearTimeout(t))
    this.s = fresh()
    ;(['config', 'runtime', 'events', 'tasks', 'topology', 'capabilities'] as ChangeTopic[]).forEach((t) => this.emit(t))
  }

  /* ───────────── reads ───────────── */

  async getCapabilities() {
    await this.latency(60, 120)
    return overlayCaps(seedCapabilities(), this.s.flags)
  }
  async getTopology() {
    await this.latency()
    return overlayTopology(seedTopology(), this.s.flags)
  }
  async getConfig() {
    await this.latency()
    return clone(this.s.config)
  }
  async getRuntime() {
    await this.latency(80, 200)
    return overlayRuntime(this.s.runtime, this.s.flags, this.s.config)
  }
  async getTraffic(period: '5m' | '15m' | '1h') {
    await this.latency(80, 160)
    return trafficSeries(period, this.s.flags)
  }
  async getEvents() {
    await this.latency(80, 160)
    return clone(this.s.events)
  }
  async getTasks() {
    return clone(this.s.tasks)
  }
  async getRevisions() {
    await this.latency()
    return clone(this.s.revisions)
  }
  async getGeoSources() {
    await this.latency()
    return seedGeo()
  }
  async getSubscriptionStatus() {
    await this.latency()
    return clone(this.s.subs)
  }
  async getZapretStrategies() {
    await this.latency()
    return seedStrategies()
  }
  async getClassifiedFlows() {
    await this.latency()
    return seedFlows()
  }
  async getUpdates() {
    await this.latency()
    return clone(this.s.updates)
  }

  /* ───────────── apply ───────────── */

  async previewApply(draft: Config, baseRevision: number): Promise<ApplyPlan> {
    await this.latency(300, 600)
    return this.buildApplyPlan(draft, baseRevision)
  }

  private buildApplyPlan(draft: Config, baseRevision: number): ApplyPlan {
    const base = this.s.config
    const changes = diffConfig(base, draft)
    const ctx = this.ctx()
    const errors: string[] = []
    const warnings: ApplyPlan['warnings'] = []
    errors.push(...dnsAddressErrors(base, draft))

    if (baseRevision !== base.revision)
      warnings.push({ level: 'warn', text: `Черновик основан на r${baseRevision}, на роутере уже r${base.revision}. При применении потребуется перенести правки.` })

    for (const p of draft.policies) {
      if (policyChain(draft, p.id).cycle) errors.push(`Политика «${p.name}»: циклическая ссылка на родителя`)
      for (const r of p.rules) if (!r.matches.length) errors.push(`Правило «${r.name}» в «${p.name}»: нет ни одного условия`)
      for (const r of p.rules)
        if (r.action.kind === 'vpn' && r.action.target.type === 'profile') {
          const pid = r.action.target.profileId
          const pr = draft.profiles.find((x) => x.id === pid)
          if (!pr) errors.push(`Правило «${r.name}» ссылается на удалённый профиль`)
          else if (!pr.enabled) warnings.push({ level: 'warn', text: `Правило «${r.name}» ведёт на отключённый профиль «${pr.alias ?? pr.name}» — новые соединения будут приостановлены` })
        }
    }
    for (const dp of draft.devicePolicies) {
      const d = ctx.topology.devices.find((x) => x.id === dp.deviceId)
      if (d && d.binding !== 'confirmed' && dp.mode !== 'inherit-actual')
        warnings.push({ level: 'warn', text: `«${dp.alias ?? d.hostname}»: привязка IPv4 не подтверждена — личная политика начнёт действовать после подтверждения` })
    }
    for (const g of draft.exitGroups)
      if (g.autoInclude?.includeFuture) warnings.push({ level: 'warn', text: `Группа «${g.name}» будет автоматически включать будущие узлы подписки (${g.autoInclude.filter})` })

    // Saved checks: live vs draft
    const draftCtx = this.ctx(draft)
    const checks: CheckComparison[] = draft.checks.map((chk) => {
      const q: TraceQuery = { source: chk.source, target: chk.target, proto: chk.proto, port: chk.port }
      const live = evaluate(ctx, q)
      const next = evaluate(draftCtx, q)
      const ok = next.configured.kind === chk.expect
      const changed = live.configuredLabel !== next.configuredLabel
      return {
        checkId: chk.id, name: chk.name, required: chk.required, live: live.configuredLabel, draft: next.configuredLabel, ok,
        message: ok ? (changed ? 'Путь изменится, ожидание выполняется' : 'Без изменений') : `Ожидается «${KIND_RU[chk.expect]}», получится «${next.configuredLabel}»`,
      }
    })
    checks
      .filter((c) => !c.ok)
      .forEach((c) =>
        c.required
          ? errors.push(`Обязательная проверка «${c.name}» не проходит: ${c.message}`)
          : warnings.push({ level: 'warn', text: `Проверка «${c.name}»: ${c.message}` }),
      )

    // Affected scope
    const segs = new Set<string>()
    const devs = new Set<string>()
    const profiles = new Set<string>()
    let rules = 0
    for (const ch of changes) {
      if (ch.collection === 'policies') {
        const p = draft.policies.find((x) => x.id === ch.id) ?? base.policies.find((x) => x.id === ch.id)!
        const bp = base.policies.find((x) => x.id === ch.id)
        // Rules touched, by id: added, removed, edited, or switched off/on for this scope only.
        const before = new Map((bp?.rules ?? []).map((r) => [r.id, JSON.stringify(r)]))
        const after = new Map((draft.policies.find((x) => x.id === ch.id)?.rules ?? []).map((r) => [r.id, JSON.stringify(r)]))
        for (const id of new Set([...before.keys(), ...after.keys()])) if (before.get(id) !== after.get(id)) rules++
        const offBefore = new Set(bp?.disabledParentRuleIds ?? [])
        const offAfter = new Set(draft.policies.find((x) => x.id === ch.id)?.disabledParentRuleIds ?? [])
        for (const id of new Set([...offBefore, ...offAfter])) if (offBefore.has(id) !== offAfter.has(id)) rules++
        // who uses this policy?
        for (const sp of draft.segmentPolicies) if (policyChain(draft, sp.policyId).chain.some((x) => x.id === p.id)) segs.add(segName(ctx, sp.segmentId))
        for (const dp of draft.devicePolicies)
          if ([dp.policyId, dp.sourcePolicyId].some((id) => id && policyChain(draft, id).chain.some((x) => x.id === p.id))) devs.add(devName(ctx, draft, dp.deviceId))
        for (const g of draft.deviceGroups) if (g.policyId === p.id) g.deviceIds.forEach((id) => devs.add(devName(ctx, draft, id)))
      }
      if (ch.collection === 'devicePolicies') devs.add(devName(ctx, draft, ch.id))
      if (ch.collection === 'segmentPolicies') segs.add(segName(ctx, ch.id))
      if (ch.collection === 'profiles') profiles.add(ch.label)
    }
    const restarts: string[] = []
    if (changes.some((c) => c.collection === 'profiles' && c.fields?.some((f) => f === 'adapter' || f === 'enabled'))) restarts.push('Ядро: перезагрузка конфигурации Xray / sing-box (≈2 с, активные TCP-сессии переподключатся)')
    if (changes.some((c) => c.collection === 'zapret')) restarts.push('Zapret: перезапуск очереди nfqws (≈1 с)')
    if (changes.some((c) => c.collection === 'dns')) restarts.push('DNS: перезапуск локального резолвера RouteHub (кэш будет сброшен)')

    const devOnly = changes.length > 0 && changes.every((c) => c.collection === 'devicePolicies' || (c.collection === 'policies' && draft.policies.find((p) => p.id === c.id)?.kind === 'device'))
    const devIds = new Set<string>()
    if (devOnly)
      for (const c of changes) {
        if (c.collection === 'devicePolicies') devIds.add(c.id)
        else draft.devicePolicies.filter((dp) => dp.policyId === c.id).forEach((dp) => devIds.add(dp.deviceId))
      }
    const sole = devIds.size === 1 ? [...devIds][0] : undefined

    return {
      baseRevision,
      changes,
      affected: { segments: [...segs], devices: [...devs], rules, profiles: [...profiles] },
      restarts,
      warnings,
      checks,
      errors,
      trial: sole
        ? { available: true, suggestedScope: { deviceId: sole, label: devName(ctx, draft, sole) } }
        : { available: false, reason: 'Пробное применение доступно, когда изменения затрагивают одно устройство.' },
    }
  }

  async saveSettings(config: Config, baseRevision: number): Promise<Config> {
    const candidate = clone(config)
    await this.latency(160, 300)

    const save = () => {
      // A second tab may have saved since this tab last processed storage events.
      if (this.storedState !== localStorage.getItem(STORAGE_KEY)) this.s = this.load()
      if (this.s.flags.link === 'offline') throw new Error(OFFLINE_ERROR)
      this.requireWrite()
      if (baseRevision !== this.s.config.revision) {
        throw new Error('Конфигурация уже изменилась. Обновите настройки и повторите действие.')
      }
      this.requireConfigIdle()

      const { changes, errors } = this.buildApplyPlan(candidate, baseRevision)
      if (!changes.length) return clone(this.s.config)
      if (errors.length) throw new Error(errors.join(' '))
      if (this.s.flags.applyFails) throw new Error('Сбой при применении настроек. Прежняя конфигурация сохранена.')

      this.commit(candidate, 'Панель · эта вкладка', summarize(changes), 'ok', true)
      return clone(this.s.config)
    }

    // Serialize the revision check and commit across tabs where Web Locks are available.
    const locks = globalThis.navigator?.locks
    return locks ? locks.request(STORAGE_KEY, save) : save()
  }

  async apply(draft: Config, baseRevision: number, opts: Parameters<RouteHubApi['apply']>[2]): Promise<ApplyResult> {
    await this.latency(200, 400)
    this.requireWrite()
    if (baseRevision !== this.s.config.revision) {
      const last = this.s.revisions[0]
      return { ok: false, conflict: { serverRevision: this.s.config.revision, theirChanges: diffConfig(this.baseOf(baseRevision), this.s.config), by: last.by, at: last.at } }
    }
    this.requireConfigIdle()
    const invalidDns = dnsAddressErrors(this.s.config, draft)
    if (invalidDns.length) throw new Error(invalidDns.join(' '))
    const prev = clone(this.s.config)
    const changes = diffConfig(prev, draft)
    const rev = this.nextRev()
    const trial = opts.mode === 'trial'
    const dev = trial ? devName(this.ctx(), draft, opts.deviceId) : ''
    const steps = [
      'Проверка конфигурации и ресурсов',
      `Резервная копия r${prev.revision}`,
      'Компиляция итоговой политики',
      trial ? `Применение только для «${dev}»` : 'Применение на роутере',
      'Проверка доступа к панели',
      'Контрольный трафик (обязательные проверки)',
      ...(trial ? ['Ожидание подтверждения'] : []),
    ]
    const task = this.startTask(trial ? 'trial' : 'apply', trial ? `Пробное применение · ${dev}` : `Применение r${rev}`, trial ? dev : `${changes.length} изм.`, steps)

    let revisionChanged = false
    void this.runSteps(task, async (i) => {
      if (i === 3) {
        if (this.s.config.revision !== baseRevision) {
          revisionChanged = true
          throw new Error('Конфигурация изменилась во время применения. Повторите действие для актуальной ревизии.')
        }
        if (this.s.flags.applyFails) {
          task.steps[3].detail = 'Xray: «failed to listen on 127.0.0.1:10808: address in use»'
          throw new Error('Ошибка при применении')
        }
        this.setConfig({ ...clone(draft), revision: rev })
        this.emit('config')
      }
      if (trial && i === 6) {
        const seconds = (opts as { seconds: number }).seconds
        this.s.trialPrev = prev
        this.s.runtime.trial = { taskId: task.id, scope: dev, revision: rev, expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), totalSec: seconds }
        task.steps[6].detail = `Сервер вернёт r${prev.revision} через ${seconds} с без подтверждения — даже если вкладка закрыта`
        this.emit('runtime')
        this.armTrial()
        return 'hold'
      }
      return 'next'
    }).then((res) => {
      if (res === 'error' && !revisionChanged) {
        // automatic restore of the previous working config
        this.s.config = prev
        this.s.runtime.loadedRevision = prev.revision
        task.state = 'restored'
        task.summary = `Восстановлена r${prev.revision}; откат проверен контрольным трафиком`
        task.steps.push({ label: `Восстановление r${prev.revision}`, state: 'done', detail: 'Конфигурация восстановлена, доступ к панели и контрольный трафик проверены' })
        this.pushRevision(rev, 'Применение отклонено при запуске ядра', 'rolled-back', changes.length)
        this.event({ type: 'rollback', severity: 'error', object: { kind: 'revision', name: `r${rev}` }, title: `Ошибка применения r${rev} — восстановлена r${prev.revision}`, detail: task.steps[3].detail })
        this.emit('tasks')
        this.emit('config')
        return
      }
      if (res === 'done' && !trial) {
        this.s.runtime.lastApply = { revision: rev, at: new Date().toISOString(), result: 'ok' }
        this.pushRevision(rev, summarize(changes), 'ok', changes.length)
        this.event({ type: 'apply', severity: 'ok', object: { kind: 'revision', name: `r${rev}` }, title: `Применена ревизия r${rev}`, detail: summarize(changes) })
        task.summary = 'Конфигурация применена и проверена контрольным трафиком'
        this.emit('tasks')
      }
    })
    return { ok: true, task: clone(task) }
  }

  private baseOf(rev: number): Config {
    return this.s.snapshots[rev] ?? this.s.config
  }

  private armTrial() {
    const t = this.s.runtime.trial
    if (!t) return
    const ms = Math.max(0, new Date(t.expiresAt).getTime() - Date.now())
    clearTimeout(this.timers.get('trial'))
    this.timers.set('trial', window.setTimeout(() => this.endTrial('timeout'), ms))
  }
  private resumeTrial() {
    if (this.s.runtime.trial) this.armTrial()
  }
  /** Ends a trial by restoring the previous revision: on timeout, or because the user chose to go back. */
  private endTrial(why: 'timeout' | 'user') {
    const t = this.s.runtime.trial
    if (!t || !this.s.trialPrev) return
    const prev = this.s.trialPrev
    clearTimeout(this.timers.get('trial'))
    this.s.config = prev
    this.s.runtime.loadedRevision = prev.revision
    this.s.runtime.trial = null
    this.s.trialPrev = null
    const timeout = why === 'timeout'
    const task = this.s.tasks.find((x) => x.id === t.taskId)
    if (task) {
      task.state = 'restored'
      task.finishedAt = new Date().toISOString()
      task.steps[6] = timeout
        ? { label: 'Ожидание подтверждения', state: 'error', detail: `Время истекло (${t.totalSec} с)` }
        : { label: 'Ожидание подтверждения', state: 'skipped', detail: 'Вы выбрали вернуть прежнюю конфигурацию' }
      task.steps.push({ label: `Восстановление r${prev.revision}`, state: 'done', detail: 'Выполнено сервером' })
      task.summary = timeout ? `Подтверждение не получено — восстановлена r${prev.revision}` : `Возвращена r${prev.revision} по вашему выбору`
    }
    this.pushRevision(t.revision, `Пробное применение на ${t.scope} (${timeout ? 'истекло' : 'отменено'})`, timeout ? 'trial-expired' : 'trial-cancelled', 1)
    this.event(
      timeout
        ? { type: 'trial', severity: 'warn', object: { kind: 'device', name: t.scope }, title: `Пробное применение истекло — восстановлена r${prev.revision}`, detail: `Подтверждение не получено за ${t.totalSec} с. Сервер вернул прежнюю конфигурацию.` }
        : { type: 'trial', severity: 'info', object: { kind: 'device', name: t.scope }, title: `Пробное применение отменено — восстановлена r${prev.revision}`, detail: 'Прежняя конфигурация возвращена по запросу из панели.' },
    )
    this.emit('tasks')
    this.emit('config')
    this.emit('runtime')
  }

  async confirmTrial(taskId: string) {
    await this.latency()
    this.requireWrite()
    const t = this.s.runtime.trial
    if (!t || t.taskId !== taskId) throw new Error('Пробное применение уже завершено')
    clearTimeout(this.timers.get('trial'))
    this.s.runtime.trial = null
    this.s.trialPrev = null
    this.s.runtime.lastApply = { revision: t.revision, at: new Date().toISOString(), result: 'ok' }
    const task = this.s.tasks.find((x) => x.id === taskId)
    if (task) {
      task.state = 'done'
      task.finishedAt = new Date().toISOString()
      task.steps[6] = { label: 'Ожидание подтверждения', state: 'done', detail: 'Подтверждено' }
      task.summary = `r${t.revision} сохранена как действующая`
    }
    this.pushRevision(t.revision, `Пробное применение на ${t.scope} подтверждено`, 'trial-confirmed', 1)
    this.event({ type: 'trial', severity: 'ok', object: { kind: 'device', name: t.scope }, title: `Пробное применение подтверждено — r${t.revision} действует` })
    this.emit('tasks')
    this.emit('runtime')
  }

  async rollbackTrial(taskId: string) {
    await this.latency()
    const t = this.s.runtime.trial
    if (!t || t.taskId !== taskId) return
    this.endTrial('user')
  }

  async rollbackTo(revision: number): Promise<Task> {
    await this.latency()
    this.requireWrite()
    this.requireConfigIdle()
    const snap = this.s.snapshots[revision]
    if (!snap) throw new Error(`Копия r${revision} не хранится на роутере (хранятся последние 25 ревизий с копиями)`)
    const task = this.startTask('rollback', `Возврат к r${revision}`, `r${this.s.config.revision} → r${revision}`, [
      'Проверка целостности копии', 'Сверка ссылок и совместимости', 'Применение', 'Контрольный трафик',
    ])
    void this.runSteps(task, async () => 'next').then((res) => {
      if (res !== 'done') return
      const next = this.nextRev()
      this.setConfig({ ...clone(snap), revision: next })
      this.pushRevision(next, `Возврат к содержимому r${revision}`, 'ok', 0)
      this.event({ type: 'restore', severity: 'ok', object: { kind: 'revision', name: `r${revision}` }, title: `Восстановлено содержимое r${revision} как r${next}` })
      task.summary = `Действует r${next} (= r${revision})`
      this.emit('config')
    })
    return clone(task)
  }

  private nextRev(): number {
    return Math.max(this.s.config.revision, ...this.s.revisions.map((r) => r.revision)) + 1
  }

  private commit(c: Config, by: string, summary: string, result: Revision['result'], applyNow = false) {
    const next = this.nextRev()
    const n = diffConfig(this.s.config, c).length
    const previous = this.s
    this.s = { ...previous, runtime: { ...previous.runtime }, snapshots: { ...previous.snapshots }, revisions: [...previous.revisions], events: [...previous.events] }
    try {
      this.setConfig({ ...c, revision: next })
      if (applyNow) this.s.runtime.lastApply = { revision: next, at: new Date().toISOString(), result: 'ok' }
      this.pushRevision(next, summary, result, n, by)
      this.addEvent({ type: 'apply', severity: applyNow ? 'ok' : 'info', object: { kind: 'revision', name: `r${next}` }, title: `${applyNow ? 'Применена' : 'Сохранена'} ревизия r${next}`, detail: `${by}: ${summary}` })
      this.save()
    } catch (error) {
      this.s = previous
      throw error
    }
    this.emit('events', false)
    this.emit('config', false)
    if (applyNow) this.emit('runtime', false)
  }

  /** Every config the daemon loads is snapshotted by revision (rollback + conflict diffs). */
  private setConfig(c: Config) {
    this.s.config = c
    this.s.runtime.loadedRevision = c.revision
    this.s.snapshots[c.revision] = clone(c)
    const keep = Object.keys(this.s.snapshots).map(Number).sort((a, b) => b - a).slice(0, 25)
    for (const k of Object.keys(this.s.snapshots)) if (!keep.includes(Number(k))) delete this.s.snapshots[Number(k)]
  }

  private pushRevision(revision: number, summary: string, result: Revision['result'], changes: number, by = 'Панель · эта вкладка') {
    this.s.revisions.unshift({ revision, at: new Date().toISOString(), by, summary, result, changes })
  }

  /* ───────────── diagnostics ───────────── */

  async evaluate(query: TraceQuery, config?: Config) {
    await this.latency(150, 300)
    return evaluate(this.ctx(config), query)
  }

  async realTest(query: TraceQuery): Promise<Task> {
    await this.latency()
    const tr = evaluate(this.ctx(), query)
    const f = this.s.flags
    const task = this.startTask('real-test', `Реальный запрос · ${query.target}`, tr.effective.label, ['DNS', 'Соединение', 'TLS', 'Ответ приложения'])
    const ms = [12 + rnd(20), 30 + rnd(60), 40 + rnd(80), 60 + rnd(140)]
    const isYtMedia = /googlevideo|youtubei/.test(query.target)
    void this.runSteps(task, async (i) => {
      task.steps[i].detail = `${ms[i]} мс`
      if (tr.effective.suspended && i === 1) {
        task.steps[i].detail = 'Новые соединения по этой группе приостановлены'
        throw new Error('suspended')
      }
      if (tr.configured.kind === 'block' && i === 1) {
        task.steps[i].detail = 'Заблокировано правилом'
        throw new Error('blocked')
      }
      if (i === 3 && isYtMedia && tr.configured.kind === 'zapret' && f.zapretYtPartial) {
        task.steps[i].detail = 'TLS прошёл, ответ не получен за 10 с (DPI сбрасывает поток)'
        throw new Error('app')
      }
      return 'next'
    }).then(() => {
      task.result = {
        target: query.target,
        exitLabel: tr.effective.label,
        stages: task.steps.map((s, i) => ({ stage: (['dns', 'connect', 'tls', 'app'] as const)[i], label: s.label, state: s.state === 'done' ? 'ok' : s.state === 'error' ? 'fail' : 'skipped', ms: s.state === 'done' ? ms[i] : undefined, detail: s.detail })),
        totalMs: task.state === 'done' ? ms.reduce((a, b) => a + b, 0) : undefined,
        observedFrom: 'router',
        note: 'Запрос выполнен с роутера через выбранный выход. Это подтверждает путь роутера; проверка со стороны клиента требует контрольного клиента в этой сети.',
      }
      this.emit('tasks')
    })
    return clone(task)
  }

  async observeConnections(seconds: number) {
    await this.latency(400, 800)
    return { seconds, finishedAt: new Date().toISOString(), limited: false, rows: [
      { id: 'c1', deviceId: 'd-mbp', dst: 'chatgpt.com:443', proto: 'tcp' as const, exit: 'VPN · NL Amsterdam', rule: 'ChatGPT и Claude', stalePolicy: false, bytes: 482_113 },
      { id: 'c2', deviceId: 'd-pc', dst: '155.133.252.37:27031', proto: 'udp' as const, exit: 'Напрямую · Ростелеком', rule: 'Пресет «Counter‑Strike 2»', stalePolicy: false, bytes: 3_201_442 },
      { id: 'c3', deviceId: 'd-tv', dst: 'nflxvideo.net:443', proto: 'tcp' as const, exit: 'VPN · DE Frankfurt', rule: 'Фиксированный выход', stalePolicy: false, bytes: 88_120_331 },
      { id: 'c4', deviceId: 'd-pixel', dst: 'portal.work-example.ru:443', proto: 'tcp' as const, exit: 'VPN · Офис AWG', rule: 'Рабочий портал', stalePolicy: true, bytes: 120_554 },
      { id: 'c5', deviceId: 'd-mbp', dst: 'online.sberbank.ru:443', proto: 'tcp' as const, exit: 'Напрямую · Ростелеком', rule: 'Банки напрямую', stalePolicy: false, bytes: 51_092 },
    ] }
  }

  async buildSupportReport() {
    await this.latency(500, 900)
    const caps = seedCapabilities()
    return {
      redactedCount: 23,
      sizeKb: 41,
      sections: [
        { title: 'Версии', lines: [{ key: 'Модель', value: caps.device.model }, { key: 'Прошивка', value: caps.device.firmware }, { key: 'RouteHub', value: `${caps.routehub.version} (${caps.routehub.build})` }, { key: 'Xray', value: '25.9.11' }, { key: 'sing-box', value: '1.13.2' }] },
        { title: 'Возможности', lines: [{ key: 'Перехват', value: caps.interception.label }, { key: 'IPv4 UDP', value: 'частично (TPROXY, SOCKS5)' }, { key: 'IPv6', value: 'не испытано' }] },
        { title: 'Профили', lines: [{ key: 'NL Amsterdam', value: 'vless://••••@••••:443 (uuid, sni, pbk скрыты)', redacted: true }, { key: 'Офис AWG', value: 'PrivateKey ••••, Endpoint ••••', redacted: true }, { key: 'Подписка VPNBox', value: 'https://sub.vpnbox.example/••••', redacted: true }] },
        { title: 'Устройства', lines: [{ key: 'Pixel‑8', value: 'MAC ••:••:••:••:10:8f · 10.10.0.••', redacted: true }, { key: 'MacBook‑Pro', value: 'MAC ••:••:••:••:aa:01 · 192.168.1.••', redacted: true }] },
        { title: 'Ошибки за 24 ч', lines: [{ key: 'set-cdn', value: 'HTTP 503 при обновлении' }, { key: 'geoip', value: 'подпись не прошла проверку' }] },
        { title: 'Измерения', lines: [{ key: 'NL Amsterdam', value: 'HTTPS 84 мс, 5/5' }, { key: 'NL Rotterdam', value: 'HTTPS 212 мс, 4/5' }] },
      ],
    }
  }

  /* ───────────── imports ───────────── */

  async previewRuleImport(text: string, targetPolicyId: string, config: Config): Promise<RuleImportPreview> {
    await this.latency(250, 500)
    const policy = config.policies.find((p) => p.id === targetPolicyId)
    const existing = new Set(policy?.rules.flatMap((r) => r.matches.map((m) => `${m.type}:${m.value}`)) ?? [])
    const seen = new Set<string>()
    const lines = text.split(/\r?\n/)
    const isV2fly = lines.some((l) => /^(full|domain|keyword|regexp|include):/.test(l.trim()))
    const isClash = lines.some((l) => /^(DOMAIN|DOMAIN-SUFFIX|IP-CIDR)/.test(l.trim()))
    const rows: RuleImportRow[] = []
    lines.forEach((raw, i) => {
      const l = raw.trim()
      if (!l || l.startsWith('#') || l.startsWith('//')) return
      let match: RuleImportRow['match']
      let reason: string | undefined
      const m = l.match(/^(full|domain|keyword|regexp|include):(.+)$/)
      const cl = l.match(/^(DOMAIN|DOMAIN-SUFFIX|IP-CIDR6?|DOMAIN-KEYWORD),([^,]+)/)
      if (m) {
        if (m[1] === 'full') match = { type: 'domain', value: m[2] }
        else if (m[1] === 'domain') match = { type: 'suffix', value: m[2] }
        else if (m[1] === 'include') reason = `include:${m[2]} — нужен развёрнутый локальный набор: загрузите «${m[2]}» как отдельный набор и сошлитесь на него`
        else reason = `Тип «${m[1]}» не поддерживается компилятором RouteHub`
      } else if (cl) {
        if (cl[1] === 'DOMAIN') match = { type: 'domain', value: cl[2] }
        else if (cl[1] === 'DOMAIN-SUFFIX') match = { type: 'suffix', value: cl[2] }
        else if (cl[1].startsWith('IP-CIDR')) match = { type: 'cidr', value: cl[2] }
        else reason = 'DOMAIN-KEYWORD не поддерживается'
      } else if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(l) || /^[0-9a-f:]+\/\d{1,3}$/i.test(l)) match = { type: 'cidr', value: l }
      else if (isIp(l)) match = { type: 'ip', value: l }
      else if (/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(l)) match = { type: 'suffix', value: l.replace(/^\*\./, '').toLowerCase() }
      else reason = 'Не распознано: ожидается домен, IP или CIDR'

      if (!match) return rows.push({ line: i + 1, raw, status: 'skip', reason })
      const key = `${match.type}:${match.value}`
      if (existing.has(key)) return rows.push({ line: i + 1, raw, status: 'duplicate', match, reason: `Уже есть в «${policy?.name}»` })
      if (seen.has(key)) return rows.push({ line: i + 1, raw, status: 'duplicate', match, reason: 'Повтор внутри импорта' })
      seen.add(key)
      rows.push({ line: i + 1, raw, status: 'add', match })
    })
    return {
      format: isV2fly ? 'v2fly domain-list-community' : isClash ? 'Clash (подмножество)' : 'Текст: домены / IP / CIDR',
      detected: isV2fly ? 'v2fly' : isClash ? 'clash' : 'txt',
      rows,
      targetPolicyId,
      limits: { maxLines: 50_000, maxBytes: 4 * 1024 * 1024 },
    }
  }

  async previewProfileImport(text: string): Promise<ProfileImportCandidate[]> {
    await this.latency(300, 600)
    const out: ProfileImportCandidate[] = []
    const blocks = splitProfiles(text)
    blocks.forEach((raw, i) => {
      const key = `imp-${i}`
      const name = decodeURIComponent(raw.match(/#(.+)$/)?.[1] ?? '').trim()
      if (raw.startsWith('vless://')) {
        const xhttp = /type=xhttp/.test(raw)
        const reality = /security=reality/.test(raw)
        out.push({ key, raw, protocol: 'vless', name: name || 'VLESS', transport: xhttp ? 'XHTTP · TLS' : reality ? 'REALITY · TCP' : 'TLS · TCP', server: maskHost(raw), status: 'ok', adapter: 'xray', alternatives: xhttp ? [] : ['sing-box'], reason: xhttp ? 'XHTTP: подтверждённый адаптер — Xray' : 'Совместим с действующим адаптером Xray (приоритет у проверенного)', requires: ['Xray ≥ 25.x'] })
      } else if (/^(hy2|hysteria2):\/\//.test(raw)) {
        const salamander = /obfs=salamander/.test(raw)
        out.push({ key, raw, protocol: 'hysteria2', name: name || 'Hysteria2', transport: salamander ? 'QUIC · salamander' : 'QUIC', server: maskHost(raw), status: salamander ? 'needs-other-engine' : 'ok', adapter: 'sing-box', alternatives: salamander ? [] : ['xray'], reason: salamander ? 'Параметр obfs=salamander не поддерживается Xray 25.9 — будет использован sing-box 1.13 (установлен)' : 'sing-box: подтверждённая поддержка Hysteria2', requires: ['sing-box ≥ 1.12', 'UDP до сервера'] })
      } else if (raw.startsWith('trojan://')) {
        out.push({ key, raw, protocol: 'trojan', name: name || 'Trojan', transport: /type=ws/.test(raw) ? 'TLS · WS' : 'TLS · TCP', server: maskHost(raw), status: 'ok', adapter: 'xray', alternatives: ['sing-box'], reason: 'Совместим с действующим адаптером Xray', requires: ['Xray ≥ 1.8'] })
      } else if (/\[Interface\]/.test(raw)) {
        const has = (k: string) => new RegExp(`^${k}\\s*=`, 'm').test(raw)
        const nm = raw.match(/^#\s*Name\s*=\s*(.+)$/m)?.[1] ?? 'AmneziaWG'
        if (has('I1') || has('I2')) {
          out.push({ key, raw, protocol: 'awg', name: nm, transport: 'AWG 3.1 · UDP', server: '••••:51820', status: 'engine-missing', adapter: null, alternatives: [], reason: 'Поколение 3.1 (параметры I1–I5) требует встроенный адаптер ≥ 0.10. Установлен 0.9.3.', requires: ['AWG RouteHub ≥ 0.10 (≈3 МБ, 6 МБ RAM)'] })
        } else if (has('S3') || has('S4')) {
          out.push({ key, raw, protocol: 'awg', name: nm, transport: 'AWG 2.0 · UDP', server: '••••:51820', status: 'ok', adapter: 'awg-routehub', alternatives: [], reason: 'Найдены S3/S4 — однозначно AWG 2.0. Встроенный адаптер поддерживает это поколение.', requires: ['UDP до сервера', 'Лимит: 2 одновременных экземпляра'] })
        } else if (has('Jc')) {
          out.push({ key, raw, protocol: 'awg', name: nm, transport: 'AWG · UDP', server: '••••:51820', status: 'needs-confirmation', adapter: null, alternatives: ['awg-keenetic', 'awg-routehub'], awgGenerations: ['1.0', '1.5'], reason: 'Параметры Jc/S1/S2/H1–H4 есть и в AWG 1.0, и в 1.5. Поколение нельзя определить однозначно — выберите вручную.', requires: ['Интерфейс WireGuard ASC (KeeneticOS) или встроенный адаптер'] })
        } else {
          out.push({ key, raw, protocol: 'awg', name: nm, transport: 'WireGuard', server: '••••:51820', status: 'unsupported', adapter: null, alternatives: [], reason: 'Обычный WireGuard без параметров обфускации — настройте его в KeeneticOS.', requires: [] })
        }
      } else {
        out.push({ key, raw, protocol: 'unknown', name: raw.slice(0, 24), transport: '—', server: '—', status: 'unsupported', adapter: null, alternatives: [], reason: raw.startsWith('ss://') ? 'Shadowsocks не входит в первую версию каталога' : 'Формат не распознан', requires: [] })
      }
    })
    return out
  }

  async previewSubscription(subscriptionId: string): Promise<SubscriptionPreview> {
    await this.latency(600, 1100)
    const error = this.s.flags.subscriptionFails
      ? 'Таймаут при загрузке подписки.'
      : subscriptionId === 'sub-lite' ? 'Поставщик вернул пустой список профилей.' : undefined
    if (error)
      return { subscriptionId, fetchedAt: new Date().toISOString(), ok: false, error, added: [], changed: [], missing: [], incompatible: [], ambiguous: [] }
    if (subscriptionId !== 'sub-vpnbox' || this.s.subscriptionApplied)
      return { subscriptionId, fetchedAt: new Date().toISOString(), ok: true, added: [], changed: [], missing: [], incompatible: [], ambiguous: [] }
    const usedBy = (pid: string) => [
      ...this.s.config.exitGroups.filter((g) => g.memberIds.includes(pid)).map((g) => `Группа «${g.name}»`),
      ...this.s.config.policies.flatMap((p) => p.rules.filter((r) => r.action.kind === 'vpn' && r.action.target.type === 'profile' && r.action.target.profileId === pid).map((r) => `Правило «${r.name}»`)),
    ]
    return {
      subscriptionId, fetchedAt: new Date().toISOString(), ok: true,
      added: [{ upstreamKey: 'uuid:nl-ams-02', name: 'NL-AMS-02 ⚡' }, { upstreamKey: 'uuid:pl-waw-01', name: 'PL-WAW-01' }],
      changed: [{ profileId: 'p-ee-tll', from: 'EE-TLL-02', to: 'EE Tallinn Premium', kind: 'renamed' }],
      missing: [{ profileId: 'p-us-nyc', name: 'US New York', usedBy: usedBy('p-us-nyc') }],
      incompatible: [{ upstreamKey: 'uuid:jp-tyo-ss', name: 'JP-TYO-SS', reason: 'Shadowsocks — нет адаптера в каталоге' }],
      ambiguous: [],
    }
  }

  /* ───────────── operations ───────────── */

  async probeProfiles(ids: string[]): Promise<Task> {
    await this.latency()
    const limit = 3
    const task = this.startTask('probe', ids.length === 1 ? 'Проверка профиля' : `Проверка ${ids.length} профилей`, `HTTPS через профиль · одновременно ≤ ${limit}`, ids.map((id) => this.s.config.profiles.find((p) => p.id === id)?.name ?? id))
    ids.forEach((id) => (this.s.runtime.profiles[id] = { ...(this.s.runtime.profiles[id] ?? { method: 'https' }), state: 'probing' }))
    this.emit('runtime')
    void this.runSteps(task, async (i) => {
      const id = ids[i]
      const p = this.s.config.profiles.find((x) => x.id === id)
      const prev = this.s.runtime.profiles[id]
      if (p && !p.enabled) {
        this.s.runtime.profiles[id] = { state: 'disabled', method: 'handshake' }
        task.steps[i].detail = 'Отключён'
      } else if (p?.lifecycle === 'missing-upstream') {
        this.s.runtime.profiles[id] = { state: 'missing', method: 'https', note: 'Исчез из подписки' }
        task.steps[i].detail = 'Исчез из подписки'
      } else {
        const med = Math.round((prev?.medianMs ?? 90) * (0.85 + Math.random() * 0.3))
        this.s.runtime.profiles[id] = { state: id === 'p-nl-rtm' ? 'degraded' : 'ok', method: 'https', medianMs: med, jitterMs: Math.round(med * 0.08), lossPct: id === 'p-nl-rtm' ? 20 : 0, samples: 5, measuredAt: new Date().toISOString() }
        task.steps[i].detail = `${med} мс`
      }
      this.emit('runtime')
      return 'next'
    }, 450)
    return clone(task)
  }

  async refreshSubscription(subscriptionId: string): Promise<Task> {
    await this.latency()
    this.requireWrite()
    this.requireConfigIdle(true)
    const sub = this.s.config.subscriptions.find((s) => s.id === subscriptionId)!
    const failure = this.s.flags.subscriptionFails
      ? { code: 'TIMEOUT', reason: 'Таймаут при загрузке подписки.' }
      : subscriptionId === 'sub-lite' ? { code: 'EMPTY_RESPONSE', reason: 'Поставщик вернул пустой список профилей.' } : null
    const task = this.startTask('subscription-refresh', `Обновление подписки «${sub.name}»`, sub.name, [
      'Загрузка через начальный маршрут (напрямую)', 'Проверка размера и распаковки', 'Разбор профилей', 'Сопоставление по устойчивым ключам', 'Сохранение снимка',
    ])
    void this.runSteps(task, async (i) => {
      if (failure && i === (failure.code === 'TIMEOUT' ? 0 : 2)) {
        task.steps[i].detail = failure.reason
        throw new Error(failure.reason)
      }
      return 'next'
    }).then((res) => {
      if (res === 'cancelled') return
      const st = this.s.subs.find((x) => x.subscriptionId === subscriptionId)!
      if (res === 'error') {
        st.lastAttempt = { at: new Date().toISOString(), ok: false, code: failure?.code, reason: failure?.reason }
        task.summary = `Рабочий снимок ${st.lastSuccess?.revision ?? '—'} сохранён`
        this.event({ type: 'subscription', severity: 'error', object: { kind: 'subscription', id: subscriptionId, name: sub.name }, title: 'Не удалось обновить подписку', detail: `${failure?.reason ?? 'Ошибка загрузки.'} Рабочий каталог сохранён.` })
        this.emit('tasks')
        return
      }
      if (subscriptionId === 'sub-vpnbox' && !this.s.subscriptionApplied) {
        const c = clone(this.s.config)
        const ee = c.profiles.find((p) => p.id === 'p-ee-tll')!
        if (ee.origin.type === 'subscription') ee.origin.upstreamName = 'EE Tallinn Premium'
        ee.lifecycle = 'renamed-upstream'
        ee.alias = ee.alias ?? 'EE Tallinn'
        const us = c.profiles.find((p) => p.id === 'p-us-nyc')!
        us.lifecycle = 'missing-upstream'
        c.profiles.push({
          id: 'p-nl-ams2', name: 'NL Amsterdam 2', protocol: 'vless', transport: 'REALITY · TCP', server: 'nl-••••.example:443', country: 'nl', tags: [],
          origin: { type: 'subscription', subscriptionId, upstreamName: 'NL-AMS-02 ⚡', upstreamKey: 'uuid:nl-ams-02' },
          adapter: { mode: 'auto', engine: 'xray', reason: 'Совместим с действующим адаптером Xray' }, enabled: true, favorite: false, lifecycle: 'active',
        }, {
          id: 'p-pl-waw', name: 'PL Warsaw', protocol: 'vless', transport: 'REALITY · TCP', server: 'pl-••••.example:443', country: 'pl', tags: [],
          origin: { type: 'subscription', subscriptionId, upstreamName: 'PL-WAW-01', upstreamKey: 'uuid:pl-waw-01' },
          adapter: { mode: 'auto', engine: 'xray', reason: 'Совместим с действующим адаптером Xray' }, enabled: true, favorite: false, lifecycle: 'active',
        })
        this.s.runtime.profiles['p-us-nyc'] = { state: 'missing', method: 'https', note: 'Исчез из подписки' }
        this.s.runtime.profiles['p-nl-ams2'] = { state: 'untested', method: 'https' }
        this.s.runtime.profiles['p-pl-waw'] = { state: 'untested', method: 'https' }
        this.s.subscriptionApplied = true
        st.lastSuccess = { at: new Date().toISOString(), revision: 'snap-0043', profiles: 5 }
        st.lastAttempt = { at: new Date().toISOString(), ok: true }
        this.commit(c, `Подписка «${sub.name}»`, 'snap-0043: +2, переименован 1, исчез 1', 'ok')
        this.event({ type: 'subscription', severity: 'warn', object: { kind: 'subscription', id: subscriptionId, name: sub.name }, title: 'Подписка обновлена · snap-0043', detail: '+2 новых, 1 переименован (псевдоним и группы сохранены), 1 исчез — используется в группе «Стриминг».' })
        task.summary = 'snap-0043 · +2 · переименован 1 · исчез 1'
      } else {
        st.lastAttempt = { at: new Date().toISOString(), ok: true }
        task.summary = 'Изменений нет'
      }
      this.emit('tasks')
    })
    return clone(task)
  }

  async zapretCheck(service: ZapretServiceId, strategyId: string, phase: ZapretCheckResult['phase']): Promise<Task> {
    await this.latency()
    const f = this.s.flags
    const viaVpn = strategyId.startsWith('vpn')
    const strategy = seedStrategies().find((s) => s.id === strategyId && s.service === service)
    if (phase === 'selected' && (!strategy || strategy.readiness === 'needs-kernel-module')) {
      throw new Error('Выбранная стратегия недоступна на этой установке')
    }
    const items = zapretCheckItems(service)
    const phaseLabel = { before: 'до применения', after: 'после', selected: 'проверка выбранной' }[phase]
    const task = this.startTask('zapret-check', `${service === 'youtube' ? 'YouTube' : 'Discord'} · ${viaVpn ? 'через VPN' : strategy?.name ?? strategyId} · ${phaseLabel}`, phase, items.map((x) => x.label))
    void this.runSteps(task, async (i) => {
      const item = simulateZapretItem(items[i], strategyId, strategy?.protos.includes('udp') ?? false, f, phase === 'selected')
      task.steps[i].state = item.state === 'ok' ? 'done' : item.state === 'fail' ? 'error' : 'skipped'
      task.steps[i].detail = item.detail
      return 'next'
    }, 520, true).then(() => {
      task.result = { service, strategyId, phase, at: new Date().toISOString(), items: stepItems(task, items) } satisfies ZapretCheckResult
      this.emit('tasks')
    })
    return clone(task)
  }

  async zapretAutoSelect(service: ZapretServiceId, preferredStrategyId: string): Promise<Task> {
    await this.latency()
    const flags = this.s.flags
    const candidates = seedStrategies().filter((strategy) => strategy.service === service && strategy.readiness !== 'needs-kernel-module')
    const priority = (strategy: typeof candidates[number]) => strategy.id === preferredStrategyId ? 0 : strategy.readiness === 'ready' ? 1 : 2
    candidates.sort((left, right) => priority(left) - priority(right))
    const task = this.startTask('zapret-check', `Подбор Zapret · ${service === 'youtube' ? 'YouTube' : 'Discord'}`, service, candidates.map((strategy) => strategy.name))

    const search = async () => {
      const result: ZapretAutoSelectResult = { service, strategyId: null, lastCandidateId: null, items: [] }
      for (const [index, strategy] of candidates.entries()) {
        if (task.state !== 'running') return
        const step = task.steps[index]
        step.state = 'running'
        this.emit('tasks')
        await sleep(720)
        const taskIndex = this.s.tasks.findIndex((item) => item.id === task.id)
        if (taskIndex === -1 || this.s.tasks[taskIndex].state !== 'running') return
        // Another tab may have replaced the in-memory state while the probe ran.
        this.s.tasks[taskIndex] = task
        const items = zapretCheckItems(service).map((item) => simulateZapretItem(item, strategy.id, strategy.protos.includes('udp'), flags, true))
        const required = items.filter((item) => item.proto.includes('TCP'))
        const passed = required.filter((item) => item.state === 'ok').length
        result.lastCandidateId = strategy.id
        result.items = items
        const matched = required.length > 0 && passed === required.length
        step.state = matched ? 'done' : 'error'
        step.detail = `Обязательные проверки TCP: ${passed} из ${required.length}`
        if (matched) {
          result.strategyId = strategy.id
          for (const skipped of task.steps.slice(index + 1)) skipped.state = 'skipped'
          break
        }
        this.emit('tasks')
      }
      task.result = result
      task.state = result.strategyId ? 'done' : 'error'
      task.finishedAt = new Date().toISOString()
      task.summary = result.strategyId
        ? 'Найдена стратегия, прошедшая обязательные проверки TCP'
        : 'Ни одна доступная стратегия не прошла обязательные проверки TCP'
      this.emit('tasks')
    }
    void search()
    return clone(task)
  }

  async dnsCheck(policyId: string): Promise<Task> {
    await this.latency()
    const policy = this.s.config.dns.find((item) => item.id === policyId && item.managed)
    if (!policy) throw new Error('Политика DNS не применяется RouteHub.')

    const live = overlayRuntime(this.s.runtime, this.s.flags, this.s.config).dns[policyId]
    const primaryHost = serverHost(policy.primary.address)
    const backupHost = policy.fallback ? serverHost(policy.fallback.address) : undefined
    const verified = live.active !== 'none'
    const filtering = policy.filteringEnabled ?? policy.blocklists.length > 0
    const protocol = { doh: 'DoH · HTTPS', dot: 'DoT · TLS', udp: 'DNS · UDP' } as const
    const checks: (Pick<TaskStep, 'label' | 'state' | 'detail'> & { proto: string })[] = [
      { label: 'Адрес основного сервера', proto: 'DNS', state: 'done', detail: primaryHost },
      { label: 'Достижимость основного', proto: protocol[policy.primary.protocol], state: live.primary.state === 'ok' ? 'done' : 'error', detail: live.primary.note ?? `${live.primary.medianMs ?? '—'} мс` },
      policy.primary.protocol === 'udp'
        ? { label: 'Шифрование основного', proto: 'UDP', state: 'skipped', detail: 'Обычный DNS использует UDP без шифрования.' }
        : { label: 'Шифрование основного', proto: 'TLS', state: live.primary.state === 'ok' ? 'done' : 'error', detail: live.primary.note ?? 'TLS-рукопожатие прошло.' },
      policy.fallback && live.fallback
        ? { label: 'Резервный сервер', proto: protocol[policy.fallback.protocol], state: live.fallback.state === 'ok' ? 'done' : live.fallback.state === 'disabled' ? 'skipped' : 'error', detail: live.fallback.note ?? `${live.fallback.medianMs ?? '—'} мс · ${backupHost}` }
        : { label: 'Резервный сервер', proto: 'DNS', state: 'skipped', detail: 'Резерв не настроен.' },
      { label: 'Обычное разрешение · example.org', proto: 'DNS', state: verified ? 'done' : 'error', detail: verified ? (live.active === 'fallback' ? `Ответ через резерв · ${backupHost}` : `Ответ через основной · ${primaryHost}`) : 'Рабочий сервер не выбран.' },
      { label: 'Локальное имя · nas.home.arpa (Keenetic)', proto: 'DNS', state: 'done', detail: '192.168.1.5 · штатный резолвер' },
      { label: 'Настройки DNS-фильтрации', proto: 'DNS', state: filtering && policy.blocklists.length ? 'done' : 'skipped', detail: filtering ? `Списков: ${policy.blocklists.length}, исключений: ${policy.exceptions.length}.` : 'DNS-фильтрация выключена.' },
    ]

    const task = this.startTask('dns-check', 'Проверка DNS', policyId, checks.map(({ label }) => label))
    void this.runSteps(task, async (i) => {
      Object.assign(task.steps[i], { state: checks[i].state, detail: checks[i].detail })
      return 'next'
    }, 380, true).then(() => {
      task.result = { policyId, at: new Date().toISOString(), items: stepItems(task, checks.map(({ label, proto }, i) => ({ id: `s${i}`, label, proto }))) } satisfies DnsCheckResult
      this.emit('tasks')
    })
    return clone(task)
  }

  async checkUpdate(component: UpdateComponent): Promise<Task> {
    await this.latency()
    const u = this.s.updates.find((x) => x.component === component)!
    const o = this.s.flags.updateOutcome
    u.state = 'checking'
    this.emit('runtime')
    const task = this.startTask('update', `Проверка совместимости · ${u.name} ${u.target}`, u.name, [
      'Получение кандидата', 'Подпись и хеш из доверенного канала', 'Совместимость KeeneticOS 5.0.4 и aarch64', 'Свободное место', 'RAM на время проверки', 'Сверка с текущими профилями',
    ])
    void this.runSteps(task, async (i) => {
      const s = task.steps[i]
      if (i === 1) s.detail = u.signature === 'verified' ? 'SHA-256 совпадает, подпись проверена' : 'Подпись не проверена'
      if (i === 2 && o === 'incompatible') {
        s.detail = `${u.target} требует ядро Linux ≥ 5.10 (у KeeneticOS 5.0.4 — 4.9)`
        throw new Error('incompatible')
      }
      if (i === 2) s.detail = 'Совместимо'
      if (i === 3 && o === 'no-space') {
        s.detail = 'Нужно 34 МБ (кандидат + резервная копия), свободно 21 МБ на /opt'
        throw new Error('space')
      }
      if (i === 3) s.detail = 'Нужно 34 МБ, свободно 212 МБ'
      if (i === 4) s.detail = 'Пик 61 МБ, свободно 180 МБ'
      if (i === 5) s.detail = 'Все 5 профилей Xray совместимы'
      return 'next'
    }).then((res) => {
      u.state = res === 'error' ? 'blocked' : 'available'
      u.checks = task.steps.map((s) => ({ label: s.label, state: s.state === 'done' ? 'ok' : s.state === 'error' ? 'fail' : 'untested', detail: s.detail }))
      task.summary = res === 'error' ? 'Обновление невозможно — текущая версия продолжает работать' : 'Совместимо, можно обновлять'
      this.emit('tasks')
      this.emit('runtime')
    })
    return clone(task)
  }

  async runUpdate(component: UpdateComponent): Promise<Task> {
    await this.latency()
    this.requireWrite()
    const u = this.s.updates.find((x) => x.component === component)!
    const o = this.s.flags.updateOutcome
    const from = u.current
    const to = u.target!
    u.state = 'updating'
    const task = this.startTask('update', `Обновление · ${u.name} ${from} → ${to}`, u.name, [
      'Резервная копия текущей версии', 'Проверка конфигурации кандидатом', 'Пробный запуск', 'Переключение', 'Контрольный трафик',
    ])
    void this.runSteps(task, async (i) => {
      if (i === 4 && o === 'verify-fail') {
        task.steps[4].detail = 'Обязательная проверка «ChatGPT из «Дом» через VPN»: TLS не завершён'
        throw new Error('verify')
      }
      return 'next'
    }, 800).then((res) => {
      if (res === 'error') {
        u.state = 'rolled-back'
        u.history.unshift({ at: new Date().toISOString(), from, to, result: 'rolled-back' })
        task.state = 'restored'
        task.steps.push({ label: `Возврат ${from}`, state: 'done', detail: 'Предыдущая версия запущена, контрольный трафик проходит' })
        task.summary = `Возвращена ${from}`
        this.event({ type: 'update', severity: 'error', object: { kind: 'component', name: u.name }, title: `${u.name} ${to} не прошёл проверку — возвращена ${from}`, detail: task.steps[4].detail })
      } else {
        u.current = to
        u.target = null
        u.state = 'up-to-date'
        u.history.unshift({ at: new Date().toISOString(), from, to, result: 'ok' })
        task.summary = `${u.name} ${to} работает`
        this.event({ type: 'engine', severity: 'ok', object: { kind: 'component', name: u.name }, title: `${u.name} обновлён до ${to}`, detail: 'Контрольный трафик проходит.' })
      }
      this.emit('tasks')
      this.emit('runtime')
    })
    return clone(task)
  }

  async cancelTask(taskId: string) {
    const t = this.s.tasks.find((x) => x.id === taskId)
    if (!t || !t.cancellable || t.state !== 'running') return
    t.state = 'cancelled'
    t.finishedAt = new Date().toISOString()
    t.steps.forEach((s) => s.state === 'running' && (s.state = 'skipped'))
    t.summary = 'Отменено. Незавершённые шаги не выполнялись.'
    this.emit('tasks')
  }

  /* ───────────── task engine ───────────── */

  private startTask(kind: TaskKind, title: string, scope: string, steps: string[]): Task {
    const t: Task = {
      id: uid('t'), kind, title, scope, state: 'running', startedAt: new Date().toISOString(), cancellable: !['apply', 'trial', 'rollback', 'update'].includes(kind),
      steps: steps.map((label): TaskStep => ({ label, state: 'pending' })),
    }
    this.s.tasks.unshift(t)
    this.s.tasks = this.s.tasks.slice(0, 30)
    this.emit('tasks')
    return t
  }

  /**
   * Runs steps one after another. `step(i)` may throw (→ error), return 'hold'
   * (task stays running; e.g. waiting for trial confirmation) or 'next'.
   * With `keepGoing`, a step that set its own state to 'error' doesn't stop the task.
   */
  private async runSteps(t: Task, step: (i: number) => Promise<'next' | 'hold'>, ms = 650, keepGoing = false): Promise<'done' | 'error' | 'hold' | 'cancelled'> {
    for (let i = 0; i < t.steps.length; i++) {
      if (t.state !== 'running') return 'cancelled'
      t.steps[i].state = 'running'
      this.emit('tasks')
      await sleep(ms * (0.7 + Math.random() * 0.6))
      const index = this.s.tasks.findIndex((task) => task.id === t.id)
      if (index === -1 || this.s.tasks[index].state !== 'running') return 'cancelled'
      // A storage event may have replaced the in-memory copy while the step waited.
      this.s.tasks[index] = t
      try {
        const r = await step(i)
        if (r === 'hold') {
          // A held step is still in progress (e.g. waiting for trial
          // confirmation): whoever releases it sets its final state.
          this.emit('tasks')
          return 'hold'
        }
        if (t.steps[i].state === 'running') t.steps[i].state = 'done'
      } catch (e) {
        t.steps[i].state = 'error'
        t.steps.slice(i + 1).forEach((s) => (s.state = 'skipped'))
        t.state = 'error'
        t.error = t.steps[i].detail ?? (e as Error).message
        t.finishedAt = new Date().toISOString()
        this.emit('tasks')
        return 'error'
      }
      this.emit('tasks')
    }
    const anyErr = keepGoing && t.steps.some((s) => s.state === 'error')
    t.state = anyErr ? 'error' : 'done'
    if (anyErr) t.error = 'Часть проверок не прошла'
    t.finishedAt = new Date().toISOString()
    this.emit('tasks')
    return 'done'
  }
}

/* ───────────── helpers ───────────── */

type ZapretItem = Pick<ServiceCheckItem, 'id' | 'label' | 'proto'>

function zapretCheckItems(service: ZapretServiceId): ZapretItem[] {
  return service === 'youtube'
    ? [
        { id: 'page', label: 'Страница youtube.com', proto: 'HTTPS · TCP' },
        { id: 'media', label: 'Видео (googlevideo.com)', proto: 'HTTPS · TCP' },
        { id: 'comments', label: 'Комментарии (youtubei API)', proto: 'HTTPS · TCP' },
        { id: 'quic', label: 'QUIC', proto: 'UDP 443' },
      ]
    : [
        { id: 'https', label: 'Веб-клиент discord.com', proto: 'HTTPS · TCP' },
        { id: 'gateway', label: 'Gateway WebSocket', proto: 'WSS · TCP' },
        { id: 'voice', label: 'Голос', proto: 'UDP' },
      ]
}

function simulateZapretItem(item: ZapretItem, strategyId: string, handlesUdp: boolean, flags: ScenarioFlags, separateUdp: boolean): ServiceCheckItem {
  const viaVpn = strategyId.startsWith('vpn')
  if (flags.zapretQueueFail && !viaVpn && (!separateUdp || item.proto.includes('TCP'))) {
    return { ...item, state: 'fail', detail: 'Очередь не обслуживается' }
  }
  if (item.id === 'quic' && !viaVpn) {
    return {
      ...item, state: 'untested',
      detail: handlesUdp ? 'Не проверено: стратегия экспериментальная' : 'Не проверено: стратегия обрабатывает только TCP',
    }
  }
  if (item.id === 'voice') {
    return {
      ...item,
      state: viaVpn ? 'untested' : 'unavailable',
      detail: viaVpn ? 'UDP через VPN: не испытано на этой установке' : 'Недоступно: нужен модуль xt_u32',
    }
  }
  if (strategyId === 'zs-yt-fake' && flags.zapretYtPartial && (item.id === 'media' || item.id === 'comments')) {
    return { ...item, state: 'fail', detail: 'TLS прошёл, ответ не получен (сброс потока)' }
  }
  const ms = item.id === 'quic' ? 48 : 80 + rnd(160)
  return { ...item, state: 'ok', ms, detail: `${ms} мс` }
}

const KIND_RU: Record<string, string> = { keenetic: 'Штатный Keenetic', direct: 'Напрямую', vpn: 'VPN', zapret: 'Zapret', block: 'Блокировать', inherit: 'Наследовать' }
const rnd = (n: number) => Math.round(Math.random() * n)

function segName(ctx: EvalCtx, id: string) {
  return ctx.topology.segments.find((s) => s.id === id)?.name ?? id
}
function devName(ctx: EvalCtx, c: Config, id: string) {
  return c.devicePolicies.find((d) => d.deviceId === id)?.alias ?? ctx.topology.devices.find((d) => d.id === id)?.hostname ?? id
}
function summarize(ch: EntityChange[]) {
  if (!ch.length) return 'Без изменений'
  const head = ch.slice(0, 2).map((c) => c.label).join(', ')
  return ch.length > 2 ? `${head} и ещё ${ch.length - 2}` : head
}
function maskHost(raw: string) {
  const h = raw.match(/@([^:/?#]+)/)?.[1] ?? '••••'
  return h.replace(/^[^.]+/, '••••')
}
function splitProfiles(text: string): string[] {
  const out: string[] = []
  const awg = text.split(/(?=\[Interface\])/)
  for (const chunk of awg) {
    if (chunk.includes('[Interface]')) {
      out.push(chunk.trim())
      continue
    }
    chunk.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).forEach((l) => out.push(l))
  }
  return out
}

export const ISO = { ago, inMin }

function dnsAddressErrors(base: Config, draft: Config): string[] {
  const errors: string[] = []
  for (const policy of draft.dns) {
    if (!policy.managed) continue
    const previous = base.dns.find(({ id }) => id === policy.id)
    for (const role of ['primary', 'fallback'] as const) {
      const current = policy[role]
      const old = previous?.[role]
      if (!current || (previous?.managed && current.address === old?.address && current.protocol === old?.protocol)) continue
      if (!validDnsAddress(current.protocol, current.address)) {
        errors.push(`DNS «${policy.name}»: недопустимый адрес ${role === 'primary' ? 'основного' : 'резервного'} сервера.`)
      }
    }
  }
  return errors
}

/** Per-sub-check results from a finished check task's steps (the contract's `result`). */
function stepItems(task: Task, items: { id: string; label: string; proto: string }[]): ServiceCheckItem[] {
  return items.map((it, i) => {
    const st = task.steps[i]
    const ms = st?.detail?.match(/^(\d+) мс/)
    const state: ServiceCheckItem['state'] =
      st?.state === 'done' ? 'ok' : st?.state === 'error' ? 'fail' : st?.state === 'skipped' ? (/^Недоступно/.test(st.detail ?? '') ? 'unavailable' : 'untested') : 'interrupted'
    return { ...it, state, ms: ms ? Number(ms[1]) : undefined, detail: st?.detail }
  })
}
