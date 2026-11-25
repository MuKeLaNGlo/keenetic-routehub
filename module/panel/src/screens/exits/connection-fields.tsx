import type { VpnProtocol } from '@/api/contract'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SimpleSelect } from '@/components/rh/controls'
import { useState } from 'react'
import { PROTOCOL_LABEL } from '@/lib/labels'

const transportProtocols = ['vless', 'hysteria2', 'trojan', 'awg'] as const
const peerFields = new Set(['allowedips', 'presharedkey', 'persistentkeepalive'])
const reservedFields = new Set(['privatekey', 'publickey', 'endpoint', 'address'])

function serverHost(value: string) {
  const host = value.trim()
  if (/[/@?#\s]/.test(host) || !host) throw new Error('Укажите имя сервера или IP-адрес.')
  try {
    if (host.includes(':') && !host.startsWith('[')) return new URL(`https://[${host}]`).hostname
    const parsed = new URL(`https://${host}`)
    if (parsed.port || (host.includes(':') && !host.endsWith(']'))) throw new Error()
    return parsed.hostname
  } catch {
    throw new Error('Укажите имя сервера или IP-адрес без порта.')
  }
}

export function ConnectionFields({ protocol, prefix, disabled }: { protocol?: VpnProtocol; prefix: string; disabled: boolean }) {
  const [type, setType] = useState<VpnProtocol>(protocol ?? 'vless')
  const [native, setNative] = useState(false)
  const selected = protocol ?? type
  const awg = selected === 'awg'
  return (
    <fieldset disabled={disabled} className="grid gap-2.5 sm:grid-cols-2">
      <input type="hidden" name={`${prefix}-protocol`} value={selected} />
      {!protocol && (
        <div className="space-y-1 text-xs font-medium">
          <span>Протокол</span>
          <SimpleSelect value={selected} aria-label="Протокол" disabled={disabled}
            options={transportProtocols.map((value) => ({ value, label: PROTOCOL_LABEL[value] }))}
            onChange={(value) => setType(value as VpnProtocol)} />
        </div>
      )}
      {awg && (
        <div className="space-y-1 text-xs font-medium">
          <span>Способ подключения</span>
          <SimpleSelect value={native ? 'native' : 'managed'} aria-label="Способ подключения AWG" disabled={disabled}
            options={[{ value: 'managed', label: 'AmneziaWG в RouteHub' }, { value: 'native', label: 'Интерфейс WireGuard ASC' }]}
            onChange={(value) => setNative(value === 'native')} />
        </div>
      )}
      {awg && native ? (
        <label className="space-y-1 text-xs font-medium sm:col-span-2">
          <span>Имя интерфейса Keenetic</span>
          <Input name={`${prefix}-interface`} placeholder="nwg0" maxLength={15} autoComplete="off" />
        </label>
      ) : (
        <>
          <label className="space-y-1 text-xs font-medium">
            <span>Сервер</span><Input name={`${prefix}-host`} placeholder="vpn.example.com" autoComplete="off" spellCheck={false} />
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>Порт</span><Input key={String(awg)} name={`${prefix}-port`} type="number" min={1} max={65535} defaultValue={awg ? 51820 : 443} />
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>{awg ? 'Приватный ключ клиента' : selected === 'vless' ? 'UUID' : 'Пароль'}</span>
            <Input name={`${prefix}-secret`} type="password" autoComplete="new-password" />
          </label>
          {awg ? <>
            <label className="space-y-1 text-xs font-medium">
              <span>Публичный ключ сервера</span><Input name={`${prefix}-peer`} autoComplete="off" spellCheck={false} />
            </label>
            <label className="space-y-1 text-xs font-medium">
              <span>Адрес клиента</span><Input name={`${prefix}-address`} placeholder="10.8.0.2/32" autoComplete="off" />
            </label>
          </> : (
            <label className="space-y-1 text-xs font-medium">
              <span>SNI</span><Input name={`${prefix}-sni`} placeholder="vpn.example.com" autoComplete="off" />
            </label>
          )}
          <label className="space-y-1 text-xs font-medium sm:col-span-2">
            <span>{awg ? 'Обфускация и дополнительные параметры AWG' : 'Транспорт и параметры TLS'}</span>
            <Textarea name={`${prefix}-params`} rows={awg ? 4 : 2} placeholder={awg ? 'AllowedIPs = 0.0.0.0/0' : 'security=tls&type=tcp'} spellCheck={false} />
          </label>
        </>
      )}
    </fieldset>
  )
}

export function readConnection(form: HTMLFormElement, prefix: string): { text: string; interface?: string } {
  const data = new FormData(form)
  const field = (key: string) => String(data.get(`${prefix}-${key}`) ?? '')
  const protocol = field('protocol')
  const iface = field('interface').trim()
  if (protocol === 'awg' && data.has(`${prefix}-interface`)) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$/.test(iface)) throw new Error('Укажите имя интерфейса WireGuard ASC.')
    return { text: '', interface: iface }
  }
  const port = Number(field('port'))
  const secret = field('secret')
  if (!secret || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Укажите сервер, порт и данные подключения.')
  const host = serverHost(field('host'))
  if (protocol === 'awg') {
    const peer = field('peer').trim()
    const address = field('address').trim()
    if (!/^[a-z0-9+/]{43}=$/i.test(secret) || !/^[a-z0-9+/]{43}=$/i.test(peer) || !address ||
        address.includes('\n') || address.includes('\r') || address.includes(String.fromCharCode(0))) {
      throw new Error('Укажите оба ключа AmneziaWG и адрес клиента.')
    }
    const intf = ['[Interface]', `PrivateKey = ${secret}`, `Address = ${address}`]
    const remote = ['[Peer]', `PublicKey = ${peer}`, `Endpoint = ${host}:${port}`]
    for (const row of field('params').split(/\r?\n/)) {
      const value = row.trim()
      if (!value || /^[#;]/.test(value)) continue
      const key = value.match(/^([a-z0-9]+)\s*=\s*\S/i)?.[1].toLowerCase()
      if (!key || reservedFields.has(key)) throw new Error('Проверьте дополнительные параметры. Используйте строки «ключ = значение».')
      const section = peerFields.has(key) ? remote : intf
      section.push(value)
    }
    if (!remote.some((line) => /^allowedips\s*=/i.test(line))) remote.push('AllowedIPs = 0.0.0.0/0, ::/0')
    return { text: [...intf, '', ...remote].join('\n') }
  }
  const params = new URLSearchParams(field('params').trim().replace(/^\?/, ''))
  const sni = field('sni').trim()
  if (sni) params.set('sni', serverHost(sni))
  if (protocol === 'vless' && !params.has('encryption')) params.set('encryption', 'none')
  return { text: `${protocol}://${encodeURIComponent(secret)}@${host}:${port}${params.size ? `?${params}` : ''}` }
}
