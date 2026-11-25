import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { api } from '@/api'
import type { ApplyPlan, Capabilities, Config, Device, GamePreset, GameSignature, Topology } from '@/api/contract'
import { Mono, SimpleSelect, WriteButton } from '@/components/rh/controls'
import { KV, Notice, Panel } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { deviceName, newId, segmentName } from '@/lib/entities'
import { refetch } from '@/state/resource'
import { href } from '@/state/router'
import { SCENARIO_LABEL } from './meta'

const MAX_NAME = 80
const MAX_SIGNATURES = 32
const MAX_DEVICES = 16
const signaturePort = /^[1-9][0-9]{0,4}$/

interface SignatureField extends Omit<GameSignature, 'port'> {
  key: string
  port: string
}

export interface PresetSeed {
  signature: GameSignature
  deviceId?: string
}

export function isGameIPv4(address: string) {
  const octets = address.split('.')
  if (octets.length !== 4 || !octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)) return false
  const [first, second] = octets.map(Number)
  return first > 0 && first < 224 && first !== 10 && first !== 127 &&
    !(first === 169 && second === 254) && !(first === 192 && second === 168) &&
    !(first === 172 && second >= 16 && second <= 31) && !(first === 100 && second >= 64 && second <= 127)
}

function editableSignature(signature?: GameSignature): SignatureField {
  return {
    key: newId('signature'),
    destination: signature?.destination ?? '',
    protocol: signature?.protocol ?? 'tcp',
    port: signature ? String(signature.port) : '',
    category: signature?.category ?? 'match',
  }
}

function directBlock(device: Device | undefined, config: Config, topology?: Topology): string | undefined {
  if (!device || !topology) return 'Устройство отсутствует в списке Keenetic.'
  const segment = topology.segments.find(({ id }) => id === device.segmentId)
  if (!segment?.routable.available || segment.state !== 'up') return 'Устройство находится вне действующего перехвата.'
  const policy = config.devicePolicies.find(({ deviceId }) => deviceId === device.id)
  if (device.binding !== 'confirmed' || !device.addresses.some(({ confirmed, family, addr }) =>
    confirmed && family === 'v4' && policy?.ipv4Bindings?.includes(addr))) {
    return 'Закрепите IPv4 в Keenetic и подтвердите привязку в политике устройства.'
  }
  if (policy?.mode !== 'local-overrides') return 'Выберите «Унаследовать и дополнить» в политике устройства.'
}

interface Review {
  candidate: Config
  details: ApplyPlan
  remove: boolean
}

