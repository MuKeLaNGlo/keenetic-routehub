import { useMemo, useState, type ReactNode } from 'react'
import { ListChecks } from 'lucide-react'
import type { Action, Config, Policy } from '@/api/contract'
import { ActionPicker } from '@/components/rh/action'
import { SimpleSelect, WriteButton, type SelectOption } from '@/components/rh/controls'
import { EmptyState } from '@/components/rh/layout'
import { RuleRow } from '@/components/rh/rules'
import { Modal } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { count } from '@/lib/format'
import { actionLabel } from '@/lib/labels'
import { useDraft } from '@/state/draft'
import { useCanWrite, useCaps, useTopology } from '@/state/resource'
import { setQuery, useRoute } from '@/state/router'
import { RulePagination, rulePage } from './rule-pagination'
import { moveRules, ruleDestinations } from './transfer'

const allRoutes = { value: 'all', label: 'Все маршруты' }
const statuses = [
  { value: 'all', label: 'Любое состояние' },
  { value: 'enabled', label: 'Включены' },
  { value: 'disabled', label: 'Выключены' },
]
const operations = [
  { value: 'enable', label: 'Включить' },
  { value: 'disable', label: 'Выключить' },
  { value: 'route', label: 'Изменить маршрут' },
  { value: 'move', label: 'Перенести в другую область' },
  { value: 'delete', label: 'Удалить' },
]

function routeKey(action: Action): string {
  if (action.kind === 'vpn') {
    const { target } = action
    return target.type === 'profile' ? `vpn:profile:${target.profileId}` :
      target.type === 'group' ? `vpn:group:${target.groupId}` : 'vpn:primary'
  }
  if (action.kind === 'direct') return `direct:${action.uplinkId}`
  if (action.kind === 'zapret') return `zapret:${action.exit}`
  return action.kind
}

