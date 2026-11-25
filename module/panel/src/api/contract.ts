/**
 * RouteHub panel ⇄ daemon contract.
 *
 * This file is the swap point: the mock (`src/api/mock`) implements
 * `RouteHubApi` today; a production adapter maps the same interface onto the
 * daemon's HTTP API (`/api/status`, `/api/plan`, `/api/evaluate`, …).
 *
 * Three kinds of state, never mixed:
 *  - `Config`    desired state, revisioned, the only thing the user edits;
 *  - `Topology`  read from KeeneticOS (segments, SSIDs, clients), read-only;
 *  - `Runtime`   observed state of the daemon (selections, health, probes).
 */

/* ───────────────────────────── primitives ───────────────────────────── */

export type Id = string
export type IsoTime = string
export type Family = 'v4' | 'v6'
export type Proto = 'tcp' | 'udp'

/** One cell of the IPv4/IPv6 × TCP/UDP coverage matrix. */
export type CoverageState =
  | 'verified' // confirmed by real traffic on this install
  | 'configured' // set up, not yet confirmed by traffic
  | 'partial' // works on some paths only (see note)
  | 'untested' // never tested on this install
  | 'unsupported' // not possible on this install
  | 'failed' // tested and failing

export interface CoverageCell {
  state: CoverageState
  note?: string
}
export type Coverage = Record<'v4tcp' | 'v4udp' | 'v6tcp' | 'v6udp', CoverageCell>

/** Whether something can execute on this install, and why not. */
export interface Availability {
  available: boolean
  reason?: string
  /** What would make it available (component to install, firmware, …). */
  remedy?: string
}

/* ───────────────────────────── capabilities ─────────────────────────── */

export type EngineId = 'xray' | 'sing-box' | 'awg-keenetic' | 'awg-routehub'

export type ActionKind = 'keenetic' | 'direct' | 'vpn' | 'zapret' | 'block' | 'inherit'

export interface Capabilities {
  /** Session's permission level. `read` hides/locks every write affordance. */
  access: 'write' | 'read'
  profileProbeConcurrency?: number
  device: { model: string; name: string; firmware: string; arch: string; entware: string }
  routehub: { version: string; build: string }
  /** Packet interception mode actually running and what it covers. */
  interception: { mode: string; label: string; coverage: Coverage; notes: string[] }
  actions: Record<ActionKind, Availability>
  perSsidPolicy: Availability
  perDeviceDns: Availability
  zapret: Availability
  gameRouting: { routeAtOpen: Availability; lateSignalPriority: Availability; intelliQos: Availability; strictPriority: Availability }
  ipv6: Availability
  trialApply: Availability
  liveObservation: Availability
  ispUplinks: { id: Id; name: string; iface: string }[]
  features?: Record<string, Availability>
}

/* ───────────────────────────── topology (Keenetic) ──────────────────── */

export interface Ssid {
  id: Id
  name: string
  band: '2.4 ГГц' | '5 ГГц' | '6 ГГц'
  segmentId: Id
  /** Whether clients of this SSID can be told apart from other SSIDs on the same bridge. */
  distinguishable: Availability
}

export interface Segment {
  /** Stable Keenetic id, e.g. `Bridge0`. */
  id: Id
  name: string
  iface: string
  kind: 'bridge' | 'l3'
  vlan?: number
  v4: string[]
  v6: string[]
  ssidIds: Id[]
  state: 'up' | 'down' | 'removed'
  /** Whether RouteHub can steer routes for this segment. */
  routable: Availability
  /** Keenetic inter-network isolation, read-only for RouteHub. */
  isolation: string
}

export type DeviceKind = 'phone' | 'laptop' | 'desktop' | 'tv' | 'console' | 'iot' | 'tablet' | 'speaker' | 'unknown'

export interface DeviceAddress {
  addr: string
  family: Family
  source: 'dhcp' | 'arp' | 'ndp' | 'static' | 'keenetic'
  /** Confirmed for enforcement (verified binding), vs merely observed. */
  confirmed: boolean
}

