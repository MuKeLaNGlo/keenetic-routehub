import { ChevronDown, ChevronRight, Route } from 'lucide-react'
import type { Config, Runtime, SubscriptionStatus, Topology, UpdateInfo } from '@/api/contract'
import { Page, Panel } from '@/components/rh/layout'
import { StatusDot } from '@/components/rh/status'
import { count } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCaps, useRuntime, useServerConfig, useSubscriptionStatus, useTopology, useUpdates } from '@/state/resource'
import { href } from '@/state/router'
import { ServicesWidget } from './ServicesWidget'
import { RouterResourcesWidget } from './RouterResourcesWidget'
import { TrafficWidget } from './TrafficWidget'
import { VpnControl } from './VpnControl'
import { VpnProfilePicker } from './VpnProfilePicker'
import './overview-preview.css'

interface Notice {
  id: string
  tone: 'bad' | 'warn' | 'info'
  title: string
  detail?: string
  to: string
}

const priority: Record<Notice['tone'], number> = { bad: 0, warn: 1, info: 2 }
const linkFocus = 'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring'

function getNotices({
  runtime,
  config,
  topology,
  subscriptions = [],
  updates = [],
}: {
  runtime?: Runtime
  config?: Config
  topology?: Topology
  subscriptions?: SubscriptionStatus[]
  updates?: UpdateInfo[]
}): Notice[] {
  const notices: Notice[] = []

  if (runtime?.wan.state === 'down')
    notices.push({ id: 'wan', tone: 'bad', title: 'Нет доступа в интернет', to: href('/journal-preview') })

  if (runtime?.services.core.state === 'failed')
    notices.push({ id: 'core', tone: 'bad', title: 'Сбой VPN-ядра', to: href('/exits-preview', { tab: 'engines' }) })

  if (runtime && config && runtime.loadedRevision !== config.revision)
    notices.push({
      id: 'revision', tone: 'warn', title: 'Новая ревизия ещё не действует',
      detail: `Роутер на r${runtime.loadedRevision}, сохранена r${config.revision}`,
      to: href('/system-preview', { tab: 'revisions' }),
    })

  for (const group of config?.exitGroups ?? []) {
    const status = runtime?.groups[group.id]
    if (!status || status.state === 'ok') continue
    notices.push({
      id: group.id,
      tone: status.state === 'failed' ? 'bad' : 'warn',
      title: status.state === 'failed' ? 'Группа VPN недоступна' : 'Группа VPN переключилась',
      detail: group.name,
      to: href('/exits-preview', { tab: 'groups', g: group.id }),
    })
  }

  for (const policy of config?.dns ?? []) {
    const status = runtime?.dns[policy.id]
    if (!policy.managed || !status || status.active === 'primary' || status.active === 'unknown') continue
    notices.push({
      id: policy.id,
      tone: status.active === 'none' ? 'bad' : 'warn',
      title: status.active === 'none' ? 'DNS недоступен' : 'DNS использует резерв',
      detail: policy.name,
      to: href('/dns-preview'),
    })
  }

  for (const service of config?.zapret ?? []) {
    const status = runtime?.zapret[service.id]
    if (!service.enabled || !status) continue
    const failed = status.engine === 'failed' || status.payloadCheck === 'down'
    if (status.engine === 'running' && !failed && status.payloadCheck !== 'degraded') continue
    notices.push({
      id: service.id,
      tone: failed ? 'bad' : 'warn',
      title: failed ? 'Сбой Zapret' : 'Частичный сбой Zapret',
      detail: service.id === 'youtube' ? 'YouTube' : 'Discord',
      to: href('/zapret-preview'),
    })
  }

  for (const subscription of subscriptions) {
    if (subscription.lastAttempt?.ok !== false) continue
    notices.push({
      id: subscription.subscriptionId,
      tone: 'warn',
      title: 'Подписка не обновилась',
      detail: config?.subscriptions.find((item) => item.id === subscription.subscriptionId)?.name,
      to: href('/exits-preview', { tab: 'subscriptions' }),
    })
  }

  const unbound = topology?.devices.filter(({ binding }) => binding === 'ambiguous' || binding === 'lost') ?? []
  if (unbound.length)
    notices.push({
      id: 'binding', tone: 'warn',
      title: `${count(unbound.length, ['устройство', 'устройства', 'устройств'])} без привязки`,
      to: href('/devices-preview', { status: 'attention' }),
    })

  const available = updates.filter(({ state }) => state === 'available')
  if (available.length)
    notices.push({
      id: 'updates', tone: 'info',
      title: count(available.length, ['доступное обновление', 'доступных обновления', 'доступных обновлений']),
      to: href('/system-preview', { tab: 'updates' }),
    })

  return notices.sort((left, right) => priority[left.tone] - priority[right.tone])
}

