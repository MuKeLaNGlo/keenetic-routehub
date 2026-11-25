import type { Config, Device, Policy, Topology } from '@/api/contract'

/** Display name: user alias (config) wins over the hostname Keenetic reports. */
export function deviceName(d: Pick<Device, 'id' | 'hostname'>, config?: Pick<Config, 'devicePolicies'>): string {
  return config?.devicePolicies.find((p) => p.deviceId === d.id)?.alias ?? d.hostname
}

export function deviceIp(d: Device, family: 'v4' | 'v6' = 'v4'): string | undefined {
  return d.addresses.find((a) => a.family === family)?.addr
}

export function policyById(config: Config, id: string | null | undefined): Policy | undefined {
  return id ? config.policies.find((p) => p.id === id) : undefined
}

export function segmentName(topo: Topology | undefined, id: string): string {
  return topo?.segments.find((s) => s.id === id)?.name ?? id
}

/** Short random id for new entities. */
export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}
