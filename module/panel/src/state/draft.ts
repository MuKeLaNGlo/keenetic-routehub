/**
 * Recovery of drafts stored by earlier versions of the panel.
 *
 * A draft is a full working copy of `Config` plus the revision it was cut
 * from. It lives in sessionStorage: survives reloads, navigation and
 * back/forward in this tab, and is invisible to other tabs (each tab is its
 * own editor; the router is the shared truth). New edits are saved directly.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { Config, ConfigCollection, EntityChange } from '@/api/contract'
import { diffConfig, entityId, rebase, type RebaseResult } from '@/lib/configDiff'
import { useServerConfig } from './resource'
import { saveConfigEdit } from './live-config'

// Stores Config snapshots: bump with every Config shape change (v2: NamedSet.source slimmed).
const KEY = 'routehub-draft-v2'

interface DraftState {
  /** Config snapshot the draft was cut from (its revision = baseRevision). */
  base: Config
  working: Config
  /** Human log of edits, newest last (for the review list). */
  log: { at: number; label: string }[]
}

let state: DraftState | null = load()
const listeners = new Set<() => void>()

function load(): DraftState | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as DraftState) : null
  } catch {
    return null
  }
}
function commit(next: DraftState | null) {
  if (next) sessionStorage.setItem(KEY, JSON.stringify(next))
  else sessionStorage.removeItem(KEY)
  state = next
  listeners.forEach((l) => l())
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Imperative API — usable from event handlers anywhere. */
export const draftStore = {
  get: () => state,
  discard() {
    commit(null)
  },
  /** Revert one entity to its base version. */
  revertEntity(collection: EntityChange['collection'], id: string) {
    if (!state) return
    const working = structuredClone(state.working)
    if (collection === 'autostart') working.autostart = structuredClone(state.base.autostart)
    else if (collection === 'primaryProfileId') working.primaryProfileId = state.base.primaryProfileId
    else {
      const c = collection as ConfigCollection
      const list = working[c] as unknown as Record<string, unknown>[]
      const baseEntity = (state.base[c] as unknown as Record<string, unknown>[]).find((e) => entityId(c, e) === id)
      const idx = list.findIndex((e) => entityId(c, e) === id)
      if (baseEntity && idx >= 0) list[idx] = structuredClone(baseEntity)
      else if (baseEntity) list.push(structuredClone(baseEntity))
      else if (idx >= 0) list.splice(idx, 1)
    }
    const next = { ...state, working }
    commit(diffConfig(state.base, working).length ? next : null)
  },
  /** Move the draft onto a newer server snapshot (after a revision conflict). */
  rebaseOnto(theirs: Config): RebaseResult | null {
    if (!state) return null
    const res = rebase(state.base, state.working, theirs)
    commit({ base: structuredClone(theirs), working: res.config, log: state.log })
    return res
  },
  /** Carry pending edits forward after an immediate switch of the VPN profile. */
  reconcilePrimaryProfileSwitch(before: Config, after: Config, workingPrimaryAtStart?: Config['primaryProfileId']) {
    if (!state || state.base.revision !== before.revision || before.primaryProfileId === after.primaryProfileId) return
    if (diffConfig(before, after).some(({ collection }) => collection !== 'primaryProfileId')) return

    const { working, base, log } = state
    // A new profile edit made while the switch was running stays in the draft.
    const useAppliedProfile = working.primaryProfileId === base.primaryProfileId || working.primaryProfileId === workingPrimaryAtStart
    const next = {
      ...working,
      revision: after.revision,
      primaryProfileId: useAppliedProfile ? after.primaryProfileId : working.primaryProfileId,
    }
    commit(diffConfig(after, next).length ? { base: structuredClone(after), working: next, log } : null)
  },
  /**
   * Hand the draft to an apply task: it leaves the dock (the router now owns
   * it) but is kept aside, so a failed/restored apply gives it back intact.
   */
  stash(taskId: string) {
    if (!state) return
    sessionStorage.setItem(`${STASH}${taskId}`, JSON.stringify(state))
    commit(null)
  },
  /** Task settled: either drop the stash (success) or restore it as the draft. */
  settle(taskId: string, restore: boolean): boolean {
    const raw = sessionStorage.getItem(`${STASH}${taskId}`)
    if (!raw) return false
    sessionStorage.removeItem(`${STASH}${taskId}`)
    if (restore && !state) commit(JSON.parse(raw) as DraftState)
    return restore
  },
  stashedTaskIds(): string[] {
    return Object.keys(sessionStorage)
      .filter((k) => k.startsWith(STASH))
      .map((k) => k.slice(STASH.length))
  },
}

const STASH = 'routehub-draft-v2-stash:'

export interface DraftView {
  /** Applied settings displayed by the editor. */
  config: Config | undefined
  /** Server config (applied revision). */
  server: Config | undefined
  base: Config | undefined
  dirty: boolean
  changes: EntityChange[]
  /** Server moved on since the draft was cut. */
  outdated: boolean
  edit: (label: string, mutate: (c: Config) => void) => Promise<boolean>
}

export function useDraft(): DraftView {
  const s = useSyncExternalStore(subscribe, () => state)
  const { data: server } = useServerConfig()
  const changes = useMemo(() => (s ? diffConfig(s.base, s.working) : []), [s])
  return {
    config: server,
    server,
    base: s?.base,
    dirty: !!s,
    changes,
    outdated: !!s && !!server && server.revision !== s.base.revision,
    edit: (label, mutate) => server ? saveConfigEdit(server, label, mutate) : Promise.resolve(false),
  }
}

/** Whether an entity has a pending draft change (for the violet mark). */
export function useDrafted(collection: EntityChange['collection'], id: string): EntityChange | undefined {
  const { changes } = useDraft()
  return changes.find((c) => c.collection === collection && c.id === id)
}
