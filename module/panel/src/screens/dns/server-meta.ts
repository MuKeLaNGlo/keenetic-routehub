import type { DnsServer, ProbeResult } from '@/api/contract'
export { serverHost } from '@/lib/dnsAddress'

export const PROTOCOL: Record<DnsServer['protocol'], string> = {
  udp: 'DNS · UDP 53',
  doh: 'DoH · HTTPS',
  dot: 'DoT · TLS 853',
}

const FAIL_STAGE: Record<NonNullable<ProbeResult['failStage']>, string> = {
  dns: 'имя сервера не разрешилось',
  connect: 'соединение не установилось',
  tls: 'TLS-рукопожатие не завершилось',
  response: 'сервер не ответил',
  timeout: 'истёк таймаут',
}

export const failStageText = (probe: ProbeResult | null | undefined) => (probe?.failStage ? FAIL_STAGE[probe.failStage] : 'проба не прошла')
