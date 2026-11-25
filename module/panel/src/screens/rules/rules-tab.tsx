import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ListChecks, Plus, Upload } from 'lucide-react'
import type { Action, Config, Policy, Rule } from '@/api/contract'
import { useCanWrite, useTopology } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'
import { EmptyState, Section } from '@/components/rh/layout'
import { RuleList, RuleEditor, InheritedRuleRow, emptyRule } from '@/components/rh/rules'
import { ActionChip, ActionPicker } from '@/components/rh/action'
import { SimpleSelect, WriteButton } from '@/components/rh/controls'
import { Modal } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { inheritedRules, policyChain, type InheritedRule } from '@/lib/policy'
import { newId, policyById } from '@/lib/entities'
import { count } from '@/lib/format'
import { RuleDisclosure } from './disclosure'
import { RULE_PAGE_SIZE, RulePagination, rulePage } from './rule-pagination'
import { ScopeChain } from './scope'
import { inheritSource } from './scopes'
import { moveRules, ruleDestinations } from './transfer'

const batchOperations = [
  { value: 'enable', label: 'Включить' },
  { value: 'disable', label: 'Выключить' },
  { value: 'route', label: 'Изменить маршрут' },
  { value: 'delete', label: 'Удалить' },
]

export function RulesTab({ policyId, compact }: {
  policyId: string
  compact?: { selector: ReactNode; rulesPath: string; editorOnly?: boolean }
}) {
  const { config, edit } = useDraft()
  const route = useRoute()
  const can = useCanWrite()
  const { data: topology } = useTopology()
  const [ownPage, setOwnPage] = useState(0)
  const [inheritedPage, setInheritedPage] = useState(0)
  const [selection, setSelection] = useState<Set<string> | null>(null)
  const [batchOperation, setBatchOperation] = useState('enable')
  const [batchAction, setBatchAction] = useState<Action>({ kind: 'vpn', target: { type: 'primary' } })
  const [batchBusy, setBatchBusy] = useState(false)
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)
  const ruleParam = route.query.get('rule')
  const isNew = ruleParam === 'new'
  /** A new rule gets a fresh id per opening; RuleEditor resets its copy when the prop changes. */
  const freshRule = useMemo(() => (ruleParam === 'new' ? emptyRule(newId('r')) : null), [ruleParam])
  const policy = config && policyById(config, policyId)
  const listEnabled = !compact?.editorOnly
  const paginate = !!compact
  const own = rulePage(policy?.rules.length ?? 0, ownPage)
  const ownStart = paginate ? own.start : 0
  const ownEnd = paginate ? own.end : own.total
  const visibleRules = useMemo(() => {
    if (!listEnabled || !policy) return []
    return ownStart === 0 && ownEnd === policy.rules.length ? policy.rules : policy.rules.slice(ownStart, ownEnd)
  }, [listEnabled, policy, ownStart, ownEnd])
  const visibleById = useMemo(() => new Map(visibleRules.map((rule) => [rule.id, rule])), [visibleRules])
  const source = listEnabled && config && policy ? inheritSource(config, policy) : null
  const parents = useMemo(() => config && source && paginate ? policyChain(config, source).chain : [], [config, source, paginate])
  const inherited = rulePage(parents.reduce((total, parent) => total + parent.rules.length, 0), inheritedPage)
  useEffect(() => {
    if (ownPage !== own.index) setOwnPage(own.index)
    if (inheritedPage !== inherited.index) setInheritedPage(inherited.index)
  }, [ownPage, own.index, inheritedPage, inherited.index])
  if (!config) return null

  if (!policy) return <EmptyState title="Политика не найдена">Возможно, её удалили в другой вкладке. Выберите область заново.</EmptyState>

  /** The palette can point at a rule of another scope — edit it where it lives. */
  const owner = ruleParam && !isNew ? config.policies.find((p) => p.rules.some((r) => r.id === ruleParam)) : undefined
  const editingPolicy = owner ?? policy
  const editingRule: Rule | null = freshRule ?? (ruleParam ? editingPolicy.rules.find((r) => r.id === ruleParam) : undefined) ?? null
  const segment = config.segmentPolicies.find((s) => s.policyId === policy.id)
  const editingSegment = config.segmentPolicies.find((s) => s.policyId === editingPolicy.id)
  const closeEditor = () => compact ? closeQuery('rule', 'match') : closeQuery('rule')
  const editor = (
    <RuleEditor
      compact={!!compact}
      open={!!ruleParam}
      rule={editingRule}
      isNew={isNew}
      scopeLabel={`политика «${editingPolicy.name}»`}
      traceSource={editingSegment ? `segment:${editingSegment.segmentId}` : undefined}
      tracePath={compact ? '/trace-preview' : undefined}
      onClose={closeEditor}
      transfer={compact && editingRule && !isNew ? {
        destinations: ruleDestinations(config, topology).filter(({ value }) => value !== editingPolicy.id),
        onMove: (rule, original, target) => edit(`Правило «${rule.name}» перенесено`, (c) =>
          moveRules(c, [{ policyId: editingPolicy.id, rule: original }], target, rule)),
      } : undefined}
      onSave={async (r, original) => {
        const saved = await edit(`${isNew ? 'Новое' : 'Изменено'} правило «${r.name}» в «${editingPolicy.name}»`, (c) => {
          const p = c.policies.find((x) => x.id === editingPolicy.id)
          if (!p) throw new Error('Политика удалена. Выберите другую область.')
          const i = p.rules.findIndex((x) => x.id === r.id)
          if (isNew && i < 0) {
            p.rules.unshift(r)
          } else {
            if (i < 0 || JSON.stringify(p.rules[i]) !== JSON.stringify(original)) {
              throw new Error('Правило изменилось в другой вкладке. Откройте его заново.')
            }
            p.rules[i] = r
          }
        })
        if (saved && compact && isNew && editingPolicy.id === policy.id) setOwnPage(0)
        return saved
      }}
      onDelete={
        isNew || !editingRule
          ? undefined
          : (original) => edit(`Удалено правило «${original.name}» из «${editingPolicy.name}»`, (c) => {
              const p = c.policies.find((x) => x.id === editingPolicy.id)
              const index = p?.rules.findIndex((x) => x.id === original.id) ?? -1
              if (!p || index < 0) return
              if (JSON.stringify(p.rules[index]) !== JSON.stringify(original)) {
                throw new Error('Правило изменилось в другой вкладке. Откройте его заново.')
              }
              p.rules.splice(index, 1)
            })
      }
    />
  )
  if (!listEnabled) return editor

  const visibleInherited = paginate
    ? inheritedWindow(parents, policy.disabledParentRuleIds, inherited.start, inherited.end)
    : inheritedRules(config, source, policy.disabledParentRuleIds)
  const patch = (c: Config, mutate: (p: Policy) => void) => {
    const target = c.policies.find((p) => p.id === policy.id)
    if (target) mutate(target)
  }

  const chosen = selection ? new Set(policy.rules.filter(({ id }) => selection.has(id)).map(({ id }) => id)) : null
  const selectedOnPage = chosen ? visibleRules.filter(({ id }) => chosen.has(id)).length : 0
  const changePageSelection = (enabled: boolean) => {
    setSelection((current) => {
      const updated = new Set(current)
      for (const { id } of visibleRules) {
        if (enabled) updated.add(id)
        else updated.delete(id)
      }
      return updated
    })
  }
  const applyBatch = async () => {
    if (!chosen?.size || batchBusy || !can) return
    const operation = batchOperations.find(({ value }) => value === batchOperation)
    if (!operation) return
    setBatchBusy(true)
    try {
      const saved = await edit(`${operation.label} ${count(chosen.size, ['правило', 'правила', 'правил'])}`, (config) => {
        patch(config, (target) => {
          if (batchOperation === 'delete') {
            target.rules = target.rules.filter(({ id }) => !chosen.has(id))
            return
          }
          for (const rule of target.rules) {
            if (!chosen.has(rule.id)) continue
            if (batchOperation === 'route') rule.action = structuredClone(batchAction)
            else rule.enabled = batchOperation === 'enable'
          }
        })
      })
      if (saved) {
        setSelection(null)
        setConfirmBatchDelete(false)
      }
    } finally {
      setBatchBusy(false)
    }
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {compact && policy.rules.length > 0 && (
        <WriteButton variant="outline" size="lg" aria-pressed={!!chosen} disabled={batchBusy} onClick={() => setSelection(chosen ? null : new Set())}>
          <ListChecks aria-hidden="true" /> {chosen ? 'Снять выбор' : 'Выбрать'}
        </WriteButton>
      )}
      <WriteButton variant="outline" size={compact ? 'lg' : 'sm'} onClick={() => setQuery({ import: '1' })}>
        <Upload /> Импорт
      </WriteButton>
      <WriteButton variant={compact ? 'default' : 'outline'} size={compact ? 'lg' : 'sm'} aria-label={compact ? 'Добавить правило' : undefined} onClick={() => setQuery({ rule: 'new' })}>
        <Plus /> {compact ? 'Добавить' : 'Правило'}
      </WriteButton>
    </div>
  )

  const ownRules = (
    <RuleList
      rules={visibleRules}
      indexOffset={ownStart}
      traceSource={segment ? `segment:${segment.segmentId}` : undefined}
      tracePath={compact ? '/trace-preview' : undefined}
      selectionFor={chosen ? (rule) => (
        <Checkbox
          checked={chosen.has(rule.id)}
          disabled={!can || batchBusy}
          aria-label={`Выбрать правило «${rule.name}»`}
          onCheckedChange={(enabled) => {
            setSelection((current) => {
              const updated = new Set(current)
              if (enabled) updated.add(rule.id)
              else updated.delete(rule.id)
              return updated
            })
          }}
        />
      ) : undefined}
      onOpen={(id) => setQuery({ rule: id })}
      onToggle={(id, v) =>
        edit(`${v ? 'Включено' : 'Выключено'} правило «${visibleById.get(id)?.name ?? id}»`, (c) =>
          patch(c, (p) => {
            const r = p.rules.find((x) => x.id === id)
            if (r) r.enabled = v
          }),
        )
      }
      onReorder={(ids) =>
        edit(`Порядок правил «${policy.name}»`, (c) =>
          patch(c, (p) => {
            const positions = new Set(ids)
            const matches = p.rules.filter((rule) => positions.has(rule.id))
            const byId = new Map(matches.map((rule) => [rule.id, rule]))
            if (matches.length !== ids.length || byId.size !== ids.length) return
            const ordered = ids.map((id) => byId.get(id)!)
            // Replace only the displayed subset's slots; other rules keep their exact positions.
            let index = 0
            p.rules = p.rules.map((rule) => positions.has(rule.id) ? ordered[index++] : rule)
          }),
        )
      }
      empty={compact ? (
        <div className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">Своих правил пока нет</div>
      ) : (
        <EmptyState
          title="В этой области нет своих правил"
          action={
            <WriteButton size="sm" variant="outline" onClick={() => setQuery({ rule: 'new' })}>
              <Plus /> Добавить правило
            </WriteButton>
          }
        >
          Действуют унаследованные правила и действие по умолчанию. Своё правило проверяется раньше них.
        </EmptyState>
      )}
    />
  )

  const inheritedList = (
    <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
      {visibleInherited.length === 0 && <div className="bg-card px-3 py-4 text-[13px] text-muted-foreground">Унаследованных правил нет</div>}
      {visibleInherited.map(({ rule, from, disabledHere }, index) => (
        <InheritedRuleRow
          key={`${from.id}/${rule.id}`}
          rule={rule}
          from={from.name}
          disabledHere={disabledHere}
          index={paginate && inherited.pages > 1 ? inherited.start + index : undefined}
          onToggleHere={(off) =>
            edit(`${off ? 'Отключено здесь' : 'Включено здесь'} «${rule.name}» в «${policy.name}»`, (c) =>
              patch(c, (p) => {
                p.disabledParentRuleIds = off ? [...new Set([...p.disabledParentRuleIds, rule.id])] : p.disabledParentRuleIds.filter((x) => x !== rule.id)
              }),
            )
          }
        />
      ))}
    </div>
  )

  const defaultPicker = (
    <ActionPicker
      value={policy.defaultAction}
      allow={['vpn', 'direct', 'keenetic', 'block', 'inherit']}
      disabled={!can}
      onChange={(a) =>
        edit(`Действие по умолчанию «${policy.name}»`, (c) =>
          patch(c, (p) => {
            p.defaultAction = a
          }),
        )
      }
    />
  )

  return (
    <>
      {compact ? (
        <div className="space-y-3.5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-full min-w-0 sm:max-w-sm sm:flex-1">{compact.selector}</div>
            {actions}
          </div>

          <section aria-label={`Правила области «${policy.name}»`}>
            {chosen && (
              <div className="mb-2.5 space-y-2.5 rounded-xl border bg-card p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <label className="flex items-center gap-2 pr-1 text-[13px]">
                    <Checkbox
                      disabled={!can || batchBusy || !visibleRules.length}
                      checked={visibleRules.length > 0 && selectedOnPage === visibleRules.length}
                      indeterminate={selectedOnPage > 0 && selectedOnPage < visibleRules.length}
                      onCheckedChange={(enabled) => changePageSelection(enabled === true)}
                    /> На этой странице
                  </label>
                  <span className="text-xs text-muted-foreground">Выбрано {chosen.size}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SimpleSelect aria-label="Действие для выбранных правил" value={batchOperation} options={batchOperations} onChange={setBatchOperation} disabled={batchBusy} />
                  <WriteButton size="sm" disabled={!chosen.size || batchBusy} onClick={() => batchOperation === 'delete' ? setConfirmBatchDelete(true) : void applyBatch()}>
                    {batchBusy ? 'Сохраняем…' : 'Применить к выбранным'}
                  </WriteButton>
                </div>
                {batchOperation === 'route' && <ActionPicker value={batchAction} onChange={setBatchAction} disabled={batchBusy} />}
              </div>
            )}
            {policy.rules.length > 1 && <p className="mb-1.5 text-xs text-muted-foreground">Приоритет сверху вниз</p>}
            {own.pages > 1 && (
              <div className="mb-2.5 space-y-2.5">
                <RulePagination label="Страницы своих правил" page={own} onPage={setOwnPage} />
                {can && <MoveRuleByPosition
                  total={own.total}
                  onMove={(from, to) => {
                    const rule = policy.rules[from]
                    if (!rule) return
                    edit(`Правило «${rule.name}» перемещено на позицию ${to + 1}`, (c) =>
                      patch(c, (p) => {
                        const currentIndex = p.rules.findIndex((item) => item.id === rule.id)
                        if (currentIndex === -1 || to >= p.rules.length || currentIndex === to) return
                        const [moved] = p.rules.splice(currentIndex, 1)
                        p.rules.splice(to, 0, moved)
                      }),
                    )
                    setOwnPage(Math.floor(to / RULE_PAGE_SIZE))
                  }}
                />}
              </div>
            )}
            {ownRules}
          </section>

          <div className="grid items-start gap-2.5">
            <RuleDisclosure
              title="Наследование"
              meta={<span className="text-xs text-muted-foreground">{inherited.total ? count(inherited.total, ['правило', 'правила', 'правил']) : 'Нет правил'}</span>}
              className="overflow-hidden rounded-xl ring-1 ring-border"
            >
              <div className="space-y-3">
                <ScopeChain config={config} policy={policy} compact rulesPath={compact.rulesPath} />
                <RulePagination label="Страницы унаследованных правил" page={inherited} onPage={setInheritedPage} />
                {inherited.total > 0 && inheritedList}
              </div>
            </RuleDisclosure>
            <RuleDisclosure
              title="Действие по умолчанию"
              meta={<ActionChip action={policy.defaultAction} />}
              className="overflow-hidden rounded-xl ring-1 ring-border"
            >
              <p className="mb-2 text-xs text-muted-foreground">Срабатывает, если не подошло ни одно правило.</p>
              {defaultPicker}
            </RuleDisclosure>
          </div>
        </div>
      ) : (
        <>
          <Section
            title={`Правила «${policy.name}»`}
            description="Порядок — это приоритет: срабатывает первое включённое совпадение. Перетащите строку, чтобы изменить порядок."
            actions={actions}
          >
            {ownRules}
          </Section>

          <Section title="Унаследовано из цепочки" description="Отключение действует только в этой области: исходная политика не меняется.">
            {inheritedList}
            {source && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                Источник: «{policyById(config, source)?.name ?? source}».{' '}
                <a className="text-foreground underline-offset-2 hover:underline" href={href('/rules', { policy: source })}>
                  Открыть её правила
                </a>
              </p>
            )}
          </Section>

          <Section title="Действие по умолчанию" description="Применяется, когда ни одно правило области и её цепочки не совпало.">
            <div className="rounded-xl px-3.5 py-3 ring-1 ring-border">
              {defaultPicker}
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                {policy.defaultAction.kind === 'inherit'
                  ? source
                    ? 'Наследовать: решение передаётся родительской политике. Если и там «наследовать» — действует штатный Keenetic.'
                    : 'Наследовать: родителя нет, поэтому действует штатный Keenetic.'
                  : 'Это действие получает трафик области, не совпавший ни с одним правилом.'}
              </p>
            </div>
          </Section>
        </>
      )}

      {editor}
      <Modal
        open={confirmBatchDelete}
        onClose={() => setConfirmBatchDelete(false)}
        dismissible={!batchBusy}
        title="Удалить выбранные правила?"
        description={`Будет удалено ${count(chosen?.size ?? 0, ['правило', 'правила', 'правил'])}.`}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={batchBusy} onClick={() => setConfirmBatchDelete(false)}>Отмена</Button>
            <WriteButton variant="destructive" disabled={batchBusy || !chosen?.size} onClick={() => void applyBatch()}>Удалить</WriteButton>
          </div>
        )}
      >{null}</Modal>
    </>
  )
}

