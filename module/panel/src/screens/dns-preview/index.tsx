import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Availability, DnsPolicy, Topology } from '@/api/contract'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { Mono } from '@/components/rh/controls'
import { EmptyState, Notice, Page, Panel, SkeletonBlock } from '@/components/rh/layout'
import { PreviewHeader } from '@/components/rh/preview-header'
import { StatusDot } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { segmentName } from '@/lib/entities'
import { cn } from '@/lib/utils'
import { DnsCheck, type DnsCheckSession } from '@/screens/dns/check'
import { PolicySettings } from '@/screens/dns/settings'
import { useCaps, useRuntime, useServerConfig, useTopology } from '@/state/resource'
import { href, useRoute } from '@/state/router'
import { ResolverEditor } from './ResolverEditor'
import { resolverStatus } from './status'

const path = '/dns-preview'

function DnsLimits({ perDevice }: { perDevice?: Availability }) {
  return (
    <details className="group rounded-xl border border-border bg-card">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        Ограничения DNS <ChevronDown className="size-3.5 shrink-0 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <dl className="grid gap-2.5 border-t border-border px-3.5 py-3 text-[12.5px] @min-[610px]:grid-cols-3 @min-[610px]:gap-4">
        <div>
          <dt className="font-medium">Локальные имена</dt>
          <dd className="mt-0.5 text-muted-foreground">Имена <Mono>home.arpa</Mono> и обратные запросы к частным адресам остаются у Keenetic.</dd>
        </div>
        <div>
          <dt className="font-medium">Приватный DNS клиента</dt>
          <dd className="mt-0.5 text-muted-foreground">Собственный DoH или DoT устройства обходит DNS-политику роутера.</dd>
        </div>
        {perDevice && (
          <div>
            <dt className="font-medium">DNS для устройства</dt>
            <dd className="mt-0.5 text-muted-foreground">{perDevice.available ? 'Доступен для клиентов с подтверждённой привязкой.' : perDevice.reason ?? 'Перенаправление по устройствам недоступно.'}</dd>
          </div>
        )}
      </dl>
    </details>
  )
}

function NetworkLinks({ policy, topology }: { policy: DnsPolicy; topology?: Topology }) {
  if (!policy.segmentIds.length) return null
  return (
    <ul aria-label="Сети политики" className="flex flex-wrap gap-1.5">
      {policy.segmentIds.map((id) => (
        <li key={id}>
          <a href={href('/networks-preview', { s: id })} className="inline-flex rounded-md bg-muted px-2 py-1 text-xs underline-offset-2 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            {segmentName(topology, id)}
          </a>
        </li>
      ))}
    </ul>
  )
}

