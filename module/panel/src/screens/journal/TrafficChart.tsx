import { useMemo, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TrafficSeries } from '@/api/contract'
import { bitrate, clock } from '@/lib/format'
import { PERIOD_LABEL, PERIOD_SEC } from './periods'

const W = 1000
const H = 140

const RX = 'var(--info)'
const TX = 'var(--muted-foreground)'

interface Slot {
  t: number
  rx: number | null
  tx: number | null
}

/**
 * The series arrives as a sparse list: missing samples are `null` (and a stale
 * series is simply shorter). Lay it onto the period's own time grid so every
 * slot keeps the time it really belongs to — old points are never stretched
 * towards "now".
 */
function buildSlots(series: TrafficSeries): Slot[] {
  const stepMs = series.stepSec * 1000
  const count = Math.max(1, Math.round(PERIOD_SEC[series.period] / series.stepSec))
  const tEnd = Math.floor(Date.now() / stepMs) * stepMs
  const t0 = tEnd - (count - 1) * stepMs
  const slots: Slot[] = Array.from({ length: count }, (_, i) => ({ t: t0 + i * stepMs, rx: null, tx: null }))
  for (const p of series.points) {
    if (!p) continue
    const i = Math.round((p.t - t0) / stepMs)
    if (i < 0 || i >= count) continue
    slots[i] = { t: slots[i].t, rx: p.rx, tx: p.tx }
  }
  return slots
}

/** Contiguous runs of slots that satisfy `keep` (either data or gaps). */
function spans(slots: Slot[], keep: (s: Slot) => boolean) {
  const out: { from: number; to: number }[] = []
  let start = -1
  slots.forEach((s, i) => {
    if (keep(s)) {
      if (start < 0) start = i
    } else if (start >= 0) {
      out.push({ from: start, to: i - 1 })
      start = -1
    }
  })
  if (start >= 0) out.push({ from: start, to: slots.length - 1 })
  return out
}

function niceCeil(v: number): number {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  const m = v / base
  const mult = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return mult * base
}