export interface Device {
  id: Id
  hostname: string
  vendor: string
  kind: DeviceKind
  mac: string
  /** Physical segment the device is actually attached to. */
  segmentId: Id
  ssidId?: Id
  addresses: DeviceAddress[]
  binding: 'confirmed' | 'observed' | 'ambiguous' | 'lost'
  bindingNote?: string
  online: boolean
  connectionKnown?: boolean
  lastSeen: IsoTime
}

export interface Topology {
  segments: Segment[]
  ssids: Ssid[]
  devices: Device[]
  fetchedAt: IsoTime
}

/* ───────────────────────────── config: routing ───────────────────────── */

export type VpnTarget =
  | { type: 'profile'; profileId: Id }
  | { type: 'primary' }
  | { type: 'group'; groupId: Id }

export type Action =
  | { kind: 'keenetic' }
  | { kind: 'direct'; uplinkId: Id }
  | { kind: 'vpn'; target: VpnTarget }
  | { kind: 'zapret'; strategyId: Id; exit: 'direct' | 'keenetic' }
  | { kind: 'block' }
  | { kind: 'inherit' }

export type MatchType = 'domain' | 'suffix' | 'ip' | 'cidr' | 'geosite' | 'geoip' | 'set' | 'port'

export interface Match {
  type: MatchType
  value: string
  legacyMode?: string
  geoSource?: string
}

export interface Rule {
  id: Id
  name: string
  /** Any match ⇒ rule matches (OR). */
  matches: Match[]
  families: Family[]
  protos: Proto[]
  ports?: string
  action: Action
  enabled: boolean
  source: { type: 'manual' | 'import' | 'migration' | 'preset'; label?: string; at?: IsoTime }
  note?: string
}

export type PolicyKind = 'global' | 'template' | 'segment' | 'device'

export interface Policy {
  id: Id
  name: string
  kind: PolicyKind
  /** Parent policy (template or global); null terminates the chain at the global layer. */
  parentId: Id | null
  /** Ordered; first enabled match wins within this policy. */
  rules: Rule[]
  /** Parent-chain rule ids explicitly switched off in this scope. */
  disabledParentRuleIds: Id[]
  /** `inherit` defers to parent. */
  defaultAction: Action
  /** Fallback-route override: what to do when the chosen exit is down (null = use the exit group's own). */
  fallbackOverride: Action | null
  description?: string
}

export interface SegmentPolicy {
  segmentId: Id
  /** `excluded` = RouteHub does not touch this segment at all. */
  mode: 'managed' | 'excluded'
  /** Own policy of the segment; its parentId may point at a template (linked). */
  policyId: Id
}

export type DeviceMode =
  | 'inherit-actual' // policy of the segment the device is physically on
  | 'inherit-selected' // policy of another selected network or template
  | 'local-overrides' // inherit (actual or selected) + own rules on top
  | 'independent' // own policy, chain terminates at it
  | 'fixed-exit' // everything to one exit

export interface DevicePolicy {
  deviceId: Id
  ipv4Bindings?: string[]
  alias?: string
  mode: DeviceMode
  /** For inherit-selected / local-overrides-with-selected: the source policy (segment policy or template). */
  sourcePolicyId?: Id
  /** Device's own policy (rules + disabled parent rules) for local-overrides / independent. */
  policyId?: Id
  fixedExit?: Action
}

export interface DeviceGroup {
  id: Id
  name: string
  deviceIds: Id[]
  policyId: Id
  /** Lower number = higher priority when a device is in several groups. */
  priority: number
}

export interface NamedSet {
  id: Id
  name: string
  kind: 'domains' | 'cidrs'
  entries: string[]
  /** Definition only. Fetch outcome lives in `Runtime.sets`: a scheduled
   *  download must never change the configuration or its revision. */
  source: { type: 'manual' } | { type: 'url'; url: string; format: string }
}

/** Result of the last downloads of a URL set (runtime state, not config). */
export interface SetSourceStatus {
  /** Version of the list currently in effect (last usable download). */
  version: string
  lastAttempt: IsoTime
  lastSuccess: IsoTime
  nextRun: IsoTime
  status: 'ok' | 'failed' | 'stale'
  error?: string
}

