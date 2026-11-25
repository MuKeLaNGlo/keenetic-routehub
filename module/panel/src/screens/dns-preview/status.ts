import type { DnsPolicy, ProbeResult, Runtime } from '@/api/contract'
import type { Tone } from '@/components/rh/status'
import { serverHost } from '@/screens/dns/server-meta'

interface ResolverStatus {
  tone: Tone
  label: string
  address?: string
}

function failed(probe?: ProbeResult | null): boolean {
  return probe?.state === 'down' || probe?.state === 'incompatible' || probe?.state === 'missing' || probe?.state === 'disabled'
}

export function resolverStatus(applied: DnsPolicy | undefined, runtime: Runtime | undefined, hasConfig: boolean): ResolverStatus {
  if (!applied) return { tone: 'muted', label: hasConfig ? 'Ещё не применена' : 'Нет данных об активной политике' }
  if (!applied.managed) return { tone: 'muted', label: 'Штатный DNS Keenetic' }
  if (!runtime) return { tone: 'muted', label: 'Текущий статус недоступен' }

  const service = runtime.services.dns.state
  if (service === 'failed') return { tone: 'bad', label: 'Сбой службы DNS' }
  if (service === 'stopped') return { tone: 'muted', label: 'Служба DNS остановлена' }
  if (service === 'not-installed') return { tone: 'muted', label: 'Служба DNS не установлена' }

  const current = runtime.dns[applied.id]
  if (!current) return { tone: 'muted', label: 'Нет проверки' }
  if (current.active === 'unknown') return { tone: 'muted', label: 'Активный DNS не подтверждён' }
  if (current.active === 'none') {
    return failed(current.primary)
      ? { tone: 'bad', label: applied.fallback ? 'Основной недоступен, резерв не выбран' : 'Основной недоступен, резерва нет' }
      : { tone: 'muted', label: 'Резолвер не подтверждён' }
  }

  const server = current.active === 'primary' ? applied.primary : applied.fallback
  if (!server) return { tone: 'warn', label: 'Нет данных о резерве' }

  const probe = current[current.active]
  const label = current.active === 'primary' ? 'Основной' : 'Резервный'
  const address = serverHost(server.address)
  if (failed(probe)) return { tone: 'bad', label: `${label} недоступен`, address }
  if (probe?.state === 'ok') return { tone: current.active === 'primary' ? 'ok' : 'warn', label: `${label} отвечает`, address }
  if (probe?.state === 'degraded') return { tone: 'warn', label: `${label} работает с перебоями`, address }
  if (probe?.state === 'stale') return { tone: 'warn', label: 'Проверка устарела', address }
  return { tone: 'muted', label: `${label} выбран, не проверен`, address }
}
