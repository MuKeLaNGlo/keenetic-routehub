import { useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Laptop,
  Monitor,
  Smartphone,
  Tablet,
  Tv,
  Gamepad2,
  Cpu,
  Speaker,
  HelpCircle,
  Plus,
  Upload,
  ChevronDown,
} from 'lucide-react'
import type { Config, Device, DeviceKind, DeviceMode, DevicePolicy, Policy, Rule, Topology } from '@/api/contract'
import { useCaps, useCanWrite, useRuntime } from '@/state/resource'
import { useDraft, useDrafted } from '@/state/draft'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'
import { Section, KV, EmptyState } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { TruthLadder } from '@/components/rh/truth'
import { SimpleSelect, Mono, TimeAgo, WriteButton } from '@/components/rh/controls'
import { ActionChip, ActionPicker } from '@/components/rh/action'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { DetailSheet, Modal } from '@/components/rh/sheet'
import { RuleList, InheritedRuleRow, RuleEditor, emptyRule } from '@/components/rh/rules'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { deviceName, newId } from '@/lib/entities'
import { devicePolicyView, inheritedRules } from '@/lib/policy'
import { InlineSetting } from '@/screens/inline-setting'
import { moveRules, ruleDestinations } from '@/screens/rules/transfer'
import { CompactDeviceSummary } from './compact-summary'

export const KIND_ICON: Record<DeviceKind, ReactNode> = {
  phone: <Smartphone />,
  laptop: <Laptop />,
  desktop: <Monitor />,
  tv: <Tv />,
  console: <Gamepad2 />,
  iot: <Cpu />,
  tablet: <Tablet />,
  speaker: <Speaker />,
  unknown: <HelpCircle />,
}

export const MODE_META: Record<DeviceMode, { label: string; hint: string }> = {
  'inherit-actual': { label: 'Как в своей сети', hint: 'Политика сети, к которой устройство подключено сейчас. Переедет в другую сеть — получит её правила.' },
  'inherit-selected': { label: 'Как в выбранной сети или шаблоне', hint: 'Политика выбранной сети или шаблона, независимо от того, где устройство находится.' },
  'local-overrides': { label: 'Унаследовать и дополнить', hint: 'Наследует политику и добавляет свои правила поверх. Унаследованные правила можно отключать по одному.' },
  independent: { label: 'Своя политика', hint: 'Только собственные правила устройства; родительская политика не участвует.' },
  'fixed-exit': { label: 'Весь трафик в один выход', hint: 'Всё, кроме защищённого системного трафика, уходит в выбранный выход.' },
}

/* ═══════════════════════ detail sheet ═══════════════════════ */

export function DeviceSheet({ deviceId, topo }: { deviceId: string | null; topo: Topology }) {
  const device = topo.devices.find((d) => d.id === deviceId)
  const { config } = useDraft()
  return (
    <DetailSheet
      open={!!deviceId}
      onClose={() => closeQuery('d', 'rule')}
      title={device ? deviceName(device, config) : 'Устройство не найдено'}
      description={device ? `${device.hostname} · ${device.vendor}` : undefined}
      width="md"
    >
      {device ? <DeviceDetail key={device.id} device={device} topo={topo} /> : <EmptyState title="Устройство пропало из списка Keenetic">Возможно, его удалили на роутере.</EmptyState>}
    </DetailSheet>
  )
}

/** A device's settings live in its DevicePolicy and its own Policy: a draft change to either counts. */
export function useDeviceChange(deviceId: string) {
  const { config } = useDraft()
  const ownPolicyId = config?.devicePolicies.find((p) => p.deviceId === deviceId)?.policyId ?? ''
  const dp = useDrafted('devicePolicies', deviceId)
  const own = useDrafted('policies', ownPolicyId)
  return dp ?? own
}

function DeviceLadder({ device }: { device: Device }) {
  const change = useDeviceChange(device.id)
  const { server } = useDraft()
  const { data: rt } = useRuntime()
  return (
    <TruthLadder
      draft={!!change}
      savedRevision={server?.revision ?? null}
      active={rt ? rt.loadedRevision === server?.revision : false}
      verified={device.binding === 'confirmed' ? 'untested' : 'na'}
      notes={{
        verified: device.binding === 'confirmed' ? 'Запустите реальную проверку в разделе «Проверка», чтобы подтвердить трафиком' : 'Привязка адреса не подтверждена — личная политика не применяется',
      }}
    />
  )
}