export interface GeoSource {
  id: Id
  kind: 'geosite' | 'geoip'
  name: string
  version: string
  sizeKb: number
  tags: number
  lastCheck: IsoTime
  status: 'ok' | 'failed' | 'stale'
  error?: string
  usedTags: string[]
}

/* ───────────────────────────── config: exits ─────────────────────────── */

export type VpnProtocol = 'vless' | 'hysteria2' | 'trojan' | 'awg'

export interface Profile {
  id: Id
  name: string
  alias?: string
  tags: string[]
  protocol: VpnProtocol
  xrayGroup?: boolean
  groupSize?: number
  /** e.g. `REALITY · TCP`, `XHTTP`, `QUIC`, `AWG 2.0` */
  transport: string
  server: string // masked
  country: string // ISO-2
  origin:
    | { type: 'manual' }
    | { type: 'file'; fileName: string; importedAt: IsoTime }
    | { type: 'subscription'; subscriptionId: Id; upstreamName: string; upstreamKey: string }
  adapter: { mode: 'auto' | 'manual'; engine: EngineId; reason: string }
  enabled: boolean
  pausedUntil?: IsoTime
  favorite: boolean
  note?: string
  /** Lifecycle within its subscription. */
  lifecycle: 'active' | 'missing-upstream' | 'renamed-upstream' | 'ambiguous-replacement'
  primary?: boolean
}

export type GroupMode = 'manual' | 'failover' | 'best'

export interface ExitGroup {
  id: Id
  name: string
  memberIds: Id[]
  mode: GroupMode
  pin: { profileId: Id; until: IsoTime | null } | null
  probe: { url: string; intervalSec: number; samples: number; minAdvantageMs: number; switchPauseSec: number; failThreshold: number }
  /** What happens when every member is down. Default: suspend new connections. */
  failAction: { kind: 'suspend' } | { kind: 'direct'; uplinkId: Id } | { kind: 'group'; groupId: Id }
  revertToPreferred: { enabled: boolean; delaySec: number; successStreak: number }
  /** Subscription-filter based membership (future nodes) — must be opted in. */
  autoInclude: { subscriptionId: Id; filter: string; includeFuture: boolean } | null
}

export interface Subscription {
  id: Id
  name: string
  type: 'vless-list'
  url: string // masked
  hasDeviceId?: boolean
  userAgent?: string
  intervalHours: number
  enabled: boolean
}

export interface SubscriptionInput {
  id?: Id
  name: string
  /** Leave blank when editing to preserve the current credential. */
  url?: string
  /** Write-only. Omit to preserve, or pass an empty string to clear. */
  deviceId?: string
  /** Omit to preserve, or pass an empty string to use the RouteHub default. */
  userAgent?: string
  intervalHours: number
  enabled: boolean
}

/* ───────────────────────────── config: services ──────────────────────── */

export interface DnsServer {
  protocol: 'udp' | 'doh' | 'dot'
  address: string
  /** Route used to reach the resolver. */
  via: Action
}

export interface DnsPolicy {
  id: Id
  name: string
  segmentIds: Id[]
  managed: boolean
  primary: DnsServer
  fallback: DnsServer | null
  /** Whether fallback may go out directly while primary goes via VPN. */
  fallbackDirectAllowed: boolean
  cache: boolean
  /** Defaults to whether a blocklist is configured in older policies. */
  filteringEnabled?: boolean
  lan?: boolean
  blocklists: string[]
  exceptions: string[]
}

export type ZapretServiceId = 'youtube' | 'discord'

export interface ZapretStrategy {
  id: Id
  name: string
  service: ZapretServiceId
  protos: Proto[]
  readiness: 'ready' | 'needs-kernel-module' | 'experimental'
  kernelDependency: string
  queueOwner: string
}

export interface ZapretService {
  id: ZapretServiceId
  enabled: boolean
  /** Segments where the override applies; empty = all managed segments. */
  segmentIds: Id[]
  strategyId: Id
  /** Older configurations use manual strategy selection. */
  selectionMode?: 'manual' | 'auto'
  /** Effective action when the queue or strategy fails — separate from "disabled". */
  failAction: Action
}

export interface GameSignature {
  destination: string
  protocol: Proto
  port: number
  category: 'match' | 'voice'
}

