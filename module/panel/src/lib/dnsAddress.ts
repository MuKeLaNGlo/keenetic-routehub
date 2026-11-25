import type { DnsServer } from '@/api/contract'

const URL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i

export function serverHost(address: string): string {
  const value = address.trim()
  if (URL_PREFIX.test(value)) {
    try {
      return new URL(value, 'https://localhost').host || '—'
    } catch {
      return '—'
    }
  }
  return value.split(/[/?#\\]/, 1)[0].split('@').at(-1) || '—'
}

/** An authenticated or tokenized endpoint must be replaced explicitly. */
export function editableDnsAddress(address: string): string {
  if (/[@?#]/.test(address)) return ''
  if (!/^https:\/\//i.test(address)) return address
  try {
    const { pathname } = new URL(address)
    return pathname === '/' || pathname === '/dns-query' ? address : ''
  } catch {
    return ''
  }
}

export function validDnsAddress(protocol: DnsServer['protocol'], address: string): boolean {
  const value = address.trim()
  if (!value || /\s/.test(value)) return false

  try {
    if (protocol === 'doh') {
      if (!/^https:\/\//i.test(value) || /[\\#]/.test(value)) return false
      const url = new URL(value)
      return !!url.hostname && !url.username && !url.password && url.port !== '0'
    }

    const endpoint = protocol === 'dot' ? value.replace(/^tls:\/\//i, '') : value
    if (/[/?#@\\]/.test(endpoint) || endpoint.endsWith(':') && !endpoint.endsWith('::')) return false
    const bareIpv6 = !endpoint.startsWith('[') && endpoint.indexOf(':') !== endpoint.lastIndexOf(':')
    const url = new URL(`http://${bareIpv6 ? `[${endpoint}]` : endpoint}`)
    if (!url.hostname || url.port === '0') return false
    if (url.hostname.startsWith('[')) return true
    const labels = url.hostname.replace(/\.$/, '').split('.')
    return labels.every((label) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label) && label.length <= 63)
  } catch {
    return false
  }
}
