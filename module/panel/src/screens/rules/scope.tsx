/** Scope rail: pick a policy, see what it inherits from. */
import type { Config, Policy } from '@/api/contract'
import { SimpleSelect } from '@/components/rh/controls'
import { ChevronRight, Route } from 'lucide-react'
import { href } from '@/state/router'
import { scopeChain, scopeKind, scopeOptions } from './scopes'

export function ScopeSelector({ config, policy, onChange, compact, all }: {
  config: Config
  policy: Policy
  onChange: (id: string) => void
  compact?: boolean
  all?: boolean
}) {
  const options = scopeOptions(config)
  if (compact) options.unshift({ value: 'all', label: 'Все области' })
  return (
    <div className="space-y-1.5" role={compact ? 'group' : undefined} aria-label={compact ? 'Область правил' : undefined}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] text-muted-foreground">
        <span>Область правил</span>
        {compact && !all && policy.kind !== 'global' && <span className="text-[11px]">{scopeKind(config, policy)}</span>}
      </div>
      <SimpleSelect aria-label="Область правил" className="w-full min-w-0" value={all ? 'all' : policy.id} options={options} onChange={onChange} />
    </div>
  )
}

export function ScopeChain({ config, policy, compact = false, rulesPath = '/rules' }: {
  config: Config
  policy: Policy
  compact?: boolean
  rulesPath?: string
}) {
  const { chain, cycle } = scopeChain(config, policy)
  const segment = config.segmentPolicies.find((s) => s.policyId === policy.id)
  return (
    <div className={compact ? 'space-y-2' : 'space-y-4'}>
      <div>
        {!compact && <div className="mb-1.5 text-[12px] text-muted-foreground">Цепочка</div>}
        <ol className={compact ? 'flex flex-wrap gap-x-2 gap-y-1 text-[12.5px]' : 'space-y-1 text-[12.5px]'} aria-label={compact ? 'Цепочка областей' : undefined}>
          {chain.map((p, i) => (
            <li key={p.id} className={compact ? 'flex min-w-0 flex-wrap items-baseline gap-1.5' : 'flex items-start gap-1.5'}>
              {i > 0 && <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
              <a
                href={href(rulesPath, { policy: p.id })}
                className={i === 0 ? 'font-medium text-foreground' : 'text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'}
                aria-current={i === 0 ? 'page' : undefined}
              >
                {p.name}
              </a>
              <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground/80">{scopeKind(config, p)}</span>
            </li>
          ))}
        </ol>
        {cycle ? (
          <p className="mt-2 text-[12px] text-bad" role="alert">
            Цепочка политик замкнута в цикл — применение такой конфигурации будет отклонено.
          </p>
        ) : !compact && (
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            Свои правила проверяются сверху вниз, затем унаследованные из цепочки, затем действие по умолчанию.
          </p>
        )}
      </div>

      {segment && (
        <a href={href(compact ? '/trace-preview' : '/trace', { src: `segment:${segment.segmentId}` })} className="inline-flex items-center gap-1.5 text-[12.5px] text-info hover:underline">
          <Route className="size-3.5" /> {compact ? 'Проверить маршрут из сети' : 'Почему так? Проверить маршрут из этой сети'}
        </a>
      )}
    </div>
  )
}

export function ScopePanel({ config, policy, onChange }: { config: Config; policy: Policy; onChange: (id: string) => void }) {
  return (
    <div className="space-y-4">
      <ScopeSelector config={config} policy={policy} onChange={onChange} />
      <ScopeChain config={config} policy={policy} />
    </div>
  )
}