export interface GamePreset {
  id: Id
  name: string
  signatureSources: string[]
  version: string
  confidence: 'high' | 'medium' | 'low'
  families: Family[]
  scenarios: ('match' | 'voice' | 'update' | 'login' | 'download' | 'launcher')[]
  exclusions: string[]
  enabled: boolean
  scope: { segmentIds: Id[]; deviceIds: Id[] }
  routeAction: Action
  priority: 'off' | 'intelliqos' | 'strict'
  signatures?: GameSignature[]
}

export interface Autostart {
  vpn: boolean
  zapret: boolean
  dns: boolean
  profileId?: Id
  zapretYouTube?: boolean
  zapretDiscord?: boolean
  initialPolicy: 'last-applied' | 'direct-until-vpn' | 'suspend-until-vpn'
  waitForWanSec: number
}

export interface SavedCheck {
  id: Id
  name: string
  source: { type: 'device'; deviceId: Id } | { type: 'segment'; segmentId: Id }
  target: string
  family: Family
  proto: Proto
  port: number
  expect: ActionKind
  /** Required checks block apply/auto-update on mismatch; informational ones only warn. */
  required: boolean
}

/* ───────────────────────────── config root ───────────────────────────── */

export interface Config {
  revision: number
  policies: Policy[]
  segmentPolicies: SegmentPolicy[]
  devicePolicies: DevicePolicy[]
  deviceGroups: DeviceGroup[]
  sets: NamedSet[]
  profiles: Profile[]
  exitGroups: ExitGroup[]
  subscriptions: Subscription[]
  dns: DnsPolicy[]
  zapret: ZapretService[]
  games: GamePreset[]
  checks: SavedCheck[]
  autostart: Autostart
  primaryProfileId: Id
}

/** Collections of `Config` that hold id-keyed entities (diff / rebase units). */
export type ConfigCollection = Exclude<keyof Config, 'revision' | 'autostart' | 'primaryProfileId'>

/* ───────────────────────────── runtime ───────────────────────────────── */

export type ProbeState =
  | 'untested'
  | 'pending'
  | 'probing'
  | 'ok'
  | 'degraded'
  | 'down'
  | 'stale'
  | 'disabled'
  | 'incompatible'
  | 'missing'

export interface ProbeResult {
  state: ProbeState
  method: 'https' | 'tcp' | 'icmp' | 'handshake'
  /** Median of the series, ms. */
  medianMs?: number
  jitterMs?: number
  lossPct?: number
  samples?: number
  measuredAt?: IsoTime
  failStage?: 'dns' | 'connect' | 'tls' | 'response' | 'timeout'
  note?: string
}

export type ServiceState = 'running' | 'degraded' | 'stopped' | 'failed' | 'not-installed'

export interface ExitGroupRuntime {
  selectedProfileId: Id | null
  reason: string
  since: IsoTime
  state: 'ok' | 'degraded' | 'failed'
  /** Present while the group's fail action is in effect. */
  fallback: { description: string; since: IsoTime; reason: string } | null
}

export interface ActiveVpnHealth {
  status: 'verified' | 'failed' | 'unverified' | 'unavailable'
  checkedAt: IsoTime
  latencyMs?: number
  message: string
}

export interface Runtime {
  link: { state: 'online' | 'slow' | 'offline'; latencyMs: number; lastSyncAt: IsoTime }
  vpn?: { enabled: boolean; available: boolean; profile: Id; health?: ActiveVpnHealth }
  wan: { state: 'up' | 'down' | 'unknown'; uplinkId: Id; publicIp: string }
  /** Revision currently loaded by the daemon (may lag `Config.revision`). */
  loadedRevision: number
  lastApply: { revision: number; at: IsoTime; result: 'ok' | 'rolled-back' | 'failed' }
  networkChecks: { passed: number; failed: number; untested: number; at: IsoTime }
  services: Record<'core' | 'zapret' | 'dns' | 'collector', { state: ServiceState; label: string; detail?: string }>
  profiles: Record<Id, ProbeResult>
  groups: Record<Id, ExitGroupRuntime>
  /** Per URL set: outcome of its downloads. Absent = never fetched yet. */
  sets: Record<Id, SetSourceStatus>
  dns: Record<Id, { primary: ProbeResult; fallback: ProbeResult | null; active: 'primary' | 'fallback' | 'none' | 'unknown'; since?: IsoTime }>
  zapret: Record<ZapretServiceId, { engine: ServiceState; packetsSeen: boolean; payloadCheck: ProbeState; effective: string }>
  engines: EngineInfo[]
  trial: TrialState | null
}

