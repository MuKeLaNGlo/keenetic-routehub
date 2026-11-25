import { useState } from 'react'
import type { TrafficPeriod, TrafficSeries } from '@/api/contract'
import { isDemo } from '@/api/mode'
import { Segmented } from '@/components/rh/controls'
import { bytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTraffic } from '@/state/resource'

const plotWidth = 400
const plotHeight = 70
const plotPadding = 3
const periods = [
  { value: '5m', label: '5 мин', seconds: 300 },
  { value: '15m', label: '15 мин', seconds: 900 },
  { value: '1h', label: '1 ч', seconds: 3600 },
] satisfies { value: TrafficPeriod; label: string; seconds: number }[]

const series = [
  { name: isDemo ? 'Напрямую' : 'Получено', marker: 'border-muted-foreground', line: 'stroke-muted-foreground', dash: undefined },
  { name: isDemo ? 'Через VPN' : 'Отправлено', marker: 'border-info border-dashed', line: 'stroke-info', dash: '4 3' },
] as const

type Slot = readonly [number, number] | undefined

function buildSlots(data: TrafficSeries, seconds: number): Slot[] {
  if (!(data.stepSec > 0)) return []
  return Array.from({ length: Math.max(1, Math.round(seconds / data.stepSec)) }, (_, index) => {
    const point = data.points[index]
    if (!point) return undefined
    return isDemo ? point.routed && [point.routed.direct, point.routed.vpn] : [point.rx, point.tx]
  })
}

function linePath(slots: Slot[], index: 0 | 1, peak: number) {
  return slots.map((slot, i) => {
    if (!slot) return ''
    const x = plotPadding + (plotWidth - 2 * plotPadding) * i / Math.max(1, slots.length - 1)
    const y = plotHeight - plotPadding - (plotHeight - 2 * plotPadding) * slot[index] / peak
    const hasPrevious = slots[i - 1] !== undefined
    const point = `${hasPrevious ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
    return hasPrevious || slots[i + 1] ? point : `${point}h1`
  }).join(' ')
}

export function TrafficWidget() {
  const [period, setPeriod] = useState<TrafficPeriod>('15m')
  const { data, error } = useTraffic(period)
  const selected = periods.find(({ value }) => value === period)!
  const slots = data ? buildSlots(data, selected.seconds) : []
  const stepSec = data?.stepSec ?? 0
  const totals = [0, 0]
  let peak = 1
  let measurements = 0

  for (const slot of slots) {
    if (!slot) continue
    measurements++
    totals[0] += slot[0] * stepSec
    totals[1] += slot[1] * stepSec
    peak = Math.max(peak, slot[0], slot[1])
  }

  let notice: string | undefined
  if (error) notice = measurements ? 'Не удалось обновить данные' : 'Не удалось загрузить данные'
  else if (data?.state === 'error') notice = 'Сбор трафика недоступен'
  else if (!data) notice = 'Загрузка…'
  else if (!measurements) notice = isDemo ? 'Нет данных по маршрутам' : 'Нет замеров WAN'
  else if (data.state === 'stale') notice = 'Замеры устарели'
  else if (data.historySec < selected.seconds) notice = 'Доступна часть периода'
  else if (measurements < slots.length) notice = 'Есть пропуски в замерах'

  return (
    <section className="min-w-0" aria-labelledby="preview-traffic">
      <div className="mb-1 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <h2 id="preview-traffic" className="text-[15px] font-semibold">Трафик</h2>
        <Segmented<TrafficPeriod> size="sm" aria-label="Период графика" value={period} options={periods} onChange={setPeriod} />
      </div>

      <div className="rounded-xl border border-border bg-card px-3 py-2.5" aria-busy={!data && !error}>
        {data && <p className="mb-2 text-[11.5px] text-muted-foreground">{isDemo ? 'Демо' : data.object}</p>}
        <dl className="mb-2 grid grid-cols-2 gap-3">
          {series.map(({ name, marker }, i) => (
            <div key={name}>
              <dt className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className={cn('w-3.5 shrink-0 border-t-2', marker)} aria-hidden="true" />
                {name}
              </dt>
              <dd className="tabular mt-0.5 text-[18px] leading-tight font-semibold">{measurements ? bytes(Math.round(totals[i])) : '—'}</dd>
            </div>
          ))}
        </dl>

        {measurements > 0 ? (
          <>
            <svg
              viewBox={`0 0 ${plotWidth} ${plotHeight}`}
              height="68"
              preserveAspectRatio="none"
              className="block w-full"
              role="img"
              aria-label={isDemo ? `Скорость напрямую и через VPN за ${selected.label}` : `Скорость приёма и передачи WAN за ${selected.label}`}
            >
              <path d={`M0 ${plotHeight / 2}H${plotWidth}M0 ${plotHeight - 1}H${plotWidth}`} fill="none" className="stroke-border" vectorEffect="non-scaling-stroke" />
              {series.map(({ name, line, dash }, i) => (
                <path
                  key={name}
                  d={linePath(slots, i === 0 ? 0 : 1, peak)}
                  fill="none"
                  className={line}
                  strokeWidth="1.7"
                  strokeDasharray={dash}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground" aria-hidden="true">
              <span>{selected.label} назад</span>
              <span>Сейчас</span>
            </div>
          </>
        ) : (
          <div className="grid h-[68px] place-items-center border-b border-border text-[12px] text-muted-foreground" role="status">
            {notice}
          </div>
        )}

        {measurements > 0 && notice && <p className="mt-1.5 text-[11.5px] text-muted-foreground" role="status">{notice}</p>}
      </div>
    </section>
  )
}
