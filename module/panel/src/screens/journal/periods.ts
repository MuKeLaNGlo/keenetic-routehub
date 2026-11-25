import type { TrafficPeriod } from '@/api/contract'

export const PERIOD_SEC: Record<TrafficPeriod, number> = { '5m': 300, '15m': 900, '1h': 3600 }
export const PERIOD_LABEL: Record<TrafficPeriod, string> = { '5m': '5 мин', '15m': '15 мин', '1h': '1 ч' }

export const PERIOD_OPTIONS: { value: TrafficPeriod; label: string }[] = [
  { value: '5m', label: '5 мин' },
  { value: '15m', label: '15 мин' },
  { value: '1h', label: '1 ч' },
]

export function periodOf(v: string | null): TrafficPeriod {
  return v === '15m' || v === '1h' ? v : '5m'
}