function NoticeList({ notices }: { notices: Notice[] }) {
  return (
    <ul className="divide-y divide-border">
      {notices.map(({ id, tone, title, detail, to }) => (
        <li key={id}>
          <a href={to} className={cn('flex min-h-12 items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-surface-2', linkFocus)}>
            <StatusDot tone={tone} />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="block text-[13px] font-medium leading-snug">{title}</span>
              {detail && <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{detail}</span>}
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  )
}

function Attention({
  notices,
  error,
  loading,
  retry,
}: {
  notices: Notice[]
  error: string | null
  loading: boolean
  retry: () => void
}) {
  const visible = notices.slice(0, 3)
  const more = notices.slice(3)

  return (
    <section aria-labelledby="preview-attention" className="min-w-0 flex-1">
      <Panel className="flex h-full flex-col rounded-2xl p-3.5">
        <h2 id="preview-attention" className="px-2.5 pt-1 pb-2 text-[15px] font-semibold">Требует внимания</h2>
        {visible.length ? (
          <>
            <NoticeList notices={visible} />
            {more.length > 0 && (
              <details className="group border-t border-border">
                <summary className={cn('flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-surface-2 [&::-webkit-details-marker]:hidden', linkFocus)}>
                  Ещё {more.length}
                  <ChevronDown className="size-3.5 group-open:rotate-180" aria-hidden="true" />
                </summary>
                <NoticeList notices={more} />
              </details>
            )}
          </>
        ) : error ? null : loading ? (
          <p role="status" className="px-2.5 py-2 text-[13px] text-muted-foreground">Загружается…</p>
        ) : (
          <p className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted-foreground"><StatusDot tone="ok" /> Активных предупреждений нет</p>
        )}
        {error && (
          <div className="space-y-1 px-2.5 py-2 text-[13px]">
            <p className="flex items-center gap-2"><StatusDot tone="warn" /> Часть данных недоступна</p>
            <button type="button" onClick={retry} className={cn('min-h-9 rounded-sm text-muted-foreground underline underline-offset-4', linkFocus)}>Обновить данные</button>
          </div>
        )}
        <div className="mt-auto pt-3">
          <div className="flex flex-wrap gap-x-1 border-t border-border pt-1">
            <a href={href('/trace-preview')} className={cn('flex min-h-10 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground', linkFocus)}>
              <Route className="size-3.5" aria-hidden="true" /> Проверка маршрута
            </a>
            <a href={href('/journal-preview')} className={cn('flex min-h-10 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground', linkFocus)}>
              Журнал <ChevronRight className="size-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </Panel>
    </section>
  )
}

export default function OverviewPreview() {
  const caps = useCaps()
  const runtime = useRuntime()
  const config = useServerConfig()
  const topology = useTopology()
  const subscriptions = useSubscriptionStatus()
  const updates = useUpdates()
  const resources = [runtime, config, topology, subscriptions, updates]
  const error = resources.find((resource) => resource.error)?.error ?? null
  const data = runtime.error ? undefined : runtime.data
  const notices = getNotices({
    runtime: data,
    config: config.error ? undefined : config.data,
    topology: topology.error ? undefined : topology.data,
    subscriptions: subscriptions.error ? undefined : subscriptions.data,
    updates: updates.error ? undefined : updates.data,
  })

  return (
    <Page className="overview-preview pb-24 md:pb-14">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="overview-preview__title">Обзор</h1>
          {caps.data && <p className="mt-1 text-[13px] text-muted-foreground">{caps.data.device.name} <span className="mx-0.5" aria-hidden="true">·</span> {caps.data.device.model}</p>}
        </div>
      </header>

      <div className="overview-preview__primary">
        <div className="min-w-0"><VpnControl /></div>
        <div className="overview-preview__side">
          <VpnProfilePicker />
          <Attention
            notices={notices}
            error={error}
            loading={resources.some((resource) => resource.data === undefined)}
            retry={() => { void Promise.all(resources.map((resource) => resource.refetch())) }}
          />
        </div>
      </div>

      <div className="overview-preview__secondary">
        <div className="overview-preview__services-slot">
          <ServicesWidget runtime={data} unavailable={runtime.error !== null} />
        </div>
        <TrafficWidget />
      </div>
      <RouterResourcesWidget />
    </Page>
  )
}