export interface EngineInfo {
  id: EngineId
  name: string
  installed: string | null
  available: string | null
  source: string
  ramMb: number
  diskMb: number
  status: ServiceState
  usedBy: number
  capabilities: string[]
}

/* ───────────────────────────── telemetry & journal ───────────────────── */

export type TrafficPeriod = '5m' | '15m' | '1h'

export interface ResourceCapacity {
  used: number
  total: number
  available: number
}

export interface RouterResources {
  at: IsoTime
  windowSec: number
  intervalSec: number
  cpu: number | null
  ram: ResourceCapacity | null
  sharedRam?: number
  disk: ResourceCapacity | null
  routeHubRss: number | null
  xrayRss: number | null
  samples: { at: IsoTime; cpu: number | null; ram: number | null }[]
}

export interface ServiceLogStorage {
  state: 'active' | 'paused' | 'error' | 'disabled'
  bytes: number
  files: number
  maxFileBytes: number
  maxFiles: number
  reserveBytes: number
}

export interface TrafficSeries {
  period: TrafficPeriod
  stepSec: number
  /** Fixed-step samples from the start of the requested window. Null marks a gap. Stale data can omit the remaining intervals. */
  points: ({
    t: number
    rx: number
    tx: number
    /** Received plus sent bytes/s in each mutually exclusive route category. Omitted when route counters are unavailable. */
    routed?: { direct: number; vpn: number }
  } | null)[]
  /** Seconds of history actually available (may be < period). */
  historySec: number
  lastSampleAt: IsoTime | null
  state: 'ok' | 'no-data' | 'stale' | 'error'
  error?: string
  /** What the counter measures. */
  object: string
}

export type EventType =
  | 'apply'
  | 'rollback'
  | 'failover'
  | 'fallback'
  | 'engine'
  | 'profile'
  | 'dns'
  | 'zapret'
  | 'update'
  | 'restore'
  | 'task'
  | 'compat'
  | 'trial'
  | 'subscription'

export interface JournalEvent {
  id: Id
  at: IsoTime
  type: EventType
  severity: 'info' | 'ok' | 'warn' | 'error'
  object: { kind: string; id?: Id; name: string }
  title: string
  detail?: string
  /** Structured facts (prev/next profile, rules affected, …) */
  facts?: [string, string][]
}

/* ───────────────────────────── tasks ─────────────────────────────────── */

export type TaskState = 'pending' | 'running' | 'done' | 'cancelled' | 'error' | 'restored' | 'intervention'

export type TaskKind =
  | 'apply'
  | 'trial'
  | 'rollback'
  | 'subscription-refresh'
  | 'update'
  | 'probe'
  | 'real-test'
  | 'zapret-check'
  | 'dns-check'
  | 'import'
  | 'restore'
  | 'support-report'

export interface TaskStep {
  label: string
  state: 'pending' | 'running' | 'done' | 'skipped' | 'error'
  detail?: string
}

export interface Task {
  id: Id
  kind: TaskKind
  title: string
  scope: string
  state: TaskState
  startedAt: IsoTime
  finishedAt?: IsoTime
  steps: TaskStep[]
  summary?: string
  error?: string
  cancellable: boolean
  result?: unknown
}

export interface TrialState {
  taskId: Id
  scope: string
  revision: number
  expiresAt: IsoTime
  totalSec: number
}

/* ───────────────────────────── apply flow ────────────────────────────── */

export interface EntityChange {
  collection: ConfigCollection | 'autostart' | 'primaryProfileId'
  id: Id
  op: 'add' | 'remove' | 'change'
  label: string
  fields?: string[]
}

