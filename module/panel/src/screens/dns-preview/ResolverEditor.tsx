import { useId, useState } from 'react'
import { ArrowDownUp, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Action, DnsPolicy, DnsServer } from '@/api/contract'
import { isDemo } from '@/api/mode'
import { ActionChip, ActionPicker } from '@/components/rh/action'
import { Mono, SimpleSelect } from '@/components/rh/controls'
import { Panel } from '@/components/rh/layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { editableDnsAddress, serverHost, validDnsAddress } from '@/lib/dnsAddress'
import { useDraft } from '@/state/draft'

type Role = 'primary' | 'fallback'
const slots: { role: Role; title: string }[] = [
  { role: 'primary', title: 'Основной сервер' },
  { role: 'fallback', title: 'Резервный сервер' },
]

const protocols: Record<DnsServer['protocol'], { label: string; example: string; hint: string }> = {
  doh: { label: 'DoH (HTTPS)', example: 'https://dns.example/dns-query', hint: 'Введите HTTPS-адрес резолвера.' },
  dot: { label: 'DoT (TLS)', example: 'dns.example:853', hint: 'Введите имя или IP. Порт по умолчанию 853.' },
  udp: { label: 'Обычный DNS (UDP)', example: '9.9.9.9', hint: 'Введите имя или IP. Порт по умолчанию 53.' },
}

function ResolverForm({ server, defaultVia, title, disabled, saving, forcedProtocol, replaceFallback, onCancel, onSave }: {
  server?: DnsServer
  defaultVia: Action
  title: string
  disabled: boolean
  saving: boolean
  forcedProtocol?: DnsServer['protocol']
  replaceFallback?: DnsServer | null
  onCancel: () => void
  onSave: (value: DnsServer, original: DnsServer | undefined, fallbackAddress?: string) => void
}) {
  const id = useId()
  const [original] = useState(server)
  const [protocol, setProtocol] = useState<DnsServer['protocol']>(forcedProtocol ?? original?.protocol ?? 'doh')
  const initialAddress = original ? editableDnsAddress(original.address) : ''
  const [address, setAddress] = useState(initialAddress)
  const [via, setVia] = useState(original?.via ?? defaultVia)
  const [invalid, setInvalid] = useState(false)
  const [fallbackAddress, setFallbackAddress] = useState('')
  const [invalidFallback, setInvalidFallback] = useState(false)
  const meta = protocols[protocol]
  const keepAddress = !!original && !initialAddress && !address.trim() && protocol === original.protocol
  const needsFallbackUpdate = replaceFallback && protocol !== replaceFallback.protocol

  return (
    <form
      aria-label={title}
      className="space-y-3 border-t bg-muted/30 px-3.5 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled) return
        if (!keepAddress && !validDnsAddress(protocol, address)) {
          setInvalid(true)
          return
        }
        if (needsFallbackUpdate && !validDnsAddress(protocol, fallbackAddress)) {
          setInvalidFallback(true)
          return
        }
        onSave({ protocol, address: keepAddress ? original.address : address.trim(), via }, original,
          needsFallbackUpdate ? fallbackAddress.trim() : undefined)
      }}
    >
      <div className="grid min-w-0 gap-2.5 @min-[480px]:grid-cols-[minmax(8.5rem,.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-1 text-xs font-medium">
          <label className="block" htmlFor={`${id}-protocol`}>Протокол</label>
          <SimpleSelect
            id={`${id}-protocol`}
            className="w-full min-w-0 bg-card text-[13px] text-foreground data-[size=default]:h-9"
            value={protocol}
            disabled={disabled || !!forcedProtocol}
            options={Object.entries(protocols).map(([value, item]) => ({ value, label: item.label }))}
            onChange={(value) => {
              setProtocol(value as DnsServer['protocol'])
              setInvalid(false)
            }}
          />
        </div>
        <label className="min-w-0 space-y-1 text-xs font-medium">
          <span className="block">Адрес сервера</span>
          <Input
            className="h-9 bg-card"
            value={address}
            disabled={disabled}
            inputMode={protocol === 'doh' ? 'url' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={meta.example}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => { setAddress(event.target.value); setInvalid(false) }}
          />
          <span id={`${id}-hint`} className={invalid ? 'block font-normal text-bad' : 'block font-normal text-muted-foreground'}>
            {invalid ? meta.hint : keepAddress ? 'Текущий адрес скрыт. Введите новый для замены.' : meta.hint}
          </span>
        </label>
      </div>

      {needsFallbackUpdate && (
        <label className="block space-y-1 text-xs font-medium">
          <span className="block">Адрес резервного сервера</span>
          <Input value={fallbackAddress} disabled={disabled} placeholder={meta.example} aria-invalid={invalidFallback}
            onChange={(event) => { setFallbackAddress(event.target.value); setInvalidFallback(false) }} />
          <span className={invalidFallback ? 'text-bad' : 'font-normal text-muted-foreground'}>
            Для обоих серверов используется один протокол. {invalidFallback ? meta.hint : 'Введите адрес резерва для выбранного протокола.'}
          </span>
        </label>
      )}
      {isDemo && <details className="group">
        <summary className="flex min-h-8 cursor-pointer list-none flex-wrap items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          Маршрут до сервера <ActionChip action={via} /> <ChevronDown className="size-3.5 group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="pt-2"><ActionPicker allow={['keenetic', 'direct', 'vpn']} value={via} onChange={setVia} disabled={disabled} /></div>
      </details>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>Отмена</Button>
        <Button type="submit" size="sm" disabled={disabled || (!keepAddress && !address.trim())}>{saving ? 'Сохраняем…' : 'Сохранить'}</Button>
      </div>
    </form>
  )
}