export default function DnsPreview() {
  const route = useRoute()
  const caps = useCaps()
  const topology = useTopology()
  const runtime = useRuntime()
  const serverConfig = useServerConfig()
  const server = serverConfig.data
  const [checks, setChecks] = useState<Record<string, DnsCheckSession>>({})
  const diagnostics = useRef<HTMLElement>(null)
  const readOnly = caps.data?.access === 'read'
  const canEdit = !!server && caps.data?.access === 'write'
  const offline = runtime.data?.link.state === 'offline'
  const revisionMismatch = !!server && !!runtime.data && runtime.data.loadedRevision !== server.revision
  const staleReason = serverConfig.error ?? runtime.error ?? (offline ? 'Роутер вне сети.' : null)
  const current = server && !staleReason && !revisionMismatch ? runtime.data : undefined
  const policies = server?.dns ?? []
  const requestedId = route.query.get('policy')
  const selected = policies.find((policy) => policy.id === requestedId) ?? policies.find((policy) => policy.managed) ?? policies[0]
  const selectedId = selected?.id
  const checkLink = route.query.get('tab') === 'checks'

  useEffect(() => {
    if (selectedId && checkLink) diagnostics.current?.scrollIntoView({ block: 'start' })
  }, [selectedId, checkLink])

  function refresh() {
    void serverConfig.refetch()
    void runtime.refetch()
  }

  return (
    <Page className="@container pb-24 md:pb-14">
      <PreviewHeader title="DNS" actions={readOnly && <ReadOnlyHint />} />

      <div className="space-y-3.5">
        {staleReason && (
          <Notice tone="warn" title={server ? 'Текущий статус DNS недоступен' : 'Не удалось загрузить политики DNS'} action={<Button variant="outline" size="sm" onClick={refresh}>Обновить</Button>}>
            {staleReason}
          </Notice>
        )}

        {!server ? (
          !staleReason && <SkeletonBlock rows={3} />
        ) : !policies.length ? (
          <EmptyState title="Политики DNS не настроены" />
        ) : (
          <nav aria-label="DNS-политики сетей">
            <ul className="grid gap-2 @min-[540px]:grid-cols-2">
              {policies.map((policy) => {
                const active = policy.id === selectedId
                  const status = resolverStatus(policy, current, true)
                const segments = policy.segmentIds.map((id) => segmentName(topology.data, id))
                return (
                  <li key={policy.id} className="min-w-0">
                    <a
                      href={href(path, { policy: policy.id })}
                      aria-current={active ? 'true' : undefined}
                      className={cn('block h-full space-y-1.5 rounded-xl border bg-card px-3.5 py-3 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/60', active ? 'border-foreground/45' : 'border-border')}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13.5px] font-semibold [overflow-wrap:anywhere]">{policy.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{segments.length ? segments.join(', ') : 'Без сети'}</p>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span className="inline-flex items-center gap-1.5 font-medium"><StatusDot tone={status.tone} /> {revisionMismatch && !staleReason && policy.managed ? 'Синхронизация DNS…' : status.label}</span>
                        {status.address && status.address !== '—' && <Mono className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{status.address}</Mono>}
                      </div>
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
        )}

        {requestedId && server && !policies.some(({ id }) => id === requestedId) && <p className="text-xs text-muted-foreground">Политика из ссылки отсутствует в конфигурации.</p>}

        {selected && (
          <section aria-labelledby="dns-settings-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="dns-settings-title" className="text-base font-semibold">Настройки DNS</h2>
              <NetworkLinks policy={selected} topology={topology.data} />
            </div>
            {selected.managed ? (
              <div className="grid items-start gap-3 @min-[790px]:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
                <ResolverEditor key={selected.id} policy={selected} uplinkId={caps.data?.ispUplinks[0]?.id} disabled={!canEdit} />
                <Panel className="overflow-hidden rounded-2xl">
                  <h3 className="border-b px-3.5 py-3 text-sm font-semibold">Обработка запросов</h3>
                  <PolicySettings key={selected.id} policy={selected} compact disabled={!canEdit} />
                </Panel>
              </div>
            ) : (
              <Panel className="rounded-xl px-3.5 py-3 text-[13px] text-muted-foreground">
                Этой сети отвечает штатный DNS Keenetic. Настройки резолвера доступны в KeeneticOS.
              </Panel>
            )}
          </section>
        )}

        {selected && (
          <section ref={diagnostics} aria-labelledby="dns-diagnostics-title" className="scroll-mt-20 space-y-2">
            <h2 id="dns-diagnostics-title" className="text-base font-semibold">Диагностика DNS</h2>
            {selected.managed ? (
              <>
                {!current && (staleReason || !runtime.data) && <p className="text-xs text-muted-foreground">Дождитесь связи с роутером и его текущей ревизии.</p>}
                <Panel className="rounded-2xl">
                  <DnsCheck
                    key={selected.id}
                    compact
                    policy={selected}
                    disabled={!current}
                    revision={current?.loadedRevision}
                    session={checks[selected.id]}
                    onSessionChange={(update) => setChecks((sessions) => ({ ...sessions, [selected.id]: update(sessions[selected.id] ?? {}) }))}
                  />
                </Panel>
              </>
            ) : (
              <Panel className="rounded-xl px-3.5 py-3 text-[13px] text-muted-foreground">
                Проверки RouteHub доступны для сетей с управляемым DNS.
              </Panel>
            )}
          </section>
        )}

        {server && <DnsLimits perDevice={caps.data?.perDeviceDns} />}
      </div>
    </Page>
  )
}