function inheritedWindow(parents: Policy[], disabledIds: string[], start: number, end: number): InheritedRule[] {
  if (start === end) return []
  const disabled = new Set(disabledIds)
  const rows: InheritedRule[] = []
  let offset = 0
  for (const from of parents) {
    const fromIndex = Math.max(0, start - offset)
    const toIndex = Math.min(end - offset, from.rules.length)
    for (let index = fromIndex; index < toIndex; index++) {
      const rule = from.rules[index]
      rows.push({ rule, from, disabledHere: disabled.has(rule.id) })
    }
    offset += from.rules.length
    if (offset >= end) break
  }
  return rows
}

function MoveRuleByPosition({ total, onMove }: { total: number; onMove: (from: number, to: number) => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [notice, setNotice] = useState('')
  const fromNumber = Number(from)
  const toNumber = Number(to)
  const valid = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= total
  const canMove = valid(fromNumber) && valid(toNumber) && fromNumber !== toNumber

  return (
    <RuleDisclosure
      title="Переместить по номеру"
      className="overflow-hidden rounded-xl ring-1 ring-border"
    >
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canMove) return
          onMove(fromNumber - 1, toNumber - 1)
          setFrom('')
          setTo('')
          setNotice(`Правило перемещено с позиции ${fromNumber} на ${toNumber}.`)
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid w-24 min-w-0 gap-1 text-xs text-muted-foreground">
            С позиции
            <Input type="number" inputMode="numeric" min={1} max={total} value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="grid w-24 min-w-0 gap-1 text-xs text-muted-foreground">
            На позицию
            <Input type="number" inputMode="numeric" min={1} max={total} value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <WriteButton type="submit" disabled={!canMove}>Переместить</WriteButton>
        </div>
        <p className="text-xs text-muted-foreground">Укажите номера от 1 до {total}.</p>
        <p role="status" className="text-xs text-muted-foreground empty:hidden">{notice}</p>
      </form>
    </RuleDisclosure>
  )
}