export interface CheckComparison {
  checkId: Id
  name: string
  required: boolean
  live: string
  draft: string
  ok: boolean
  message: string
}

export interface ApplyPlan {
  baseRevision: number
  changes: EntityChange[]
  affected: { segments: string[]; devices: string[]; rules: number; profiles: string[] }
  restarts: string[]
  warnings: { level: 'warn' | 'error'; text: string }[]
  checks: CheckComparison[]
  trial: Availability & { suggestedScope?: { deviceId: Id; label: string } }
  /** Blocking validation errors; non-empty ⇒ apply refused at check stage. */
  errors: string[]
}

export type ApplyResult =
  | { ok: true; task: Task }
  | { ok: false; conflict: { serverRevision: number; theirChanges: EntityChange[]; by: string; at: IsoTime } }

/* ───────────────────────────── route trace ───────────────────────────── */

export interface TraceQuery {
  source: { type: 'device'; deviceId: Id } | { type: 'segment'; segmentId: Id }
  target: string
  /** Resolved IP when target is a domain (optional; explains shared CDN IPs). */
  resolvedIp?: string
  proto: Proto
  port: number
  /** A classified flow (game traffic) the query stands for, if any. */
  flowId?: Id
}

export type TraceLayerId = 'system' | 'device' | 'zapret' | 'game' | 'policy' | 'global' | 'default'

export interface TraceStep {
  layer: TraceLayerId
  scopeLabel: string
  policyId?: Id
  outcome: 'matched' | 'no-match' | 'skipped' | 'not-applicable' | 'yielded'
  rule?: { id: Id; name: string; match: string; action: Action; source: string }
  note: string
  /** Rules considered but not matched/disabled, for the detail view. */
  considered?: { ruleId: Id; name: string; why: string }[]
}

export interface TraceResult {
  query: TraceQuery
  physical: { segmentId: Id; segmentName: string; ssid?: string }
  policyChain: { id: Id; name: string; kind: PolicyKind }[]
  recognition: { via: 'domain' | 'dns-association' | 'sni' | 'ip' | 'classifier'; detail: string; confidence: 'exact' | 'probable' | 'weak' }
  steps: TraceStep[]
  configured: Action
  configuredLabel: string
  /** What actually carries the traffic now (after group selection / fallback). */
  effective: { label: string; viaFallback: boolean; fallbackReason?: string; suspended?: boolean }
  coverage: Coverage
  limits: string[]
}

export interface RealTestStage {
  stage: 'dns' | 'connect' | 'tls' | 'app'
  label: string
  state: 'ok' | 'fail' | 'skipped' | 'untested'
  ms?: number
  detail?: string
}

export interface RealTestResult {
  target: string
  exitLabel: string
  stages: RealTestStage[]
  totalMs?: number
  observedFrom: 'router' | 'client'
  note: string
}

/* ───────────────────────────── imports ───────────────────────────────── */

export interface RuleImportRow {
  line: number
  raw: string
  status: 'add' | 'duplicate' | 'skip' | 'change'
  match?: Match
  parsedRule?: Omit<Rule, 'id'>
  reason?: string
}

export interface RuleImportPreview {
  format: string
  detected: string
  rows: RuleImportRow[]
  targetPolicyId: Id
  limits: { maxLines: number; maxBytes: number }
}

export interface ProfileImportCandidate {
  key: string
  raw: string
  protocol: VpnProtocol | 'unknown'
  name: string
  transport: string
  server: string
  status: 'ok' | 'needs-confirmation' | 'unsupported' | 'engine-missing' | 'needs-other-engine'
  adapter: EngineId | null
  alternatives: EngineId[]
  reason: string
  /** For ambiguous AWG: the generations the user must choose between. */
  awgGenerations?: ('1.0' | '1.5' | '2.0' | '3.1')[]
  requires: string[]
}

export interface RuleImportOptions {
  files?: File[]
  format?: string
  type?: string
  domainMatch?: string
  template?: string
  geoSource?: string
  action?: Action
}

export interface ProfileImportOptions {
  file?: File
  fileName?: string
  awgVersion?: string
  interface?: string
}

export interface BootCheck {
  id: string
  status: string
  message: string
}

