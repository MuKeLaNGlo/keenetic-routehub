/**
 * Pure policy helpers shared by screens. Policy evaluation itself lives on the
 * router (api.evaluate); these only describe the *configured* structure.
 */
import type { Config, Policy, Rule, Topology } from '@/api/contract'
import { policyChain } from '@/api/mock/evaluate'

export { policyChain }

export interface InheritedRule {
  rule: Rule
  from: Policy
  /** Switched off in the inspected scope via disabledParentRuleIds. */
  disabledHere: boolean
}

/** Rules a scope inherits from the chain starting at `parentId`, in evaluation order. */
export function inheritedRules(config: Config, parentId: string | null | undefined, disabledIds: string[]): InheritedRule[] {
  if (!parentId) return []
  const { chain } = policyChain(config, parentId)
  return chain.flatMap((p) => p.rules.map((rule) => ({ rule, from: p, disabledHere: disabledIds.includes(rule.id) })))
}

export interface DevicePolicyView {
  /** Physical segment's policy (where the device actually is). */
  actualPolicy: Policy | undefined
  /** The policy the device inherits from (actual or selected), if it inherits. */
  sourcePolicy: Policy | undefined
  /** Device's own policy (local overrides / independent). */
  ownPolicy: Policy | undefined
  chainNames: string[]
  cycle: boolean
}

export function devicePolicyView(config: Config, topo: Topology, deviceId: string): DevicePolicyView {
  const dev = topo.devices.find((d) => d.id === deviceId)
  const dp = config.devicePolicies.find((p) => p.deviceId === deviceId)
  const segPol = config.segmentPolicies.find((s) => s.segmentId === dev?.segmentId)
  const actualPolicy = config.policies.find((p) => p.id === segPol?.policyId)
  const mode = dp?.mode ?? 'inherit-actual'
  const ownPolicy = dp?.policyId ? config.policies.find((p) => p.id === dp.policyId) : undefined
  let sourcePolicy: Policy | undefined
  if (mode === 'inherit-actual') sourcePolicy = actualPolicy
  else if (mode === 'inherit-selected' || mode === 'local-overrides') sourcePolicy = config.policies.find((p) => p.id === dp?.sourcePolicyId) ?? actualPolicy
  const start = mode === 'independent' ? ownPolicy?.id : sourcePolicy?.id
  const { chain, cycle } = start ? policyChain(config, start) : { chain: [], cycle: false }
  const chainNames = [...(mode === 'local-overrides' && ownPolicy ? ['Свои правила'] : []), ...chain.map((p) => p.name)]
  return { actualPolicy, sourcePolicy, ownPolicy, chainNames, cycle }
}

/** Where a policy is used (for "used by" chips and safe deletion). */
export function policyUsers(config: Config, topo: Topology | undefined, policyId: string): string[] {
  const out: string[] = []
  for (const s of config.segmentPolicies) if (s.policyId === policyId) out.push(`Сеть «${topo?.segments.find((x) => x.id === s.segmentId)?.name ?? s.segmentId}»`)
  for (const p of config.policies) if (p.parentId === policyId) out.push(`${p.kind === 'template' ? 'Шаблон' : 'Политика'} «${p.name}»`)
  for (const d of config.devicePolicies)
    if (d.sourcePolicyId === policyId || d.policyId === policyId) {
      const dev = topo?.devices.find((x) => x.id === d.deviceId)
      out.push(`Устройство «${d.alias ?? dev?.hostname ?? d.deviceId}»`)
    }
  for (const g of config.deviceGroups) if (g.policyId === policyId) out.push(`Группа «${g.name}»`)
  return out
}
