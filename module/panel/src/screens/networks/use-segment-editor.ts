import { useState } from 'react'
import type { Action, Policy, Segment } from '@/api/contract'
import { policyById } from '@/lib/entities'
import { policyChain } from '@/lib/policy'
import { useDraft } from '@/state/draft'
import { useCanWrite, useCaps, useTopology } from '@/state/resource'
import { devicesInSegment, ensureSegmentPolicy, repairSegmentPolicy, wouldCycle } from './helpers'

export function useSegmentEditor(segment: Segment) {
  const { data: topology } = useTopology()
  const { config, edit } = useDraft()
  const { data: caps } = useCaps()
  const can = useCanWrite()
  const [cycleError, setCycleError] = useState<string | null>(null)
  const sp = config?.segmentPolicies.find((entry) => entry.segmentId === segment.id)

  if (!config || !topology) return null

  const policy = policyById(config, sp?.policyId)
  const ssids = topology.ssids.filter((ssid) => segment.ssidIds.includes(ssid.id))
  const devices = devicesInSegment(topology, segment.id)
  const excluded = sp?.mode === 'excluded'
  const chain = policy ? policyChain(config, policy.id) : { chain: [], cycle: false }
  const parentCandidates = config.policies.filter((entry) => (entry.kind === 'template' || entry.kind === 'global') && entry.id !== policy?.id)
  const fallback: Action = policy && policy.defaultAction.kind !== 'inherit'
    ? policy.defaultAction
    : { kind: 'direct', uplinkId: caps?.ispUplinks[0]?.id ?? 'isp-main' }

  function take() {
    void edit(`Сеть «${segment.name}» взята под управление RouteHub`, (candidate) => {
      ensureSegmentPolicy(candidate, segment)
    })
  }

  function repair() {
    void edit(`Политика сети «${segment.name}» создана заново`, (candidate) => {
      repairSegmentPolicy(candidate, segment)
    })
  }

  function setMode(mode: 'managed' | 'excluded') {
    void edit(mode === 'excluded' ? `Сеть «${segment.name}» исключена из RouteHub` : `Сеть «${segment.name}» взята под управление RouteHub`, (candidate) => {
      ensureSegmentPolicy(candidate, segment).mode = mode
    })
  }

  function editPolicy(label: string, update: (target: Policy) => void) {
    if (!policy) return Promise.resolve(false)
    return edit(label, (candidate) => {
      const target = candidate.policies.find((entry) => entry.id === policy.id)
      if (target) update(target)
    })
  }

  const setParent = (nextId: string | null) => {
    if (!policy) return
    if (wouldCycle(config, policy.id, nextId)) {
      const name = config.policies.find((entry) => entry.id === nextId)?.name ?? nextId
      setCycleError(`«${name}» уже наследует от «${policy.name}» — такая ссылка замкнула бы цепочку. Изменение не сохранено.`)
      return
    }
    setCycleError(null)
    editPolicy(`Родительская политика сети «${segment.name}»`, (target) => {
      target.parentId = nextId
    })
  }

  function setDefaultAction(action: Action) {
    editPolicy(`Действие по умолчанию сети «${segment.name}»`, (target) => {
      target.defaultAction = action
    })
  }

  function setFallbackAction(action: Action) {
    editPolicy(`Запасной маршрут сети «${segment.name}»`, (target) => {
      target.fallbackOverride = action
    })
  }

  function toggleFallback(enabled: boolean) {
    return editPolicy(`${enabled ? 'Задан' : 'Снят'} запасной маршрут сети «${segment.name}»`, (target) => {
      target.fallbackOverride = enabled ? fallback : null
    })
  }

  return {
    config, caps, can, sp, policy, ssids, devices, excluded, chain, parentCandidates,
    cycleError, take, repair, setMode, setParent, setDefaultAction, setFallbackAction, toggleFallback,
  }
}

export type SegmentEditor = NonNullable<ReturnType<typeof useSegmentEditor>>