/** Ensure the device has a DevicePolicy entry and return it (mutating draft). */
function ensureDp(c: Config, deviceId: string): DevicePolicy {
  let dp = c.devicePolicies.find((p) => p.deviceId === deviceId)
  if (!dp) {
    dp = { deviceId, mode: 'inherit-actual' }
    c.devicePolicies.push(dp)
  }
  return dp
}

/** Ensure the device has its own policy (for local rules / disabled parent rules). */
function ensureOwnPolicy(c: Config, deviceId: string, name: string): Policy {
  const dp = ensureDp(c, deviceId)
  let pol = c.policies.find((p) => p.id === dp.policyId)
  if (!pol) {
    pol = { id: newId('pol-dev'), name: `${name} · личные правила`, kind: 'device', parentId: null, rules: [], disabledParentRuleIds: [], defaultAction: { kind: 'inherit' }, fallbackOverride: null }
    c.policies.push(pol)
    dp.policyId = pol.id
  }
  return pol
}

const reveal = { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 }, transition: { type: 'spring', bounce: 0, duration: 0.35 } } as const

function DeviceDetail({ device: d, topo }: { device: Device; topo: Topology }) {
  const tracePath = '/trace-preview'
  const rulesPath = '/rules-preview'
  const { config, edit } = useDraft()
  const { data: caps } = useCaps()
  const can = useCanWrite()
  const route = useRoute()
  const ruleParam = route.query.get('rule')
  const [aliasDraft, setAliasDraft] = useState<string | null>(null)
  const [savingAlias, setSavingAlias] = useState(false)
  const aliasRequest = useRef(false)
  const [tab, setTab] = useState(ruleParam ? 'rules' : 'settings')
  const [editingSetting, setEditingSetting] = useState<'alias' | 'mode' | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [deviceSaving, setDeviceSaving] = useState(false)
  const newRule = useMemo(() => ruleParam === 'new' ? emptyRule(newId('r')) : null, [ruleParam])

  const view = useMemo(() => (config ? devicePolicyView(config, topo, d.id) : null), [config, topo, d.id])
  if (!config || !view) return null
  const name = deviceName(d, config)
  const dp = config.devicePolicies.find((p) => p.deviceId === d.id)
  const mode: DeviceMode = dp?.mode ?? 'inherit-actual'
  const seg = topo.segments.find((s) => s.id === d.segmentId)
  const ssid = topo.ssids.find((s) => s.id === d.ssidId)
  const groups = config.deviceGroups.filter((g) => g.deviceIds.includes(d.id))
  const own = view.ownPolicy
  const singleNetwork = caps?.features?.segments?.available === false
  const canRoute = can && seg?.routable.available !== false && (!singleNetwork || d.binding === 'confirmed')
  const reserved = [...new Set(d.addresses.filter(({ family, confirmed }) => family === 'v4' && confirmed).map(({ addr }) => addr))].sort()
  const bindingChanged = !!dp?.ipv4Bindings && d.binding === 'confirmed' && reserved.length > 0 && JSON.stringify([...dp.ipv4Bindings].sort()) !== JSON.stringify(reserved)
  const usesOwn = mode === 'local-overrides' || mode === 'independent'
  const inherited = mode === 'local-overrides' ? inheritedRules(config, view.sourcePolicy?.id, own?.disabledParentRuleIds ?? []) : []

  const sourceOptions = config.policies
    .filter((p) => p.kind === 'segment' || p.kind === 'template' || p.kind === 'global')
    .map((p) => ({ value: p.id, label: p.name, group: p.kind === 'template' ? 'Шаблоны' : p.kind === 'global' ? 'Общие' : 'Сети' }))

  const editingRule: Rule | null = newRule ?? own?.rules.find((r) => r.id === ruleParam) ?? null
  function setMode(next: DeviceMode) {
    if (next === mode || !canRoute || deviceSaving) return
    edit(`Режим политики «${name}»: ${MODE_META[next].label}`, (c) => {
      const item = ensureDp(c, d.id)
      item.mode = next
      if (singleNetwork) delete item.sourcePolicyId
      else if ((next === 'inherit-selected' || next === 'local-overrides') && !item.sourcePolicyId) item.sourcePolicyId = view?.actualPolicy?.id
      if (next === 'local-overrides' || next === 'independent') {
        const own = ensureOwnPolicy(c, d.id, name)
        if (singleNetwork && next === 'local-overrides') own.defaultAction = { kind: 'inherit' }
        if (singleNetwork && next === 'independent' && own.defaultAction.kind === 'inherit') {
          own.defaultAction = { kind: 'direct', uplinkId: caps?.ispUplinks[0]?.id ?? 'isp-main' }
        }
      }
      if (next === 'fixed-exit' && !item.fixedExit) item.fixedExit = { kind: 'vpn', target: { type: 'primary' } }
    })
  }

  function syncBindings() {
    if (!can || !bindingChanged || deviceSaving) return
    setDeviceSaving(true)
    void edit(`Обновлены IPv4 для «${name}»`, (c) => {
      ensureDp(c, d.id).ipv4Bindings = reserved
    }).finally(() => setDeviceSaving(false))
  }

  async function resetPolicy() {
    if (!can || !dp || deviceSaving) return
    setDeviceSaving(true)
    try {
      if (await edit(`Сброшены настройки «${name}»`, (c) => {
        const state = c.devicePolicies.find((policy) => policy.deviceId === d.id)
        c.devicePolicies = c.devicePolicies.filter((policy) => policy.deviceId !== d.id)
        if (state?.policyId) c.policies = c.policies.filter(({ id }) => id !== state.policyId)
      })) setConfirmReset(false)
    } finally {
      setDeviceSaving(false)
    }
  }

  const compactLabelClass = 'text-[13px] leading-snug font-medium'
  const compactControlClass = 'h-9 w-full min-w-0 px-2.5 text-base data-[size=default]:h-9 md:text-sm'

  async function commitAlias() {
    if (!can || aliasDraft === null || aliasRequest.current) return
    const value = aliasDraft.trim() || undefined
    if (value === dp?.alias) {
      setAliasDraft(null)
      return
    }
    aliasRequest.current = true
    setSavingAlias(true)
    try {
      if (await edit(`Имя устройства «${d.hostname}»`, (c) => void (ensureDp(c, d.id).alias = value))) {
        setAliasDraft(null)
      }
    } finally {
      aliasRequest.current = false
      setSavingAlias(false)
    }
  }

  function showSetting(next: typeof editingSetting) {
    if (editingSetting === 'alias') void commitAlias()
    setEditingSetting(editingSetting === next ? null : next)
  }

  const nameInput = (
    <Input
      aria-label="Имя устройства в RouteHub"
      className={compactControlClass}
      value={aliasDraft ?? dp?.alias ?? ''}
      placeholder={d.hostname}
      disabled={!can || savingAlias}
      onChange={(e) => setAliasDraft(e.target.value)}
      onBlur={commitAlias}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )

  const compactModePicker = (
    <SimpleSelect
      className={compactControlClass}
      aria-label="Режим маршрутизации"
      disabled={!canRoute || deviceSaving}
      value={mode}
      options={(Object.keys(MODE_META) as DeviceMode[]).map((value) => ({
        value, label: MODE_META[value].label,
        disabled: singleNetwork && value === 'inherit-selected',
        hint: singleNetwork && value === 'inherit-selected' ? 'На этой установке перехватывается одна сеть' : undefined,
      }))}
      onChange={(value) => setMode(value as DeviceMode)}
    />
  )

  const modeFields = (
    <AnimatePresence initial={false}>
      {!singleNetwork && (mode === 'inherit-selected' || mode === 'local-overrides') && (
        <motion.div key="src" {...reveal} className="overflow-hidden">
          <div className="grid gap-1.5 pt-5">
            <div className={compactLabelClass}>Наследовать от</div>
            <SimpleSelect
              className={compactControlClass}
              aria-label="Наследовать от"
              disabled={!can}
              value={dp?.sourcePolicyId ?? view.actualPolicy?.id ?? null}
              options={sourceOptions}
              onChange={(v) => edit(`Источник политики «${name}»`, (c) => void (ensureDp(c, d.id).sourcePolicyId = v))}
            />
            {dp?.sourcePolicyId && dp.sourcePolicyId !== view.actualPolicy?.id && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Устройство физически в «{seg?.name}», но правила берёт из «{config.policies.find((p) => p.id === dp.sourcePolicyId)?.name}». Смена сети на это не повлияет.
              </p>
            )}
          </div>
        </motion.div>
      )}
      {mode === 'independent' && own && (
        <motion.div key="fallback" {...reveal} className="overflow-hidden">
          <div className="grid gap-1.5 pt-5">
            <div className={compactLabelClass}>Выход по умолчанию для устройства</div>
            <ActionPicker
              aria-label="Выход по умолчанию для устройства"
              value={own.defaultAction}
              disabled={!canRoute || deviceSaving}
              allow={['vpn', 'direct', 'block']}
              onChange={(action) => void edit(`Выход по умолчанию «${name}»`, (c) => { ensureOwnPolicy(c, d.id, name).defaultAction = action })}
            />
          </div>
        </motion.div>
      )}
      {mode === 'fixed-exit' && (
        <motion.div key="fixed" {...reveal} className="overflow-hidden">
          <div className="grid gap-1.5 pt-5 [&_[data-slot=select-trigger]]:h-9 [&_[data-slot=select-trigger]]:px-2.5 [&_[data-slot=select-trigger]]:text-base md:[&_[data-slot=select-trigger]]:text-sm">
            <div className={compactLabelClass}>Выход для трафика</div>
            <ActionPicker
              aria-label="Выход для трафика"
              disabled={!canRoute || deviceSaving}
              allow={['vpn', 'direct', 'keenetic', 'block']}
              value={dp?.fixedExit ?? { kind: 'vpn', target: { type: 'primary' } }}
              onChange={(a) => edit(`Выход «${name}»`, (c) => void (ensureDp(c, d.id).fixedExit = a))}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  const ownRules = (
    <>
      {usesOwn && (
        <Section
          title="Свои правила"
          description={mode === 'local-overrides' ? 'Проверяются раньше унаследованных. Первое совпадение побеждает.' : 'Единственные правила устройства. Первое совпадение побеждает.'}
          actions={
            <div className="flex flex-wrap gap-2">
              {own && canRoute && <Button size="sm" variant="outline" render={<a href={href(rulesPath, { policy: own.id, import: '1' })} />} nativeButton={false}><Upload /> Импорт</Button>}
              <WriteButton size="sm" variant="outline" disabled={!canRoute} onClick={() => setQuery({ rule: 'new' })}>
                <Plus /> Правило
              </WriteButton>
            </div>
          }
        >
          <RuleList
            rules={own?.rules ?? []}
            traceSource={`device:${d.id}`}
            tracePath={tracePath}
            onOpen={(id) => setQuery({ rule: id })}
            onToggle={(id, v) => edit(`${v ? 'Включено' : 'Выключено'} правило устройства «${name}»`, (c) => void (ensureOwnPolicy(c, d.id, name).rules.find((r) => r.id === id)!.enabled = v))}
            onReorder={(ids) =>
              edit(`Порядок правил «${name}»`, (c) => {
                const p = ensureOwnPolicy(c, d.id, name)
                p.rules = ids.map((id) => p.rules.find((r) => r.id === id)!).filter(Boolean)
              })
            }
            empty={
              <EmptyState
                title="Своих правил пока нет"
                action={
                  <WriteButton size="sm" variant="outline" disabled={!canRoute} onClick={() => setQuery({ rule: 'new' })}>
                    <Plus /> Добавить правило
                  </WriteButton>
                }
              >
                Например, отправить рабочий портал через VPN только с этого устройства.
              </EmptyState>
            }
          />
        </Section>
      )}
    </>
  )

  const inheritedControls = (
    <>
      {mode === 'local-overrides' && (
        <Section title={`Унаследовано от «${view.sourcePolicy?.name ?? '—'}»`} description="Отключение действует только для этого устройства — исходная политика не меняется.">
          <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            {inherited.length === 0 && <div className="bg-card px-3 py-4 text-[13px] text-muted-foreground">Унаследованных правил нет</div>}
            {inherited.map(({ rule, from, disabledHere }) => (
              <InheritedRuleRow
                key={`${from.id}/${rule.id}`}
                rule={rule}
                from={from.name}
                disabledHere={disabledHere}
                onToggleHere={!singleNetwork ? (off) =>
                  edit(`${off ? 'Отключено' : 'Включено'} «${rule.name}» для «${name}»`, (c) => {
                    const p = ensureOwnPolicy(c, d.id, name)
                    p.disabledParentRuleIds = off ? [...new Set([...p.disabledParentRuleIds, rule.id])] : p.disabledParentRuleIds.filter((x) => x !== rule.id)
                  })
                 : undefined}
              />
            ))}
          </div>
        </Section>
      )}
    </>
  )

  const inheritedLink = (
    <>
      {(mode === 'inherit-actual' || mode === 'inherit-selected') && view.sourcePolicy && (
        <p className="text-[12.5px] text-muted-foreground">
          Правила задаются в политике «{view.sourcePolicy.name}».{' '}
          <a className="text-foreground underline-offset-2 hover:underline" href={href(rulesPath, { policy: view.sourcePolicy.id })}>
            Открыть правила
          </a>
        </p>
      )}
    </>
  )

  const groupLinks = (
    <>
      {groups.length > 0 && (
        <Section title="Группы устройств" description="Правила групп проверяются вместе с правилами устройства.">
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <a key={g.id} href={href(rulesPath, { policy: g.policyId })} className="pressable inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[12.5px] [overflow-wrap:anywhere] hover:bg-accent">
                {g.name}
              </a>
            ))}
          </div>
        </Section>
      )}
    </>
  )

  const addresses = (
    <Section title="Адреса">
      <KV
        items={[
          ...d.addresses.map(
            (a) =>
              [
                a.family === 'v4' ? 'IPv4' : 'IPv6',
                <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  <Mono className="min-w-0 [overflow-wrap:anywhere]">{a.addr}</Mono>
                  <span className="text-[11.5px] text-muted-foreground">{a.source.toUpperCase()}</span>
                  {a.confirmed ? (
                    <StatusBadge tone="ok">подтверждён</StatusBadge>
                  ) : (
                    <StatusBadge tone="muted" dashed>
                      не подтверждён
                    </StatusBadge>
                  )}
                </span>,
              ] as [ReactNode, ReactNode],
          ),
          ['MAC', <Mono>{d.mac}</Mono>],
          ['В сети', d.connectionKnown === false ? 'Нет сведений' : d.online ? 'Сейчас' : <TimeAgo at={d.lastSeen} />],
          ...(dp?.ipv4Bindings?.length ? [['Закреплённые IP в политике', dp.ipv4Bindings.join(', ')] as [ReactNode, ReactNode]] : []),
        ]}
      />
      {bindingChanged && <WriteButton size="sm" variant="outline" className="mt-3" disabled={deviceSaving} onClick={syncBindings}>Взять закреплённые IPv4 из Keenetic</WriteButton>}
      {d.addresses.some((a) => a.family === 'v6') && caps?.interception.coverage.v6tcp.state !== 'verified' && (
        <p className="mt-3 text-[12px] text-muted-foreground">IPv6-трафик этого устройства на этой установке не испытан: правила для IPv6 сохраняются, но перехват не подтверждён.</p>
      )}
    </Section>
  )

  const ruleEditor = (
    <RuleEditor
      compact
      open={!!ruleParam}
      rule={editingRule}
      isNew={ruleParam === 'new'}
      scopeLabel={`устройство «${name}»`}
      traceSource={`device:${d.id}`}
      tracePath={tracePath}
      onClose={() => closeQuery('rule')}
      transfer={own && editingRule && !newRule ? {
        destinations: ruleDestinations(config, topo).filter(({ value }) => value !== own.id),
        onMove: (rule, original, target) => edit(`Правило «${rule.name}» перенесено`, (c) =>
          moveRules(c, [{ policyId: own.id, rule: original }], target, rule)),
      } : undefined}
      onSave={(r, original) => edit(`${ruleParam === 'new' ? 'Новое' : 'Изменено'} правило «${r.name}» для «${name}»`, (c) => {
        if (ruleParam === 'new') {
          ensureOwnPolicy(c, d.id, name).rules.unshift(r)
          return
        }
        const current = devicePolicyView(c, topo, d.id).ownPolicy
        const index = current?.rules.findIndex((x) => x.id === r.id) ?? -1
        if (!current || index < 0 || JSON.stringify(current.rules[index]) !== JSON.stringify(original)) {
          throw new Error('Правило изменилось в другой вкладке. Откройте его заново.')
        }
        current.rules[index] = r
      })}
      onDelete={(original) => edit(`Удалено правило «${original.name}» у «${name}»`, (c) => {
        const current = devicePolicyView(c, topo, d.id).ownPolicy
        const index = current?.rules.findIndex((x) => x.id === original.id) ?? -1
        if (!current || index < 0) return
        if (JSON.stringify(current.rules[index]) !== JSON.stringify(original)) {
          throw new Error('Правило изменилось в другой вкладке. Откройте его заново.')
        }
        current.rules.splice(index, 1)
      })}
    />
  )

  return (
    <div className="min-w-0 space-y-3">
      <CompactDeviceSummary device={d} topo={topo} tracePath={tracePath} />
      <Tabs value={ruleParam ? 'rules' : tab} onValueChange={(value) => { showSetting(null); setTab(value) }} className="min-w-0 gap-3">
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Настройки устройства" className="h-9 max-w-full p-0">
            <TabsTrigger value="settings" className="px-2 text-xs after:bottom-[-3px]">Настройки</TabsTrigger>
            <TabsTrigger value="rules" className="px-2 text-xs after:bottom-[-3px]">Правила</TabsTrigger>
            <TabsTrigger value="network" className="px-2 text-xs after:bottom-[-3px]">Сеть и адреса</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="settings">
          <div className="grid min-w-0 gap-5 rounded-xl border border-border bg-card p-3.5">
            {caps?.access === 'read' && <ReadOnlyHint />}
            <InlineSetting
              title="Имя в RouteHub"
              value={dp?.alias ?? d.hostname}
              editable={can}
              open={editingSetting === 'alias'}
              onToggle={() => showSetting('alias')}
            >
              {nameInput}
            </InlineSetting>
            <InlineSetting
              title="Режим маршрутизации"
              value={(
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span>{MODE_META[mode].label}</span>
                  {(mode === 'inherit-selected' || mode === 'local-overrides') && view.sourcePolicy && <span>· {view.sourcePolicy.name}</span>}
                  {mode === 'fixed-exit' && dp?.fixedExit && (
                    <ActionChip action={dp.fixedExit} className="h-auto min-h-6 max-w-full py-0.5 [&>span]:whitespace-normal [&>span]:[overflow-wrap:anywhere]" />
                  )}
                </div>
              )}
              editable={can}
              open={editingSetting === 'mode'}
              onToggle={() => showSetting('mode')}
            >
              <div className="min-w-0">
                <div className="grid min-w-0 gap-1.5">
                  {compactModePicker}
                  <p className="text-[12px] leading-relaxed text-muted-foreground">{singleNetwork && mode === 'local-overrides' ? 'Сначала применяются личные правила, затем общие.' : MODE_META[mode].hint}</p>
                  {singleNetwork && !canRoute && <p className="text-xs text-warn">Для личной маршрутизации нужен закреплённый IPv4-адрес в управляемой сети Keenetic.</p>}
                </div>
                {modeFields}
              </div>
            </InlineSetting>
            {dp && <WriteButton variant="outline" className="w-fit" disabled={deviceSaving} onClick={() => setConfirmReset(true)}>Сбросить настройки RouteHub</WriteButton>}
          </div>
        </TabsContent>
        <TabsContent value="rules" className="space-y-3 [&_section]:mb-0">
          {ownRules}
          {mode === 'local-overrides' && (
            <details className="group rounded-xl border border-border bg-card">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                Унаследованные правила
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="border-t border-border p-3">{inheritedControls}</div>
            </details>
          )}
          {inheritedLink}
          {groupLinks}
          {mode === 'fixed-exit' && <p className="text-[12px] text-muted-foreground">В режиме фиксированного выхода личные правила не применяются.</p>}
          {!usesOwn && mode !== 'fixed-exit' && !view.sourcePolicy && <p className="text-[12px] text-muted-foreground">Политика источника не найдена.</p>}
        </TabsContent>
        <TabsContent value="network" className="space-y-3 [&_section]:mb-0">
          <KV items={[
            ['Сегмент', seg?.name ?? d.segmentId],
            ['Интерфейс', <Mono className="[overflow-wrap:anywhere]">{seg?.iface ?? '—'}</Mono>],
            ['Подключение', ssid ? `${ssid.name} · ${ssid.band}` : d.connectionKnown === false ? 'Нет сведений' : 'Кабель'],
          ]} />
          {addresses}
          <DeviceLadder device={d} />
        </TabsContent>
      </Tabs>
      {ruleEditor}
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        dismissible={!deviceSaving}
        title="Сбросить настройки устройства?"
        description="Панель удалит личные правила и имя из RouteHub. Устройство продолжит использовать настройки своей сети Keenetic."
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={deviceSaving} onClick={() => setConfirmReset(false)}>Отмена</Button>
            <WriteButton variant="destructive" disabled={deviceSaving} onClick={() => void resetPolicy()}>Сбросить</WriteButton>
          </div>
        )}
      >{null}</Modal>
    </div>
  )
}
