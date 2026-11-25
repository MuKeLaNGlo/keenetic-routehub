import { useEffect } from 'react'
import { api } from '@/api'
import type { ResourceCapacity, RouterResources } from '@/api/contract'
import { Panel } from '@/components/rh/layout'
import { bytes } from '@/lib/format'
import { refetch, useResource } from '@/state/resource'

const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, style: 'percent' })
const resourceKey = 'router-resources'
const displayPercent = (value: number | null | undefined) => value == null ? '—' : percent.format(value / 100)
const usagePercent = ({ used, total }: ResourceCapacity) => used / total * 100
const displayBytes = (value: number | null | undefined) => value == null ? '—' : bytes(value)

function History({ data, metric, label }: { data?: RouterResources; metric: 'cpu' | 'ram'; label: string }) {
  if (!data || !data.samples.some((sample) => sample[metric] !== null)) {
    return <div className="flex h-10 items-center text-[11px] text-muted-foreground">Нет замеров</div>
  }
  const slots = Array<number | null>(Math.floor(data.windowSec / data.intervalSec) + 1).fill(null)
  const end = Date.parse(data.at)
  for (const sample of data.samples) {
    const index = slots.length - 1 - Math.round((end - Date.parse(sample.at)) / (data.intervalSec * 1000))
    if (index >= 0 && index < slots.length) slots[index] = sample[metric]
  }
  return (
    <div role="img" aria-label={label} className="flex h-10 items-end gap-px border-b border-border">
      {slots.map((value, index) => (
        <span key={index} aria-hidden="true" className={`min-w-0 flex-1 rounded-t-sm ${metric === 'cpu' ? 'bg-info/65' : 'bg-primary/65'}`}
          style={{ height: value == null ? 0 : `${Math.min(100, Math.max(value, 1))}%` }} />
      ))}
    </div>
  )
}

function LiveRouterResources() {
  const { data, error } = useResource(resourceKey, () => api.getRouterResources!(), [])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void refetch(resourceKey)
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const ram = data?.ram
  const disk = data?.disk
  return (
    <section className="mt-5" aria-labelledby="preview-router-resources">
      <div className="mb-1 flex min-h-9 items-center justify-between gap-2">
        <h2 id="preview-router-resources" className="text-[15px] font-semibold">Ресурсы роутера</h2>
        <span className="text-[11.5px] text-muted-foreground">Последняя минута</span>
      </div>
      <Panel className="rounded-xl px-3 py-2.5" aria-busy={!data && !error}>
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px] text-muted-foreground">
              <span>CPU</span>
              <strong className="tabular text-[18px] font-semibold text-foreground">{displayPercent(data?.cpu)}</strong>
            </div>
            <History data={data} metric="cpu" label="Загрузка CPU за последнюю минуту" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px] text-muted-foreground">
              <span>RAM</span>
              <strong className="tabular text-[18px] font-semibold text-foreground">{displayPercent(ram && usagePercent(ram))}</strong>
            </div>
            <History data={data} metric="ram" label="Занятость RAM за последнюю минуту" />
          </div>
        </div>
        {ram && (
          <div className="tabular mt-2 grid gap-1 text-right text-[11.5px] text-muted-foreground">
            <p>Занято {bytes(ram.used)} из {bytes(ram.total)} · доступно {bytes(ram.available)}</p>
            {data?.sharedRam != null && <p>Временные файлы и общая память · {bytes(data.sharedRam)}</p>}
          </div>
        )}
        <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
          <div>
            <h3 className="text-[12px] font-medium text-muted-foreground" title="Резидентная память процессов на роутере">Память процессов (RSS)</h3>
            <dl className="mt-1 grid gap-1 text-[12px]">
              <div className="flex justify-between gap-2"><dt>RouteHub и веб-панель</dt><dd className="tabular font-medium">{displayBytes(data?.routeHubRss)}</dd></div>
              <div className="flex justify-between gap-2"><dt>Ядро Xray</dt><dd className="tabular font-medium">{displayBytes(data?.xrayRss)}</dd></div>
            </dl>
          </div>
          <div className="min-w-0">
            <div className="flex justify-between gap-2">
              <h3 className="text-[12px] font-medium text-muted-foreground">Накопитель</h3>
              <span className="tabular text-[12px] font-medium">{displayPercent(disk && usagePercent(disk))}</span>
            </div>
            {disk && (
              <>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className="h-full rounded-full bg-primary/65" style={{ width: `${usagePercent(disk)}%` }} />
                </div>
                <p className="tabular mt-1.5 text-[11.5px] text-muted-foreground">Занято {bytes(disk.used)} из {bytes(disk.total)} · доступно {bytes(disk.available)}</p>
              </>
            )}
          </div>
        </div>
        {error && <p role="status" className="mt-2 text-[11.5px] text-muted-foreground">{data ? 'Не удалось обновить показания' : 'Показания роутера недоступны'}</p>}
      </Panel>
    </section>
  )
}

export function RouterResourcesWidget() {
  return api.getRouterResources ? <LiveRouterResources /> : null
}