export function AllRules({ config, selector }: { config: Config; selector: ReactNode }) {
  const { edit } = useDraft()
  const route = useRoute()
  const can = useCanWrite()
  const { data: caps } = useCaps()
  const { data: topology } = useTopology()
  const [pageIndex, setPageIndex] = useState(0)
  const [selection, setSelection] = useState<Set<string> | null>(null)
  const [batch, setBatch] = useState('enable')
  const [action, setAction] = useState<Action>({ kind: 'vpn', target: { type: 'primary' } })
  const [destinationId, setDestinationId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const rows = useMemo(() => config.policies.flatMap((policy) => policy.rules.map((rule, index) => ({
    policyId: policy.id, policy, rule, index,
  }))), [config.policies])
  const routeOptions = useMemo(() => {
    const routes = new Map<string, SelectOption>()
    for (const { rule } of rows) {
      const value = routeKey(rule.action)
      if (!routes.has(value)) routes.set(value, { value, label: actionLabel({ config, caps }, rule.action) })
    }
    return [allRoutes, ...routes.values()]
  }, [rows, config, caps])
  const requestedRoute = route.query.get('routeKind')
  const selectedRoute = routeOptions.find(({ value }) => value === requestedRoute)?.value ?? 'all'
  const state = statuses.find(({ value }) => value === route.query.get('ruleStatus'))?.value ?? 'all'
  const filtered = useMemo(() => rows.filter(({ rule }) =>
    (selectedRoute === 'all' || selectedRoute === routeKey(rule.action)) &&
    (state === 'all' || rule.enabled === (state === 'enabled'))), [rows, selectedRoute, state])
  const page = rulePage(filtered.length, pageIndex)
  const visible = filtered.slice(page.start, page.end)
  const chosen = selection ? filtered.filter(({ rule }) => selection.has(rule.id)) : []
  const selectedOnPage = selection ? visible.filter(({ rule }) => selection.has(rule.id)).length : 0
  const destinations = batch === 'move' ? ruleDestinations(config, topology).filter(({ value }) => chosen.some(({ policyId }) => policyId !== value)) : []
  const destination = destinations.find(({ value }) => value === destinationId)
  const operation = operations.find(({ value }) => value === batch)
  const affected = batch === 'move' ? chosen.filter(({ policyId }) => policyId !== destination?.value) : chosen
  const ready = can && !busy && !!chosen.length && !!operation && (batch !== 'move' || !!destination)
  const description = count(affected.length, ['правило', 'правила', 'правил'])

  function filter(name: string, value: string) {
    setSelection(null)
    setPageIndex(0)
    setQuery({ [name]: value === 'all' ? null : value }, { replace: true })
  }

  function select(ids: string[], enabled: boolean) {
    setSelection((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (enabled) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function run() {
    if (!ready || !operation) return
    setBusy(true)
    try {
      const saved = await edit(`${operation.label} ${description}`, (next) => {
        if (destination && batch === 'move') {
          moveRules(next, affected, destination.value)
          return
        }
        const ids = new Set(affected.map(({ rule }) => rule.id))
        for (const policy of next.policies) {
          const selected = policy.rules.filter(({ id }) => ids.has(id))
          if (!selected.length) continue
          if (batch === 'delete') policy.rules = policy.rules.filter(({ id }) => !ids.has(id))
          else for (const rule of selected) {
            if (batch === 'route') rule.action = structuredClone(action)
            else rule.enabled = batch === 'enable'
          }
        }
      })
      if (saved) {
        setSelection(null)
        setDestinationId(null)
        setConfirming(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3.5" aria-label="Правила всех областей">
      <div className="grid gap-2 sm:grid-cols-3">
        {selector}
        <SimpleSelect className="w-full min-w-0 self-end" aria-label="Маршрут правила" options={routeOptions} value={selectedRoute}
          disabled={busy} onChange={(value) => filter('routeKind', value)} />
        <SimpleSelect className="w-full min-w-0 self-end" aria-label="Состояние правила" options={statuses} value={state}
          disabled={busy} onChange={(value) => filter('ruleStatus', value)} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status">{count(filtered.length, ['правило', 'правила', 'правил'])}</span>
        <WriteButton size="sm" variant="outline" disabled={!filtered.length || busy} aria-pressed={!!selection}
          onClick={() => setSelection(selection ? null : new Set())}>
          <ListChecks aria-hidden="true" /> {selection ? 'Снять выбор' : 'Выбрать'}
        </WriteButton>
      </div>
      {selection && (
        <div className="space-y-2.5 rounded-xl border bg-card p-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox disabled={!can || busy || !visible.length}
                checked={visible.length > 0 && selectedOnPage === visible.length}
                indeterminate={selectedOnPage > 0 && selectedOnPage < visible.length}
                onCheckedChange={(enabled) => select(visible.map(({ rule }) => rule.id), enabled === true)}
              /> На этой странице
            </label>
            <span className="text-xs text-muted-foreground">Выбрано {chosen.length}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <SimpleSelect aria-label="Действие для выбранных правил" options={operations} value={batch}
              disabled={busy} onChange={(value) => { setBatch(value); setDestinationId(null) }} />
            <WriteButton size="sm" disabled={!ready} onClick={() => batch === 'delete' || batch === 'move' ? setConfirming(true) : void run()}>
              {busy ? 'Сохраняем…' : 'Применить к выбранным'}
            </WriteButton>
          </div>
          {batch === 'route' && <ActionPicker value={action} onChange={setAction} allow={['direct', 'vpn', 'zapret', 'block']} disabled={busy} />}
          {batch === 'move' && (destinations.length ? (
            <SimpleSelect className="w-full min-w-0" aria-label="Куда перенести правила" options={destinations}
              value={destination?.value ?? null} disabled={busy} onChange={setDestinationId} />
          ) : <p className="text-xs text-muted-foreground">Для выбранных правил нет другой доступной области.</p>)}
        </div>
      )}
      <RulePagination label="Страницы правил всех областей" page={page} onPage={setPageIndex} />
      {visible.length ? (
        <div className="divide-y overflow-hidden rounded-xl border border-border">
          {visible.map(({ policy, rule, index }, rowIndex) => (
            <div key={rule.id}>
              {(rowIndex === 0 || policy.id !== visible[rowIndex - 1].policyId) && <ScopeHeading policy={policy} />}
              <RuleRow
                rule={rule}
                index={index}
                onOpen={() => setQuery({ rule: rule.id })}
                dragHandle={selection ? <Checkbox aria-label={`Выбрать правило «${rule.name}»`}
                  checked={selection.has(rule.id)} disabled={busy || !can}
                  onCheckedChange={(enabled) => select([rule.id], enabled === true)} /> : undefined}
              />
            </div>
          ))}
        </div>
      ) : <EmptyState title="Правил по этим фильтрам нет" />}
      <Modal open={confirming} onClose={() => setConfirming(false)} dismissible={!busy}
        title={batch === 'move' ? 'Перенести выбранные правила?' : 'Удалить выбранные правила?'}
        description={batch === 'move' ? `${description} переместится в конец области «${destination?.label}».` : `Будет удалено ${description}.`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>Отмена</Button>
            <WriteButton variant={batch === 'delete' ? 'destructive' : 'default'} disabled={!ready} onClick={() => void run()}>
              {batch === 'move' ? 'Перенести' : 'Удалить'}
            </WriteButton>
          </div>
        }>{null}</Modal>
    </section>
  )
}

function ScopeHeading({ policy }: { policy: Policy }) {
  return <h2 className="border-y bg-muted/35 px-3 py-2 text-xs font-medium text-muted-foreground first:border-t-0">{policy.name}</h2>
}