export function TrafficChart({ series }: { series: TrafficSeries }) {
  const [hover, setHover] = useState<{ i: number; pct: number } | null>(null)
  const slots = useMemo(() => buildSlots(series), [series])
  const n = slots.length
  const historyStart = Math.max(0, Math.min(n, Math.round((PERIOD_SEC[series.period] - series.historySec) / series.stepSec)))

  const peak = slots.reduce((m, s) => Math.max(m, s.rx ?? 0, s.tx ?? 0), 0)
  const hasData = slots.some((s) => s.rx != null)
  // Axis is bytes/s, rounded on a human Mbit/s scale so ticks read cleanly.
  const yMax = niceCeil(peak)

  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W)
  const y = (v: number) => H - Math.min(1, v / yMax) * H

  const path = (pick: (s: Slot) => number | null, area: boolean) =>
    spans(slots, (s) => pick(s) != null)
      .map((r) => {
        const pts: string[] = []
        for (let i = r.from; i <= r.to; i++) {
          const v = pick(slots[i])
          if (v == null) continue
          pts.push(`${pts.length === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
        }
        if (!pts.length) return ''
        return area ? `${pts.join(' ')} L${x(r.to).toFixed(1)} ${H} L${x(r.from).toFixed(1)} ${H} Z` : pts.join(' ')
      })
      .filter(Boolean)
      .join(' ')

  const rxPath = path((s) => s.rx, false)
  const txPath = path((s) => s.tx, false)
  const rxArea = path((s) => s.rx, true)

  /** A slot's band: it owns the half-step on either side of its timestamp. */
  const band = (from: number, to: number) => {
    const left = Math.max(0, from - 0.5)
    const right = Math.min(n - 0.5, to + 0.5)
    return { left: `${(left / (n - 1)) * 100}%`, width: `${((right - left) / (n - 1)) * 100}%` }
  }

  const gaps = spans(slots, (s) => s.rx == null).filter((r) => r.to >= historyStart)
  const historyZone = historyStart > 0 ? band(0, historyStart - 1) : null

  const last = [...slots].reverse().find((s) => s.rx != null)
  const hv = hover ? slots[hover.i] : null
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => Math.round(f * (n - 1)))

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setHover({ i: Math.round(pct * (n - 1)), pct })
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ background: RX }} />
            <span className="text-muted-foreground">Приём</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ background: TX }} />
            <span className="text-muted-foreground">Отдача</span>
          </span>
        </div>
        {last && (
          <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span>
              приём <span className="font-medium text-foreground">{bitrate(last.rx ?? 0)}</span>
            </span>
            <span>
              отдача <span className="font-medium text-foreground">{bitrate(last.tx ?? 0)}</span>
            </span>
            <span className="text-[11.5px]">в {clock(last.t)}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 [--chart-h:150px] sm:[--chart-h:190px]">
        <div className="relative w-14 shrink-0" style={{ height: 'var(--chart-h)' }}>
          {[yMax, yMax / 2, 0].map((v, i) => (
            <span
              key={i}
              className="tabular absolute right-0 text-[10.5px] whitespace-nowrap text-muted-foreground"
              style={{ top: `${(i / 2) * 100}%`, transform: i === 0 ? 'none' : i === 1 ? 'translateY(-50%)' : 'translateY(-100%)' }}
            >
              {bitrate(v)}
            </span>
          ))}
        </div>

        <div
          className="relative min-w-0 flex-1"
          style={{ height: 'var(--chart-h)', touchAction: 'pan-y' }}
          role="img"
          aria-label={`График приёма и отдачи за ${PERIOD_LABEL[series.period]}. Интервалы без данных показаны штриховкой.`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 50, 100].map((t) => (
            <span key={t} className="absolute inset-x-0 h-px bg-border/70" style={{ top: `${t}%` }} />
          ))}
          {[25, 50, 75].map((t) => (
            <span key={`v${t}`} className="absolute inset-y-0 w-px bg-border/40" style={{ left: `${t}%` }} />
          ))}

          {historyZone && (
            <div
              className="hatch absolute inset-y-0 text-muted-foreground/70"
              style={historyZone}
              title="Здесь данных ещё нет: сбор начался позже, чем начинается период"
            >
              <span className="absolute bottom-1 left-1 max-w-full overflow-hidden text-[10px] whitespace-nowrap text-muted-foreground/80">истории ещё нет</span>
            </div>
          )}

          {gaps.map((g, i) => (
            <div
              key={i}
              className="hatch absolute inset-y-0 text-warn/70"
              style={band(g.from, g.to)}
              title={`Пропуск сбора · ${clock(slots[g.from].t)}–${clock(slots[Math.min(n - 1, g.to + 1)].t)}. Значения за этот интервал не восстановлены.`}
            />
          ))}

          {hasData && (
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
              <defs>
                <linearGradient id="rh-rx-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={RX} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={RX} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={rxArea} fill="url(#rh-rx-fill)" />
              <path d={txPath} fill="none" stroke={TX} strokeWidth={1.25} strokeDasharray="3 2.5" vectorEffect="non-scaling-stroke" />
              <path d={rxPath} fill="none" stroke={RX} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
            </svg>
          )}

          {hover && hv && (
            <>
              <span className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25" style={{ left: `${hover.pct * 100}%` }} />
              {hv.rx != null && (
                <span
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
                  style={{ left: `${hover.pct * 100}%`, top: `${(y(hv.rx) / H) * 100}%`, background: RX }}
                />
              )}
              {hv.tx != null && (
                <span
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
                  style={{ left: `${hover.pct * 100}%`, top: `${(y(hv.tx) / H) * 100}%`, background: TX }}
                />
              )}
              <div
                className="material-strong pointer-events-none absolute top-1 z-10 w-max max-w-[190px] rounded-lg px-2.5 py-1.5 text-[11.5px] shadow-float ring-1 ring-border"
                style={{ left: `${Math.max(10, Math.min(90, hover.pct * 100))}%`, transform: hover.pct > 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)' }}
              >
                <div className="tabular mb-0.5 font-medium">{clock(hv.t)}</div>
                {hv.rx == null ? (
                  <div className="text-warn">Пропуск сбора — значения не восстановлены</div>
                ) : (
                  <div className="tabular space-y-0.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Приём</span>
                      <span>{bitrate(hv.rx)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Отдача</span>
                      <span>{bitrate(hv.tx ?? 0)}</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-1 flex gap-2">
        <div className="w-14 shrink-0" />
        <div className="relative h-4 flex-1">
          {ticks.map((i) => (
            <span
              key={i}
              className="tabular absolute text-[10.5px] text-muted-foreground"
              style={{
                left: `${(i / Math.max(1, n - 1)) * 100}%`,
                transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {clock(slots[i].t)}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="hatch inline-block size-3 rounded-sm text-warn/70 ring-1 ring-border" /> пропуск сбора — не интерполируется
        </span>
        {last && <span>последняя выборка в {clock(last.t)}</span>}
      </p>
    </div>
  )
}
