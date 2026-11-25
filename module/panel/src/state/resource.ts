/**
 * Server-state cache. Each resource is fetched once, shared by every
 * component, and re-fetched when the daemon pushes one of its topics.
 * Keeps the last good value while refetching (never flashes empty), and
 * records errors separately so screens can show "stale + why".
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@/api'
import type {
  Capabilities,
  ChangeTopic,
  ClassifiedFlow,
  Config,
  GeoSource,
  JournalEvent,
  Revision,
  Runtime,
  SubscriptionStatus,
  Task,
  Topology,
  TrafficPeriod,
  TrafficSeries,
  UpdateInfo,
  ZapretStrategy,
} from '@/api/contract'

export interface Resource<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  updatedAt: number | null
}

interface Entry<T> {
  state: Resource<T>
  fetcher: () => Promise<T>
  topics: ChangeTopic[]
  listeners: Set<() => void>
  inflight: Promise<void> | null
  /** A topic fired since the last fetch started: the data may be outdated. */
  stale: boolean
  publication: number
}

const entries = new Map<string, Entry<unknown>>()

function entry<T>(key: string, fetcher: () => Promise<T>, topics: ChangeTopic[]): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined
  if (!e) {
    e = { state: { data: undefined, error: null, loading: false, updatedAt: null }, fetcher, topics, listeners: new Set(), inflight: null, stale: false, publication: 0 }
    entries.set(key, e as Entry<unknown>)
  }
  return e
}

function set<T>(e: Entry<T>, patch: Partial<Resource<T>>) {
  e.state = { ...e.state, ...patch }
  e.listeners.forEach((l) => l())
}

export function refetch(key: string): Promise<void> {
  const e = entries.get(key)
  if (!e) return Promise.resolve()
  if (e.inflight) return e.inflight
  const publication = e.publication
  e.stale = false
  set(e, { loading: true })
  e.inflight = e
    .fetcher()
    .then((data) => { if (e.publication === publication) set(e, { data, error: null, loading: false, updatedAt: Date.now() }) })
    .catch((err: Error) => { if (e.publication === publication) set(e, { error: err.message, loading: false }) })
    .finally(() => {
      e.inflight = null
      // A push landed while this fetch was in flight: its answer may predate it.
      if (e.stale && e.listeners.size) void refetch(key)
    })
  return e.inflight
}

api.subscribe((topic) => {
  for (const [key, e] of entries) {
    if (!e.topics.includes(topic)) continue
    e.stale = true
    // Unwatched entries refetch on their next mount (see useResource).
    if (e.listeners.size && !e.inflight) void refetch(key)
  }
})

export function useResource<T>(key: string, fetcher: () => Promise<T>, topics: ChangeTopic[]): Resource<T> & { refetch: () => Promise<void> } {
  const e = entry(key, fetcher, topics)
  const state = useSyncExternalStore(
    (l) => {
      e.listeners.add(l)
      return () => e.listeners.delete(l)
    },
    () => e.state,
  )
  useEffect(() => {
    if ((e.state.updatedAt === null || e.stale) && !e.inflight) void refetch(key)
  }, [key, e])
  return { ...state, refetch: () => refetch(key) }
}

/* ───────────── typed hooks ───────────── */

export const useCaps = () => useResource<Capabilities>('caps', () => api.getCapabilities(), ['capabilities'])
export const useTopology = () => useResource<Topology>('topology', () => api.getTopology(), ['topology'])
const fetchConfig = () => api.getConfig()
export const useServerConfig = () => useResource<Config>('config', fetchConfig, ['config'])

/** Publish the committed snapshot returned by a write, even while a read is outstanding. */
export function publishServerConfig(config: Config) {
  const e = entry('config', fetchConfig, ['config'])
  e.publication += 1
  set(e, { data: config, error: null, loading: false, updatedAt: Date.now() })
}
export const useRuntime = () => useResource<Runtime>('runtime', () => api.getRuntime(), ['runtime', 'config'])
export const useEvents = () => useResource<JournalEvent[]>('events', () => api.getEvents(), ['events'])
export const useTasks = () => useResource<Task[]>('tasks', () => api.getTasks(), ['tasks'])
export const useRevisions = () => useResource<Revision[]>('revisions', () => api.getRevisions(), ['config', 'tasks'])
export const useGeo = () => useResource<GeoSource[]>('geo', () => api.getGeoSources(), [])
export const useSubscriptionStatus = () => useResource<SubscriptionStatus[]>('subs', () => api.getSubscriptionStatus(), ['tasks', 'events'])
export const useStrategies = () => useResource<ZapretStrategy[]>('strategies', () => api.getZapretStrategies(), [])
export const useFlows = () => useResource<ClassifiedFlow[]>('flows', () => api.getClassifiedFlows(), [])
export const useUpdates = () => useResource<UpdateInfo[]>('updates', () => api.getUpdates(), ['runtime', 'tasks'])
export const useTraffic = (p: TrafficPeriod) => useResource<TrafficSeries>(`traffic:${p}`, () => api.getTraffic(p), ['runtime'])

/** Write permission of this session. */
export function useCanWrite(): boolean {
  return useCaps().data?.access === 'write'
}

/** A task by id, live. */
export function useTask(id: string | null | undefined): Task | undefined {
  const { data } = useTasks()
  return id ? data?.find((t) => t.id === id) : undefined
}