export interface SubscriptionPreview {
  subscriptionId: Id
  fetchedAt: IsoTime
  ok: boolean
  error?: string
  token?: string
  added: { upstreamKey: string; name: string; xrayGroup?: boolean; groupSize?: number }[]
  changed: { profileId: Id; from: string; to: string; kind: 'renamed' | 'params' }[]
  missing: { profileId: Id; name: string; usedBy: string[] }[]
  incompatible: { upstreamKey: string; name: string; reason: string }[]
  ambiguous: { profileId: Id; candidates: string[] }[]
}

export interface SubscriptionStatus {
  subscriptionId: Id
  lastSuccess: { at: IsoTime; revision: string; profiles: number } | null
  lastAttempt?: { at: IsoTime; ok: boolean; code?: string; reason?: string } | null
  nextRun?: IsoTime | null
}

/* ───────────────────────────── services checks ───────────────────────── */

export interface ServiceCheckItem {
  id: string
  label: string
  proto: string
  state: 'ok' | 'fail' | 'untested' | 'interrupted' | 'unavailable'
  ms?: number
  detail?: string
}

export interface ZapretCheckResult {
  service: ZapretServiceId
  strategyId: Id
  phase: 'before' | 'after' | 'selected'
  items: ServiceCheckItem[]
  at: IsoTime
}

export interface ZapretAutoSelectResult {
  applied?: boolean
  service: ZapretServiceId
  strategyId: Id | null
  lastCandidateId: Id | null
  items: ServiceCheckItem[]
}

export interface DnsCheckResult {
  policyId: Id
  items: ServiceCheckItem[]
  at: IsoTime
}

/* ───────────────────────────── games ─────────────────────────────────── */

export interface ClassifiedFlow {
  id: Id
  deviceId: Id
  app: string
  category: 'match' | 'voice' | 'update' | 'login' | 'download' | 'launcher' | 'unknown'
  confidence: 'high' | 'medium' | 'low' | 'none'
  detectedAt: 'open' | 'late'
  dst: string
  proto: Proto
  route: string
  priority: string
  note: string
}

/* ───────────────────────────── system ────────────────────────────────── */

export interface Revision {
  revision: number
  at: IsoTime
  by: string
  summary: string
  result: 'ok' | 'rolled-back' | 'failed' | 'trial-expired' | 'trial-confirmed' | 'trial-cancelled'
  changes: number
}

export type UpdateComponent = 'routehub' | 'xray' | 'sing-box' | 'zapret' | 'geodata'

export interface UpdateInfo {
  component: UpdateComponent
  name: string
  current: string
  target: string | null
  channel: 'stable' | 'beta'
  state: 'up-to-date' | 'available' | 'checking' | 'blocked' | 'updating' | 'failed' | 'rolled-back'
  checks: { label: string; state: 'ok' | 'fail' | 'untested'; detail?: string }[]
  checksum?: { state: 'ok' | 'fail' | 'untested'; algorithm: 'sha256'; source: 'github-releases' }
  signature: 'verified' | 'unverified' | 'unknown'
  autoUpdate: boolean
  history: { at: IsoTime; from: string; to: string; result: 'ok' | 'rolled-back' | 'failed' }[]
}

export interface SupportReport {
  sections: { title: string; lines: { key: string; value: string; redacted?: boolean }[] }[]
  redactedCount: number
  sizeKb: number
}

export interface ObservedConnection {
  id: Id
  deviceId?: Id
  sourceAddress?: string
  dst: string
  proto: Proto
  /** Only populated when the path has independent evidence. */
  exit?: string
  rule?: string
  stalePolicy?: boolean
  bytes?: number
  new?: boolean
  redirected?: boolean
  gameMatch?: { presetId: Id; name: string; category: GameSignature['category'] }
}

export interface ConnectionObservation {
  rows: ObservedConnection[]
  seconds: number
  finishedAt: IsoTime
  limited: boolean
}

/* ───────────────────────────── API interface ─────────────────────────── */

export type ChangeTopic = 'runtime' | 'events' | 'tasks' | 'config' | 'topology' | 'capabilities'

