import type { Config, Policy, Rule, Topology } from '@/api/contract'
import { isDemo } from '@/api/mode'
import { scopeOptions } from './scopes'

export interface ScopedRule {
  policyId: string
  rule: Rule
}

export function ruleDestinations(config: Config, topology: Topology | undefined) {
  const destinations = new Set(config.policies.filter((policy) => applicableScope(config, topology, policy)).map(({ id }) => id))
  return scopeOptions(config).filter(({ value }) => destinations.has(value))
}

function applicableScope(config: Config, topology: Topology | undefined, policy: Policy) {
  if (isDemo || policy.kind === 'global') return true
  if (policy.kind !== 'device') return false
  const row = config.devicePolicies.find((device) => device.policyId === policy.id)
  if (!row || (row.mode !== 'local-overrides' && row.mode !== 'independent')) return false
  const device = topology?.devices.find(({ id }) => id === row.deviceId)
  if (!device || device.binding !== 'confirmed' || !topology?.segments.some(({ id, routable }) => id === device.segmentId && routable.available)) return false
  return !!row.ipv4Bindings?.length && row.ipv4Bindings.every((ip) =>
    device.addresses.some(({ addr, family, confirmed }) => addr === ip && family === 'v4' && confirmed))
}

export function moveRules(config: Config, selected: ScopedRule[], destinationId: string, changedRule?: Rule) {
  const destination = config.policies.find(({ id }) => id === destinationId)
  if (!destination) throw new Error('Область назначения больше не существует.')
  const moving = selected.filter(({ policyId }) => policyId !== destinationId)
  const ids = new Set(moving.map(({ rule }) => rule.id))
  if (destination.rules.some(({ id }) => ids.has(id)) ||
      config.policies.some(({ disabledParentRuleIds }) => disabledParentRuleIds.some((id) => ids.has(id)))) {
    throw new Error('Перенос затрагивает существующее правило или переопределение наследования.')
  }
  for (const { policyId, rule } of moving) {
    const source = config.policies.find(({ id }) => id === policyId)
    const index = source?.rules.findIndex(({ id }) => id === rule.id) ?? -1
    if (!source || index < 0 || JSON.stringify(source.rules[index]) !== JSON.stringify(rule)) {
      throw new Error('Одно из правил уже изменилось. Повторите выбор.')
    }
    const [removed] = source.rules.splice(index, 1)
    destination.rules.push(changedRule?.id === rule.id ? changedRule : removed)
  }
}
