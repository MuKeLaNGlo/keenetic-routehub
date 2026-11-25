import type { ClassifiedFlow, GamePreset } from '@/api/contract'
import type { Tone } from '@/components/rh/status'

export const CATEGORY_LABEL: Record<ClassifiedFlow['category'], string> = {
  match: 'Матч',
  voice: 'Голос',
  update: 'Обновление игры',
  login: 'Вход в аккаунт',
  download: 'Загрузка',
  launcher: 'Лаунчер',
  unknown: 'Не распознано',
}

export const SCENARIO_LABEL: Record<GamePreset['scenarios'][number], string> = {
  match: 'Матч',
  voice: 'Голос',
  update: 'Обновление',
  login: 'Вход в аккаунт',
  download: 'Загрузки',
  launcher: 'Лаунчер',
}

export const CONFIDENCE: Record<ClassifiedFlow['confidence'], { label: string; tone: Tone }> = {
  high: { label: 'Высокое подтверждение', tone: 'ok' },
  medium: { label: 'Среднее подтверждение', tone: 'muted' },
  low: { label: 'Низкое подтверждение', tone: 'warn' },
  none: { label: 'Нет классификации', tone: 'muted' },
}

export const PRIORITY: Record<GamePreset['priority'], { label: string; hint: string }> = {
  off: { label: 'Выкл', hint: 'Приоритет не меняется' },
  intelliqos: { label: 'IntelliQoS', hint: 'Штатный приоритет по категории «Игры» — в собственной области действия' },
  strict: { label: 'Строгий', hint: 'Строгий приоритет только этого потока' },
}

/**
 * Which of the spec's four situations a live flow is.
 *
 * The router reports the reason in `route`/`note` only, so the split uses the
 * flow's own facts: when the signal arrived, whether it was classified at all,
 * and whether the scenario is one the classifier may steer (match/voice) or one
 * that belongs to the device's policy (login, update, downloads, launcher).
 */
export type FlowKind = 'routed' | 'late' | 'explicit' | 'policy' | 'unknown'

export function flowKind(f: ClassifiedFlow): FlowKind {
  if (f.detectedAt === 'late') return 'late'
  if (f.confidence === 'none' || f.category === 'unknown') return 'unknown'
  if (f.category === 'match' || f.category === 'voice') return 'routed'
  return f.route.startsWith('VPN') ? 'explicit' : 'policy'
}

export const FLOW_KIND: Record<FlowKind, { label: string; hint: string; tone: Tone; border: string; dashed?: boolean }> = {
  routed: {
    label: 'Маршрут потока',
    hint: 'Классификация была известна при открытии: маршрут применён к этому соединению. Остальной трафик устройства не тронут.',
    tone: 'ok',
    border: 'border-l-ok/50',
  },
  late: {
    label: 'Только приоритет',
    hint: 'Сигнал появился после открытия: маршрут уже открытого потока не меняется, доступны приоритет и диагностика.',
    tone: 'warn',
    border: 'border-l-warn',
  },
  explicit: {
    label: 'Решает явное правило',
    hint: 'Явное VPN- или блок-правило политики важнее игрового сигнала.',
    tone: 'info',
    border: 'border-l-info',
  },
  policy: {
    label: 'По политике устройства',
    hint: 'Этот сценарий не входит в автоматику и идёт по штатной политике.',
    tone: 'muted',
    border: 'border-l-border',
  },
  unknown: {
    label: 'Не распознано',
    hint: 'Общий UDP, один порт или адрес большого CDN сами по себе не дают права на переключение.',
    tone: 'muted',
    border: 'border-l-muted-foreground/30',
    dashed: true,
  },
}

/** `host:port` as reported by the router → the host to trace. */
export const flowHost = (dst: string) => dst.replace(/:\d+$/, '')
