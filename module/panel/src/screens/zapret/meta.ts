import type { Config, Segment, ZapretServiceId, ZapretStrategy } from '@/api/contract'
import type { Tone } from '@/components/rh/status'

/** What each service is and which host its check stands for. */
export const ZAPRET_META: Record<ZapretServiceId, { name: string; host: string; about: string }> = {
  youtube: { name: 'YouTube', host: 'youtube.com', about: 'Страница, выдача видео и комментарии. Голосовых вызовов у сервиса нет.' },
  discord: { name: 'Discord', host: 'discord.com', about: 'Веб-клиент, Gateway WebSocket; голос — отдельным статусом.' },
}

export const READINESS: Record<ZapretStrategy['readiness'], { label: string; hint: string; tone: Tone }> = {
  ready: { label: 'Готова', hint: 'Зависимости на месте', tone: 'ok' },
  experimental: { label: 'Экспериментальная', hint: 'Работает не на всех путях: результат нужно проверять отдельно', tone: 'warn' },
  'needs-kernel-module': { label: 'Нужен модуль ядра', hint: 'Без модуля ядра стратегия не запустится', tone: 'bad' },
}

/** Segments RouteHub can steer at all (excluded segments are never touched). */
export function managedSegments(config: Config, segments: Segment[]): Segment[] {
  return segments.filter((s) => s.state !== 'removed' && config.segmentPolicies.find((p) => p.segmentId === s.id)?.mode !== 'excluded')
}

/** Human summary of a service's scope; empty `ids` means every managed segment. */
export function scopeLabel(segments: Segment[], ids: string[]): string {
  if (ids.length === 0) return 'Все управляемые сети'
  return ids.map((id) => segments.find((s) => s.id === id)?.name ?? `сеть ${id} (нет в Keenetic)`).join(', ')
}

export const PROTO_LABEL = { tcp: 'TCP', udp: 'UDP' } as const
