import { useEffect } from 'react'
import { EmptyState, Gate, Notice, Page } from '@/components/rh/layout'
import { PanelFeature } from '@/components/rh/feature'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { policyById } from '@/lib/entities'
import { parseEntryIndex } from '@/lib/rule-entries'
import { ImportModal } from '@/screens/rules/import-modal'
import { AllRules } from '@/screens/rules/all-rules'
import { RulesTab } from '@/screens/rules/rules-tab'
import { ScopeSelector } from '@/screens/rules/scope'
import { GeoTab, SetsTab } from '@/screens/rules/sets-tab'
import { isDemo } from '@/api/mode'
import { GeoSources } from '@/screens/rules/geo-sources'
import { useDraft } from '@/state/draft'
import { useServerConfig } from '@/state/resource'
import { href, setQuery, useRoute } from '@/state/router'
import { EntriesTab } from './entries-tab'
import { SetInspector } from './set-inspector'

const RULES_PATH = '/rules-preview'

export default function RulesPreview() {
  const { config } = useDraft()
  const server = useServerConfig()
  const route = useRoute()
  const tabParam = route.query.get('tab')
  const tab = tabParam === 'sets' || tabParam === 'geo' || tabParam === 'entries' ? tabParam : 'rules'
  const policyParam = route.query.get('policy')
  const allScopes = policyParam === 'all'
  const ruleParam = route.query.get('rule')
  const explicitPolicy = config && !allScopes ? policyById(config, policyParam) : undefined
  const ruleOwner = ruleParam && ruleParam !== 'new'
    ? config?.policies.find((policy) => policy.rules.some(({ id }) => id === ruleParam))
    : undefined
  const fallback = config?.policies.find(({ kind }) => kind === 'global') ?? config?.policies[0]
  const policy = explicitPolicy ?? ruleOwner ?? fallback
  const fallbackId = fallback?.id
  const ownerId = ruleOwner?.id
  const selectScope = (id: string) => setQuery({ policy: id, rule: null, match: null, import: null })

  useEffect(() => {
    if (tab === 'rules' && !policyParam && ownerId && ownerId !== fallbackId) {
      setQuery({ policy: ownerId }, { replace: true })
    }
  }, [tab, policyParam, ownerId, fallbackId])

  return (
    <Page className="pb-24 md:pb-14">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5">
        <h1 className="text-[1.75rem] leading-[1.15] font-[650] tracking-[-.042em] md:text-[1.9375rem]">Правила</h1>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => setQuery({ tab: value === 'rules' ? null : value, rule: null, match: null, set: null, entry: null, import: null })}
        className="min-w-0 gap-4"
      >
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Раздел правил" className="h-9 max-w-full p-0">
            <TabsTrigger className="px-2 after:bottom-[-3px] sm:px-3" value="rules">Правила</TabsTrigger>
            <TabsTrigger className="px-2 after:bottom-[-3px] sm:px-3" value="entries">Все записи</TabsTrigger>
            <TabsTrigger className="px-2 after:bottom-[-3px] sm:px-3" value="sets">Наборы</TabsTrigger>
            <TabsTrigger className="px-2 after:bottom-[-3px] sm:px-3" value="geo">Гео</TabsTrigger>
          </TabsList>
        </div>

        <Gate res={{ ...server, data: config }}>
          {(current) => (
            <>
              <TabsContent value="rules" className="min-w-0">
                {policy ? (
                  <>
                    {policyParam && !allScopes && !explicitPolicy && (
                      <Notice tone="warn" className="mb-3" title="Политика из ссылки недоступна">
                        Открыта область «{policy.name}».
                      </Notice>
                    )}
                    {allScopes && <AllRules config={current}
                      selector={<ScopeSelector config={current} policy={policy} compact all onChange={selectScope} />} />}
                    <RulesTab
                      key={policy.id}
                      policyId={policy.id}
                      compact={{
                        rulesPath: RULES_PATH,
                        editorOnly: allScopes,
                        selector: allScopes ? null : (
                          <ScopeSelector
                            config={current}
                            policy={policy}
                            compact
                            onChange={selectScope}
                          />
                        ),
                      }}
                    />
                  </>
                ) : (
                  <EmptyState title="Нет политик">
                    <a href={href('/networks-preview')} className="text-foreground underline underline-offset-4">Открыть сети и шаблоны</a>
                  </EmptyState>
                )}
              </TabsContent>
              <TabsContent value="sets" className="min-w-0">
                <PanelFeature name="namedSets"><SetsTab config={current} rulesPath={RULES_PATH} compact /></PanelFeature>
              </TabsContent>
              <TabsContent value="entries" className="min-w-0">
                <EntriesTab config={current} />
                {fallback && <RulesTab policyId={fallback.id} compact={{ rulesPath: RULES_PATH, selector: null, editorOnly: true }} />}
              </TabsContent>
              <TabsContent value="geo" className="min-w-0">
                {!isDemo && <GeoSources />}
                <GeoTab config={current} rulesPath={RULES_PATH} compact />
              </TabsContent>
              <SetInspector
                config={current}
                rulesPath={RULES_PATH}
                setId={tab === 'sets' || tab === 'entries' ? route.query.get('set') : null}
                linkedIndex={parseEntryIndex(route.query.get('entry'))}
              />
              <ImportModal open={route.query.get('import') === '1'} defaultPolicyId={policy?.id ?? ''} />
            </>
          )}
        </Gate>
      </Tabs>
    </Page>
  )
}
