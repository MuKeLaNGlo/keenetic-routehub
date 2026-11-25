import { ChevronDown } from 'lucide-react'
import type { TrafficSeries } from '@/api/contract'
import { Segmented, TimeAgo } from '@/components/rh/controls'
import { Gate, KV, Panel } from '@/components/rh/layout'
import { StatusDot } from '@/components/rh/status'
import { duration } from '@/lib/format'
import { TrafficChart } from '@/screens/journal/TrafficChart'
import { PERIOD_LABEL, PERIOD_OPTIONS, PERIOD_SEC, periodOf } from '@/screens/journal/periods'
import { useTraffic } from '@/state/resource'
import { setQuery, useRoute } from '@/state/router'

function TelemetryData({ series }: { series: TrafficSeries }) {
  const hasSamples = series.points.some((point) => point !== null)
  const shortHistory = series.historySec < PERIOD_SEC[series.period]
  const failed = series.state === 'error'

  return (
    <>
      {series.state === 'stale' && (
        <p role="status" className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <StatusDot tone="warn" /> Данные устарели. Последняя выборка <TimeAgo at={series.lastSampleAt} />
        </p>
      )}

      {failed || !hasSamples ? (
        <div role="status" className="flex min-h-36 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-medium">
            {failed && <StatusDot tone="bad" />}
            {failed ? 'Сбор телеметрии остановлен' : 'Пока нет замеров'}
          </span>
          {failed && series.error && <p className="max-w-[52ch] text-xs text-muted-foreground">{series.error}</p>}
        </div>
      ) : (
        <>
          <TrafficChart series={series} />
          {shortHistory && <p className="mt-2 text-xs text-muted-foreground">Доступно {duration(series.historySec)} истории за период {PERIOD_LABEL[series.period]}.</p>}
        </>
      )}

      <details className="group mt-3 border-t border-border pt-1">
        <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
          Подробнее о замерах <ChevronDown className="size-3.5 group-open:rotate-180" aria-hidden="true" />
        </summary>
        <KV
          className="pt-1 pb-2"
          items={[
            ['Объект', series.object],
            ['Шаг выборки', `${series.stepSec} с`],
            ['Глубина истории', duration(series.historySec)],
            ['Последняя выборка', <TimeAgo at={series.lastSampleAt} />],
          ]}
        />
      </details>
    </>
  )
}

export function TelemetryPanel() {
  const route = useRoute()
  const period = periodOf(route.query.get('period'))
  const resource = useTraffic(period)

  return (
    <Panel className="rounded-2xl p-3.5 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Трафик WAN</h2>
        <Segmented
          size="sm"
          value={period}
          onChange={(next) => setQuery({ period: next === '5m' ? null : next }, { replace: true })}
          options={PERIOD_OPTIONS}
          aria-label="Период графика"
        />
      </div>

      <Gate res={resource} skeleton={<div aria-label="Загружается телеметрия" role="status" className="h-52 animate-pulse rounded-lg bg-muted/65 motion-reduce:animate-none" />}>
        {(series) => <TelemetryData series={series} />}
      </Gate>
    </Panel>
  )
}
