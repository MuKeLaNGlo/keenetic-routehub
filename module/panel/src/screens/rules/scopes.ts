/** Which policy a rules screen can point at, and what it inherits from. */
import type { Config, Policy } from '@/api/contract'
import { policyChain } from '@/lib/policy'
import { policyById } from '@/lib/entities'
import type { SelectOption } from '@/components/rh/controls'
import { count } from '@/lib/format'

const KIND_LABEL: Record<Policy['kind'], string> = { global: 'общие', template: 'шаблон', segment: 'сеть', device: 'устройство' }

/** «Устройство → Дом → Домашний шаблон → Общие» reads better with the kind spelled out. */
export function scopeKind(config: Config, policy: Policy): string {
  if (policy.kind === 'device' && config.deviceGroups.some((g) => g.policyId === policy.id)) return 'группа устройств'
  return KIND_LABEL[policy.kind]
}

/** All policies, grouped: global, templates, segments, device groups, devices. */
export function scopeOptions(config: Config): SelectOption[] {
  const groupPolicy = new Map(config.deviceGroups.map((g) => [g.policyId, g.name]))
  const out: SelectOption[] = []
  const add = (p: Policy, group: string, label: string) =>
    out.push({ value: p.id, label, group, hint: count(p.rules.length, ['правило', 'правила', 'правил']) })

  for (const p of config.policies) {
    if (p.kind === 'global') add(p, 'Общие правила', p.name)
    else if (p.kind === 'template') add(p, 'Шаблоны', p.name)
    else if (p.kind === 'segment') add(p, 'Сети', p.name)
  }
  for (const p of config.policies) {
    const group = groupPolicy.get(p.id)
    if (group) add(p, 'Группы устройств', `Группа «${group}»`)
  }
  for (const p of config.policies) {
    if (p.kind !== 'device' || groupPolicy.has(p.id)) continue
    add(p, 'Устройства', p.name)
  }
  return out
}

/**
 * The chain a scope really inherits from, self first. A device policy reaches
 * its source policy through `devicePolicies.sourcePolicyId`, not `parentId`.
 */
export function scopeChain(config: Config, policy: Policy): { chain: Policy[]; cycle: boolean } {
  if (policy.kind === 'device') {
    const dp = config.devicePolicies.find((d) => d.policyId === policy.id)
    const source = dp?.sourcePolicyId ? policyById(config, dp.sourcePolicyId) : undefined
    if (source) {
      const { chain, cycle } = policyChain(config, source.id)
      return { chain: [policy, ...chain.filter((p) => p.id !== policy.id)], cycle }
    }
  }
  return policyChain(config, policy.id)
}

/** Where a policy inherits from when it has no parentId of its own. */
export function inheritSource(config: Config, policy: Policy): string | null {
  if (policy.parentId) return policy.parentId
  const dp = config.devicePolicies.find((d) => d.policyId === policy.id)
  return dp?.sourcePolicyId ?? null
}