export type ProfileProbeUpdate = { profileId: Id } & (
  | { state: 'running' }
  | { state: 'done'; result: ProbeResult }
  | { state: 'error' | 'skipped'; error: string }
)

export interface RouteHubApi {
  /** Reads */
  getCapabilities(): Promise<Capabilities>
  getSavedCheckResults?(): Promise<CheckComparison[]>
  getTopology(): Promise<Topology>
  getConfig(): Promise<Config>
  getRuntime(): Promise<Runtime>
  getTraffic(period: TrafficPeriod): Promise<TrafficSeries>
  getRouterResources?(): Promise<RouterResources>
  getServiceLogStorage?(): Promise<ServiceLogStorage>
  getEvents(): Promise<JournalEvent[]>
  getTasks(): Promise<Task[]>
  getRevisions(): Promise<Revision[]>
  getGeoSources(): Promise<GeoSource[]>
  getSubscriptionStatus(): Promise<SubscriptionStatus[]>
  getZapretStrategies(): Promise<ZapretStrategy[]>
  getClassifiedFlows(): Promise<ClassifiedFlow[]>
  getUpdates(): Promise<UpdateInfo[]>

  /** Validate and save a settings change against the active revision in one request. */
  saveSettings(config: Config, baseRevision: number): Promise<Config>

  /** Staged config writes — draft in, task out. Server validates against `baseRevision`. */
  previewApply(draft: Config, baseRevision: number): Promise<ApplyPlan>
  apply(draft: Config, baseRevision: number, opts: { mode: 'full' } | { mode: 'trial'; deviceId: Id; seconds: number }): Promise<ApplyResult>
  confirmTrial(taskId: Id): Promise<void>
  rollbackTrial(taskId: Id): Promise<void>
  rollbackTo(revision: number): Promise<Task>

  /** Diagnostics */
  evaluate(query: TraceQuery, config?: Config): Promise<TraceResult>
  realTest(query: TraceQuery): Promise<Task>
  setVpnEnabled?(enabled: boolean, profileId?: Id): Promise<void>
  observeConnections(seconds: number, deviceId?: Id): Promise<ConnectionObservation>
  buildSupportReport(): Promise<SupportReport>

  /** Imports (always preview first) */
  previewRuleImport(text: string, targetPolicyId: Id, config: Config, options?: RuleImportOptions): Promise<RuleImportPreview>
  previewProfileImport(text: string, options?: ProfileImportOptions): Promise<ProfileImportCandidate[]>
  stageImportedProfile?(key: string, profileId: Id): void
  probeImportedProfile?(key: string): Promise<ProbeResult>
  replaceProfileConnection?(profileId: Id, key: string): Promise<Config>
  previewSubscription(subscriptionId: Id): Promise<SubscriptionPreview>
  probeSubscriptionProfile?(subscriptionId: Id, previewToken: string, profileId: Id): Promise<ProbeResult>
  probeSubscriptionProfiles?(subscriptionId: Id, previewToken: string, profileIds: Id[], report: (update: ProfileProbeUpdate) => void, signal?: AbortSignal): Promise<void>
  saveSubscription?(input: SubscriptionInput, baseRevision: number): Promise<void>
  deleteSubscription?(id: Id, baseRevision: number): Promise<void>

  /** Operations */
  checkBoot?(): Promise<BootCheck[]>
  exportBackup?(scope: 'rules' | 'configuration', deviceMAC?: string): Promise<Blob>
  probeProfiles(ids: Id[]): Promise<Task>
  refreshSubscription(subscriptionId: Id, token?: string): Promise<Task>
  zapretCheck(service: ZapretServiceId, strategyId: Id, phase: ZapretCheckResult['phase']): Promise<Task>
  zapretAutoSelect(service: ZapretServiceId, preferredStrategyId: Id): Promise<Task>
  dnsCheck(policyId: Id): Promise<Task>
  checkUpdate(component: UpdateComponent): Promise<Task>
  runUpdate(component: UpdateComponent): Promise<Task>
  cancelTask(taskId: Id): Promise<void>

  /** Push channel (SSE / WebSocket in production). Returns unsubscribe. */
  subscribe(listener: (topic: ChangeTopic) => void): () => void
}
