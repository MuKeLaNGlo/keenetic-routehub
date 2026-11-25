/**
 * Helpers local to «Сети и шаблоны». Shared components stay untouched; these
 * only describe the configured structure of segment policies and templates.
 */
import type { Config, Policy, Segment, SegmentPolicy, Topology } from '@/api/contract'
import { policyChain } from '@/lib/policy'
import { newId } from '@/lib/entities'

/** The policy that terminates every chain. */
export function globalPolicy(config: Config): Policy | undefined {
  return config.policies.find((p) => p.kind === 'global')
}

/** A segment's routing policy, created on demand. */
export function ensureSegmentPolicy(c: Config, segment: Pick<Segment, 'id' | 'name'>): SegmentPolicy {
  const found = c.segmentPolicies.find((x) => x.segmentId === segment.id)
  if (found) return found
  const policy = newSegmentPolicy(c, segment)
  c.policies.push(policy)
  const sp: SegmentPolicy = { segmentId: segment.id, mode: 'managed', policyId: policy.id }
  c.segmentPolicies.push(sp)
  return sp
}

/** The segment policy points at a policy that no longer exists: build a fresh one. */
export function repairSegmentPolicy(c: Config, segment: Pick<Segment, 'id' | 'name'>): SegmentPolicy {
  const sp = c.segmentPolicies.find((x) => x.segmentId === segment.id)
  const policy = newSegmentPolicy(c, segment)
  c.policies.push(policy)
  if (sp) {
    sp.policyId = policy.id
    return sp
  }
  const created: SegmentPolicy = { segmentId: segment.id, mode: 'managed', policyId: policy.id }
  c.segmentPolicies.push(created)
  return created
}

function newSegmentPolicy(c: Config, segment: Pick<Segment, 'id' | 'name'>): Policy {
  return {
    id: newId('pol-seg'),
    name: segment.name,
    kind: 'segment',
    parentId: globalPolicy(c)?.id ?? null,
    rules: [],
    disabledParentRuleIds: [],
    defaultAction: { kind: 'inherit' },
    fallbackOverride: null,
    description: 'Создана в RouteHub для существующей сети Keenetic.',
  }
}

/** Would pointing `policyId` at `parentId` close a cycle? */
export function wouldCycle(config: Config, policyId: string, parentId: string | null): boolean {
  if (!parentId) return false
  if (parentId === policyId) return true
  return policyChain(config, parentId).chain.some((p) => p.id === policyId)
}

export function devicesInSegment(topo: Topology, segmentId: string) {
  return topo.devices.filter((d) => d.segmentId === segmentId)
}