export function GamePresetEditor({ preset, seed, config, caps, topology, onClose }: {
  preset?: GamePreset
  seed?: PresetSeed
  config: Config
  caps?: Capabilities
  topology?: Topology
  onClose: () => void
}) {
  const [original] = useState(preset)
  const [id] = useState(() => preset?.id ?? newId('game'))
  const [name, setName] = useState(preset?.name ?? '')
  const [enabled, setEnabled] = useState(preset?.enabled ?? true)
  const [scope, setScope] = useState(preset?.scope.deviceIds ?? (seed?.deviceId ? [seed.deviceId] : []))
  const [action, setAction] = useState<'inherit' | 'direct'>(preset?.routeAction.kind === 'direct' ? 'direct' : 'inherit')
  const [signatures, setSignatures] = useState(() => preset?.signatures?.length
    ? preset.signatures.map(editableSignature)
    : [editableSignature(seed?.signature)])
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clients = topology?.devices ?? []
  const canWrite = caps?.access === 'write' && caps.features?.gamePresets?.available === true
  const clientFor = (id: string) => clients.find((device) => device.id === id)
  const protocolBlock = signatures.some(({ protocol }) => protocol !== 'tcp') ? 'Для UDP доступно наблюдение. Выберите маршрут по политике устройства.' : undefined
  const blockedDevice = scope.map((id) => {
    const device = clientFor(id)
    const reason = directBlock(device, config, topology)
    return reason ? { device, reason } : undefined
  }).find((entry) => entry !== undefined)
  const unavailableDirect = !caps?.gameRouting.routeAtOpen.available ? 'Роутер не заявляет поддержку прямого игрового маршрута.'
    : protocolBlock ?? (scope.length === 0 ? 'Сначала выберите устройства.' : blockedDevice?.reason)
  const clientsAvailable = clients.filter((device) => !scope.includes(device.id) &&
    topology?.segments.some((segment) => segment.id === device.segmentId && segment.state === 'up' && segment.routable.available))
  const hasUnknownClient = scope.some((id) => !clientFor(id) && (enabled || !original?.scope.deviceIds.includes(id)))
  const changed = original
    ? JSON.stringify(config.games.find((item) => item.id === original.id)) !== JSON.stringify(original)
    : false

  function updateSignature(key: string, update: Partial<Omit<SignatureField, 'key'>>) {
    setSignatures((current) => current.map((signature) => signature.key === key ? { ...signature, ...update } : signature))
  }

  function formPreset(): GamePreset {
    const title = name.trim()
    if (!title || title.length > MAX_NAME) throw new Error('Введите название пресета длиной до 80 символов.')
    if (!scope.length || scope.length > MAX_DEVICES || hasUnknownClient) throw new Error('Выберите от 1 до 16 известных устройств.')
    if (enabled && action === 'direct' && unavailableDirect) throw new Error(unavailableDirect)
    const entries = signatures.map(({ destination, port, protocol, category }) => {
      const address = destination.trim()
      if (!isGameIPv4(address) || !signaturePort.test(port) || Number(port) > 65535) {
        throw new Error('Для каждого условия укажите точный внешний IPv4 и порт от 1 до 65535.')
      }
      return { destination: address, protocol, category, port: Number(port) }
    })
    const unique = new Set(entries.map(({ destination, protocol, port }) => `${destination}:${port}/${protocol}`))
    if (!entries.length || entries.length > MAX_SIGNATURES || unique.size !== entries.length) {
      throw new Error('Добавьте от 1 до 32 разных сочетаний IPv4, порта и протокола.')
    }
    return {
      id, name: title, enabled, scope: { segmentIds: [], deviceIds: scope },
      signatures: entries, scenarios: [...new Set(entries.map(({ category }) => category))],
      signatureSources: original?.signatureSources?.length ? original.signatureSources : [seed ? 'Замер Netfilter' : 'Введено вручную'],
      version: original?.version ?? '1', confidence: 'high', families: ['v4'], exclusions: [],
      routeAction: action === 'direct' ? { kind: 'direct', uplinkId: 'isp-main' } : { kind: 'inherit' },
      priority: 'off',
    }
  }

  async function preview(remove = false) {
    if (!canWrite || busy) return
    setError(null)
    if (changed) {
      setError('Этот пресет изменился. Откройте его снова перед сохранением.')
      return
    }
    setBusy(true)
    try {
      const candidate = structuredClone(config)
      if (remove) candidate.games = candidate.games.filter((item) => item.id !== id)
      else {
        const next = formPreset()
        const index = candidate.games.findIndex((item) => item.id === id)
        if (index === -1) candidate.games.push(next)
        else candidate.games[index] = next
      }
      const details = await api.previewApply(candidate, config.revision)
      setReview({ candidate, details, remove })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось проверить игровой пресет.')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!review || !canWrite || busy || review.details.errors.length) return
    setError(null)
    if (review.candidate.revision !== config.revision) {
      setError('Конфигурация изменилась. Вернитесь к форме и проверьте изменения снова.')
      return
    }
    setBusy(true)
    try {
      const result = await api.apply(review.candidate, review.candidate.revision, { mode: 'full' })
      if (!result.ok) throw new Error('Конфигурация изменилась. Вернитесь к форме и проверьте изменения снова.')
      if (result.task.state !== 'done') throw new Error(result.task.error ?? 'Роутер не подтвердил сохранение пресета.')
      await refetch('config')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось применить игровой пресет.')
    } finally {
      setBusy(false)
    }
  }

  if (review) {
    const next = review.candidate.games.find((entry) => entry.id === id)
    return (
      <div className="space-y-3">
        <Notice title={review.remove ? 'Подтвердите удаление пресета' : 'Подтвердите изменения пресета'} tone="info">
          Применение проверяет текущую ревизию и начинает действовать для новых соединений.
        </Notice>
        {next && <Panel className="p-3.5"><KV items={[
          ['Название', next.name],
          ['Устройства', next.scope.deviceIds.map((id) => {
            const device = clientFor(id)
            return device ? deviceName(device, config) : id
          }).join(', ')],
          ['Маршрут', next.routeAction.kind === 'direct' ? 'Прямой для точных совпадений' : 'По политике устройства'],
          ['Условия', <ul className="space-y-0.5">{next.signatures?.map((entry) => (
            <li key={`${entry.destination}:${entry.port}/${entry.protocol}`}>
              <Mono>{entry.destination}:{entry.port}</Mono> · {entry.protocol.toUpperCase()} · {SCENARIO_LABEL[entry.category]}
            </li>
          ))}</ul>],
        ]} /></Panel>}
        {review.details.errors.map((detail, index) => <Notice key={index} title="Проверка конфигурации" tone="bad">{detail}</Notice>)}
        {review.details.warnings.map(({ text, level }, index) => <Notice key={index} title="Проверка конфигурации" tone={level === 'error' ? 'bad' : 'warn'}>{text}</Notice>)}
        {error && <div role="alert"><Notice title="Изменение не применено" tone="bad">{error}</Notice></div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => { setReview(null); setError(null) }}>Вернуться к форме</Button>
          <WriteButton disabled={!canWrite || busy || review.details.errors.length > 0} onClick={() => void apply()}>
            {busy ? 'Применяем…' : review.remove ? 'Подтвердить удаление' : 'Применить пресет'}
          </WriteButton>
        </div>
      </div>
    )
  }

  return (
    <form aria-label="Редактирование игрового пресета" className="space-y-3" onSubmit={(event) => { event.preventDefault(); void preview() }}>
      <Panel className="space-y-3 p-3.5">
        <label className="grid gap-1.5 text-[13px] font-medium">
          Название пресета
          <Input value={name} maxLength={MAX_NAME} onChange={(event) => setName(event.target.value)} placeholder="Название игры или сервера" />
        </label>
        <div className="flex items-center justify-between gap-2 text-[13px]">
          <span>Пресет включён</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canWrite || busy} aria-label="Пресет включён" />
        </div>
      </Panel>

      <Panel className="space-y-2.5 p-3.5">
        <h3 className="text-[13px] font-semibold">Устройства</h3>
        {scope.length > 0 && <ul className="flex flex-wrap gap-1.5">
          {scope.map((id) => {
            const device = clientFor(id)
            const label = device ? deviceName(device, config) : id
            return <li key={id} className="inline-flex items-center gap-1 rounded-full bg-muted py-1 pr-1 pl-2.5 text-xs">
              <span>{label}</span>
              <Button variant="ghost" type="button" size="icon-xs" aria-label={`Убрать «${label}» из пресета`} onClick={() => setScope((current) => current.filter((value) => value !== id))}>
                <X aria-hidden="true" />
              </Button>
            </li>
          })}
        </ul>}
        <SimpleSelect value={null} size="sm" aria-label="Добавить устройство в игровой пресет" placeholder="Добавить устройство"
          disabled={!canWrite || scope.length >= MAX_DEVICES || !clientsAvailable.length}
          options={clientsAvailable.map((device) => ({
            value: device.id, label: deviceName(device, config), hint: segmentName(topology, device.segmentId),
          }))}
          onChange={(id) => setScope((current) => [...current, id])} />
        {!clientsAvailable.length && scope.length === 0 && <p className="text-xs text-muted-foreground">Устройств в сети под управлением RouteHub пока нет.</p>}
      </Panel>

      <Panel className="space-y-3 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">Сигнатуры</h3>
          <Button variant="outline" size="sm" type="button" disabled={signatures.length >= MAX_SIGNATURES || !canWrite} onClick={() => setSignatures((current) => [...current, editableSignature()])}>
            <Plus aria-hidden="true" /> Добавить условие
          </Button>
        </div>
        {signatures.map((entry, index) => (
          <fieldset key={entry.key} className="space-y-2 rounded-lg border border-border p-2.5" disabled={!canWrite || busy}>
            <legend className="px-1 text-xs text-muted-foreground">Условие {index + 1}</legend>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,0.6fr)] gap-2">
              <label className="grid gap-1 text-xs">IPv4 назначения
                <Input inputMode="decimal" value={entry.destination} onChange={(event) => updateSignature(entry.key, { destination: event.target.value })}
                  placeholder="IPv4 сервера" aria-label={`IPv4 назначения, условие ${index + 1}`} />
              </label>
              <label className="grid gap-1 text-xs">Порт
                <Input inputMode="numeric" value={entry.port} onChange={(event) => updateSignature(entry.key, { port: event.target.value })}
                  placeholder="Порт" aria-label={`Порт, условие ${index + 1}`} />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SimpleSelect className="min-w-24" size="sm" value={entry.protocol} aria-label={`Протокол, условие ${index + 1}`}
                options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]}
                onChange={(protocol) => updateSignature(entry.key, { protocol: protocol as GameSignature['protocol'] })} />
              <SimpleSelect className="min-w-24" size="sm" value={entry.category} aria-label={`Сценарий, условие ${index + 1}`}
                options={[{ value: 'match', label: 'Матч' }, { value: 'voice', label: 'Голос' }]}
                onChange={(category) => updateSignature(entry.key, { category: category as GameSignature['category'] })} />
              {signatures.length > 1 && <Button variant="ghost" type="button" size="icon-sm" aria-label={`Удалить условие ${index + 1}`}
                onClick={() => setSignatures((current) => current.filter(({ key }) => key !== entry.key))}><Trash2 aria-hidden="true" /></Button>}
            </div>
          </fieldset>
        ))}
      </Panel>

      <Panel className="space-y-2 p-3.5">
        <h3 className="text-[13px] font-semibold">Маршрут точного совпадения</h3>
        <SimpleSelect value={action} aria-label="Маршрут игрового потока" disabled={!canWrite || busy}
          options={[
            { value: 'inherit', label: 'По политике устройства' },
            { value: 'direct', label: 'Напрямую', disabled: !!unavailableDirect },
          ]}
          onChange={(value) => setAction(value as 'inherit' | 'direct')} />
        {unavailableDirect ? (
          <p className="text-xs text-muted-foreground">{unavailableDirect} {blockedDevice?.device && !protocolBlock && caps?.gameRouting.routeAtOpen.available && (
            <a className="underline underline-offset-2" href={href('/devices-preview', { d: blockedDevice.device.id, tab: 'policy' })}>Открыть политику устройства</a>
          )}</p>
        ) : <p className="text-xs text-muted-foreground">Явные правила маршрутизации и блокировки сохраняют приоритет.</p>}
        <StatusBadge tone="muted">Сетевой приоритет не меняется</StatusBadge>
      </Panel>

      {error && <div role="alert"><Notice title="Проверка пресета" tone="bad">{error}</Notice></div>}
      <div className="flex flex-wrap justify-end gap-2">
        {preset && <WriteButton type="button" variant="ghost" disabled={!canWrite || busy} onClick={() => void preview(true)}>Удалить пресет</WriteButton>}
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Отмена</Button>
        <WriteButton type="submit" disabled={!canWrite || busy}>{busy ? 'Проверяем…' : 'Проверить изменения'}</WriteButton>
      </div>
    </form>
  )
}