export function ResolverEditor({ policy, uplinkId, disabled }: { policy: DnsPolicy; uplinkId?: string; disabled: boolean }) {
  const [editing, setEditing] = useState<Role | null>(null)
  const [saving, setSaving] = useState(false)
  const { edit } = useDraft()
  const via = uplinkId ? { kind: 'direct', uplinkId } as const : policy.primary.via

  async function mutate(label: string, update: (target: DnsPolicy) => void) {
    if (disabled || saving) return false
    setSaving(true)
    try {
      return await edit(`DNS «${policy.name}»: ${label}`, (config) => {
        const target = config.dns.find((item) => item.id === policy.id && item.managed)
        if (!target) throw new Error('Эта политика DNS больше недоступна для редактирования.')
        update(target)
      })
    } finally {
      setSaving(false)
    }
  }

  function checkServer(current: DnsServer | null, previous: DnsServer | null) {
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      throw new Error('Настройки DNS-сервера изменились. Откройте их заново.')
    }
  }

  return (
    <Panel className="@container min-w-0 overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-3">
        <h3 className="text-sm font-semibold">DNS-серверы</h3>
        {saving && !editing && <span role="status" className="text-xs text-muted-foreground">Сохраняем…</span>}
        {policy.fallback && (
          <Button type="button" size="sm" variant="outline" disabled={disabled || saving || !!editing} onClick={() => void mutate('изменён порядок серверов', (target) => {
            checkServer(target.primary, policy.primary)
            checkServer(target.fallback, policy.fallback)
            if (!target.fallback) return
            ;[target.primary, target.fallback] = [target.fallback, target.primary]
          })}>
            <ArrowDownUp aria-hidden="true" /> Поменять местами
          </Button>
        )}
      </div>

      <ol className="divide-y divide-border">
        {slots.map(({ role, title }, index) => {
          const resolver = policy[role]
          return (
            <li key={role} className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 px-3.5 py-3">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs text-muted-foreground">{index + 1}</span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="text-xs font-semibold">{title}</h4>
                      {resolver && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{protocols[resolver.protocol].label}</span>}
                    </div>
                    {resolver ? (
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Mono className="text-xs [overflow-wrap:anywhere]">{serverHost(resolver.address)}</Mono>
                        <ActionChip action={resolver.via} />
                      </div>
                    ) : <p className="text-xs text-muted-foreground">Не настроен</p>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size={resolver ? 'icon-sm' : 'sm'}
                    disabled={disabled || saving || !!editing}
                    aria-label={resolver ? `Изменить ${title.toLowerCase()}` : 'Добавить резервный сервер'}
                    onClick={() => setEditing(role)}
                  >
                    {resolver ? <Pencil aria-hidden="true" /> : <><Plus aria-hidden="true" /> Добавить</>}
                  </Button>
                  {role === 'fallback' && resolver && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Удалить резервный сервер"
                      disabled={disabled || saving || !!editing}
                      onClick={() => void mutate('удалён резервный сервер', (target) => {
                        checkServer(target.fallback, resolver)
                        target.fallback = null
                        target.fallbackDirectAllowed = false
                      })}
                    ><Trash2 aria-hidden="true" /></Button>
                  )}
                </div>
              </div>

              {editing === role && (
                <ResolverForm
                  server={resolver ?? undefined}
                  defaultVia={via}
                  title={title}
                  disabled={disabled || saving}
                  saving={saving}
                  forcedProtocol={!isDemo && role === 'fallback' ? policy.primary.protocol : undefined}
                  replaceFallback={!isDemo && role === 'primary' ? policy.fallback : null}
                  onCancel={() => setEditing(null)}
                  onSave={async (next, original, fallbackAddress) => {
                    if (await mutate(`изменён ${title.toLowerCase()}`, (target) => {
                      checkServer(target[role], original ?? null)
                      target[role] = next
                      if (fallbackAddress !== undefined && target.fallback) {
                        checkServer(target.fallback, policy.fallback)
                        target.fallback = { ...target.fallback, protocol: next.protocol, address: fallbackAddress }
                      }
                    })) setEditing(null)
                  }}
                />
              )}
            </li>
          )
        })}
      </ol>
    </Panel>
  )
}
