import { useSyncExternalStore } from 'react'

export type VpnPhase =
  | 'off'
  | 'connecting'
  | 'success'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'connect-error'
  | 'disconnect-error'
  | 'canceled'
  | 'reconnecting'
  | 'connection-lost'

export type VpnScenario = 'normal' | 'connect-error' | 'timeout' | 'disconnect-error' | 'recover' | 'drop'

type FailureReason = 'rejected' | 'timeout' | 'disconnect' | 'lost' | null

interface DemoState {
  phase: VpnPhase
  scenario: VpnScenario
  failureReason: FailureReason
}

type NextStep = [delayMs: number, run: (at: number) => void]

interface PendingStep {
  at: number
  run: NextStep[1]
}

interface PhaseOptions {
  at?: number
  after?: NextStep
  failureReason?: FailureReason
  consume?: VpnScenario
}

const CONNECT_MS = 1650
const TIMEOUT_MS = 2800
const DISCONNECT_MS = 1100
const FEEDBACK_MS = 1200
const LINK_CHECK_MS = 3600

// This demo lives in the current tab and leaves the router mock unchanged.
// Deadlines survive hash navigation, but timers run only while subscribed.
let state: DemoState = { phase: 'off', scenario: 'normal', failureReason: null }
let pending: PendingStep | undefined
let timer: number | undefined
const listeners = new Set<() => void>()

function schedule() {
  window.clearTimeout(timer)
  timer = undefined
  const step = pending
  if (!step || listeners.size === 0) return

  timer = window.setTimeout(() => {
    if (pending !== step) return
    step.run(step.at)
  }, Math.max(0, step.at - Date.now()))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) schedule()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) schedule()
  }
}

function getSnapshot() {
  return state
}

function defer(step: NextStep | undefined, at: number): PendingStep | undefined {
  if (!step) return undefined
  const [delayMs, run] = step
  return { at: at + delayMs, run }
}

function update(nextState: Partial<DemoState>, step: PendingStep | undefined) {
  state = { ...state, ...nextState }
  pending = step
  schedule()
  listeners.forEach((listener) => listener())
}

function enter(phase: VpnPhase, { at = Date.now(), after, failureReason = null, consume }: PhaseOptions = {}) {
  const scenario = state.scenario === consume ? 'normal' : state.scenario
  update({ phase, scenario, failureReason }, defer(after, at))
}

function checkLink(scenario: VpnScenario): NextStep | undefined {
  if (scenario === 'drop') {
    return [LINK_CHECK_MS, () => enter('connection-lost', { failureReason: 'lost', consume: 'drop' })]
  }
  if (scenario === 'recover') {
    return [LINK_CHECK_MS, (at) => enter('reconnecting', { at, consume: 'recover', after: [CONNECT_MS, showSuccess] })]
  }
  return undefined
}

function showSuccess(at: number) {
  enter('success', {
    at,
    after: [FEEDBACK_MS, (connectedAt) => enter('connected', { at: connectedAt, after: checkLink(state.scenario) })],
  })
}

function setScenario(scenario: VpnScenario) {
  if (scenario === state.scenario) return
  const connected = state.phase === 'connected' || state.phase === 'disconnect-error'
  update({ scenario }, connected ? defer(checkLink(scenario), Date.now()) : pending)
}

function startConnection() {
  const scenario = state.scenario
  if (scenario === 'connect-error' || scenario === 'timeout') {
    enter('connecting', {
      after: [scenario === 'timeout' ? TIMEOUT_MS : CONNECT_MS, () => {
        enter('connect-error', { failureReason: scenario === 'timeout' ? 'timeout' : 'rejected', consume: scenario })
      }],
    })
  } else {
    enter('connecting', { after: [CONNECT_MS, showSuccess] })
  }
}

function stopConnection() {
  const simulateError = state.scenario === 'disconnect-error'
  enter('disconnecting', {
    after: [DISCONNECT_MS, (at) => {
      if (simulateError) {
        enter('disconnect-error', { at, failureReason: 'disconnect', consume: 'disconnect-error', after: checkLink(state.scenario) })
      } else {
        enter('disconnected', { at, after: [FEEDBACK_MS, () => enter('off')] })
      }
    }],
  })
}

function toggle() {
  switch (state.phase) {
    case 'connecting':
    case 'reconnecting':
      enter('canceled', { after: [FEEDBACK_MS, () => enter('off')] })
      break
    case 'success':
    case 'connected':
    case 'disconnect-error':
      stopConnection()
      break
    case 'disconnecting':
      break
    case 'off':
    case 'disconnected':
    case 'canceled':
    case 'connect-error':
    case 'connection-lost':
      startConnection()
      break
  }
}

export function useVpnDemo() {
  const current = useSyncExternalStore(subscribe, getSnapshot)
  return { ...current, setScenario, toggle }
}
