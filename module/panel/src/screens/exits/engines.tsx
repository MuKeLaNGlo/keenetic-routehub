import { ArrowRight, Boxes, ChevronDown, Cpu, HardDrive, MemoryStick, RefreshCw } from 'lucide-react'
import { useRuntime } from '@/state/resource'
import { href } from '@/state/router'
import { EmptyState, Gate, KV, Notice, Panel, Section, SkeletonBlock } from '@/components/rh/layout'
import { SERVICE, StatusBadge, StatusDot } from '@/components/rh/status'
import { count } from '@/lib/format'
import { engineName } from './shared'

export default function EnginesTab({ compact = false }: { compact?: boolean }) {
  const runtime = useRuntime()
  const { data: rt } = runtime
  if (compact) return (
    <Gate res={runtime} skeleton={<SkeletonBlock rows={4} />}>
      {(data) => (
        <div className="space-y-2.5">
          {data.engines.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {data.engines.map((engine) => {
                const state = SERVICE[engine.status]
                const newVersion = engine.available && engine.installed !== engine.available
                return (
                  <li key={engine.id}>
                    <details className="group">
                      <summary className="flex min-h-[58px] cursor-pointer list-none items-center gap-2.5 px-3.5 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                        <Cpu className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13.5px] font-semibold [overflow-wrap:anywhere]">{engine.name || engineName(engine.id)}</span>
                          <span className="block text-[12px] text-muted-foreground">{engine.installed ?? 'Без установленной версии'}{newVersion && ` · доступна ${engine.available}`}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                          <StatusDot tone={state.tone} /> {state.label}
                        </span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
                      </summary>
                      <div className="space-y-2 border-t border-border px-3.5 py-2.5">
                        <KV items={[
                          ['Источник', engine.source],
                          ['Память', `${engine.ramMb} МБ`],
                          ['Диск', `${engine.diskMb} МБ`],
                          ['Используют', count(engine.usedBy, ['профиль', 'профиля', 'профилей'])],
                          ['Возможности', engine.capabilities.join(', ') || 'Не заявлены'],
                        ]} />
                        {(!engine.installed || engine.status === 'failed') && <p className="text-xs text-warn">Профили с этим адаптером сейчас не подключатся.</p>}
                      </div>
                    </details>
                  </li>
                )
              })}
            </ul>
          ) : <EmptyState icon={<Boxes />} title="Ядра не найдены" />}
          <a href={href('/system', { tab: 'updates', component: 'xray' })} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-[13px] text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            <RefreshCw className="size-3.5" aria-hidden="true" /> Обновления Xray <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      )}
    </Gate>
  )
  if (!rt) return <SkeletonBlock rows={4} />
  const engines = rt.engines
  const installed = engines.filter((e) => e.installed)

  return (
    <>
      <Section
        title="Ядра исполнения"
        description="Ядро — это то, что реально исполняет протокол профиля. Профиль в каталоге его не запускает: процесс поднимается только для выбранного выхода."
      >
        {engines.length === 0 ? (
          <EmptyState icon={<Boxes />} title="Ядра не найдены">
            Сведения о компонентах приходят с роутера. Если их нет, профили не смогут подключиться.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {engines.map((e) => {
              const service = SERVICE[e.status]
              const updateAvailable = !!e.installed && !!e.available && e.available !== e.installed
              return (
                <Panel key={e.id} className="space-y-3 p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Cpu className="size-4 text-muted-foreground" />
                    <span className="text-[15px] font-semibold">{e.name || engineName(e.id)}</span>
                    <StatusBadge tone={service.tone} dashed={e.status === 'not-installed'}>
                      {service.label}
                    </StatusBadge>
                    <StatusBadge tone={e.installed ? 'muted' : 'warn'} dashed={!e.installed}>
                      {e.installed ? `установлено ${e.installed}` : 'не установлено'}
                    </StatusBadge>
                    {updateAvailable && <StatusBadge tone="info">доступно {e.available}</StatusBadge>}
                  </div>

                  <div className="grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Boxes className="size-3.5" /> Источник: <span className="text-foreground">{e.source}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <MemoryStick className="size-3.5" /> Память: <span className="text-foreground tabular">{e.ramMb} МБ</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <HardDrive className="size-3.5" /> Диск: <span className="text-foreground tabular">{e.diskMb} МБ</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      Используют: <span className="text-foreground">{count(e.usedBy, ['профиль', 'профиля', 'профилей'])}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] text-muted-foreground">Возможности:</span>
                    {e.capabilities.length ? (
                      e.capabilities.map((c) => (
                        <span key={c} className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">
                          {c}
                        </span>
                      ))
                    ) : (
                      <span className="text-[12px] text-muted-foreground">не заявлены</span>
                    )}
                  </div>

                  {!e.installed && (
                    <Notice tone="warn" title="Ядро не установлено">
                      Профили с этим адаптером не подключатся, пока компонент не установлен. Установка идёт отдельной проверкой совместимости — версия, место на диске и целостность пакета.
                    </Notice>
                  )}
                  {e.status === 'failed' && (
                    <Notice tone="bad" title="Ядро не запускается">
                      Профили, назначенные этому ядру, недоступны. Действующая конфигурация не меняется: маршруты остаются на прежнем выходе, пока ядро не восстановится.
                    </Notice>
                  )}
                </Panel>
              )
            })}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-card px-3.5 py-3 text-[12.5px] ring-1 ring-border">
          <RefreshCw className="size-4 text-muted-foreground" />
          <span className="flex-1 text-muted-foreground">
            Панель обновляет Xray с проверкой SHA-256 из GitHub Releases. AmneziaWG входит в пакет RouteHub, WireGuard ASC обновляется с KeeneticOS.
          </span>
          <a href={href('/system', { tab: 'updates' })} className="pressable inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 font-medium hover:bg-accent">
            Обновить в «Обслуживании» <ArrowRight className="size-3.5" />
          </a>
        </div>

        <p className="mt-2 text-[12px] text-muted-foreground">
          Установлено ядер: {installed.length} из {engines.length}. Память и диск — по данным роутера, а не оценки панели.
        </p>
      </Section>
    </>
  )
}
