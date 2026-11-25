import { useState } from 'react'
import { ArrowUpRight, Eye, Loader2, Plus, Radar } from 'lucide-react'
import { api } from '@/api'
import type { ConnectionObservation, ObservedConnection } from '@/api/contract'
import { Mono, SimpleSelect, TimeAgo, WriteButton } from '@/components/rh/controls'
import { EmptyState, Notice, Panel } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { deviceName, segmentName } from '@/lib/entities'
import { bytes, count } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCaps, useServerConfig, useTopology } from '@/state/resource'
import { href } from '@/state/router'
import { traceHref } from '@/screens/trace/components'
import { SCENARIO_LABEL } from './meta'
import { isGameIPv4, type PresetSeed } from './preset-editor'

const ALL_DEVICES = '*'

function observedDestination(dst: string) {
  const [destination, rawPort, ...rest] = dst.split(':')
  const port = Number(rawPort)
  return rest.length === 0 && isGameIPv4(destination) && Number.isInteger(port) && port > 0 && port <= 65535
    ? { destination, port }
    : null
}

export function ObservedGameFlows({ onCreate, canCreate }: { onCreate: (preset: PresetSeed) => void; canCreate: boolean }) {
  const { data: caps } = useCaps()
  const { data: config } = useServerConfig()
  const { data: topology } = useTopology()
  const [result, setResult] = useState<ConnectionObservation | null>(null)
  const [selected, setSelected] = useState(ALL_DEVICES)
  const [matchesOnly, setMatchesOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const availability = caps?.liveObservation
  const deviceFilter = caps?.features?.gamePresets?.available === true
  const segments = topology?.segments.filter(({ state, routable }) => state === 'up' && routable.available) ?? []
  const devices = topology?.devices.filter((device) => segments.some(({ id }) => id === device.segmentId)) ?? []
  const shown = result?.rows.filter((connection) =>
    (!matchesOnly || connection.gameMatch) && (selected === ALL_DEVICES || connection.deviceId === selected)) ?? []

  async function observe() {
    if (busy || !availability?.available) return
    setBusy(true)
    setError(null)
    try {
      setResult(await api.observeConnections(10, deviceFilter && selected !== ALL_DEVICES ? selected : undefined))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось получить потоки.')
    } finally {
      setBusy(false)
    }
  }

  function row(connection: ObservedConnection) {
    const device = devices.find(({ id }) => id === connection.deviceId)
    const endpoint = observedDestination(connection.dst)
    const source = device ? { type: 'device' as const, deviceId: device.id }
      : segments.length === 1 ? { type: 'segment' as const, segmentId: segments[0].id } : null
    const trace = endpoint && source ? traceHref('/trace-preview', {
      source, target: endpoint.destination, proto: connection.proto, port: endpoint.port,
    }) : null
    const game = connection.gameMatch
    const outside = connection.proto === 'udp' && caps?.interception.coverage.v4udp.state === 'unsupported'
    return (
      <li key={connection.id} className={cn('space-y-1.5 border-l-2 bg-card px-3 py-2.5 sm:px-3.5', game ? 'border-l-ok/50' : 'border-l-muted-foreground/30')}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Mono className="text-[13px]">{connection.dst}</Mono>
            <span className="text-xs text-muted-foreground">{connection.proto.toUpperCase()}</span>
            {game ? <a href={href('/games-preview', { tab: 'flows', preset: game.presetId })} className="rounded hover:underline">
              <StatusBadge tone="ok">{SCENARIO_LABEL[game.category]} · {game.name}</StatusBadge>
            </a> : <StatusBadge tone="muted">Без совпадения</StatusBadge>}
          </div>
          <span className="text-xs text-muted-foreground">{outside ? 'Вне перехвата RouteHub' : connection.exit ?? 'Выход не проверен'}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <p className="min-w-0 text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
            {device ? deviceName(device, config) : connection.sourceAddress ?? 'Источник неизвестен'}
            {device && connection.sourceAddress && <> · {connection.sourceAddress}</>}
            {connection.redirected && !outside && <> · На входе RouteHub</>}
            {connection.bytes == null ? ' · объём неизвестен' : <> · {bytes(connection.bytes)} за замер</>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {trace && <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={trace} aria-label={`Рассчитать маршрут ${connection.dst}`}>
              Маршрут <ArrowUpRight aria-hidden="true" />
            </a>}
            {canCreate && endpoint && !game && <WriteButton variant="outline" size="sm" aria-label={`Создать пресет для ${connection.dst}`}
              onClick={() => onCreate({ signature: { ...endpoint, protocol: connection.proto, category: 'match' }, deviceId: device?.id })}>
              <Plus aria-hidden="true" /> В пресет
            </WriteButton>}
          </div>
        </div>
      </li>
    )
  }

  return (
    <div className="space-y-2.5">
      <Panel className="space-y-2.5 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[13.5px] font-semibold">Живые соединения</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Откройте игру на выбранном устройстве и запустите замер.</p>
          </div>
          <WriteButton variant="outline" size="sm" disabled={busy || !availability?.available} reason={availability?.reason} onClick={() => void observe()}>
            {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {busy ? 'Наблюдаем…' : 'Наблюдать 10 с'}
          </WriteButton>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SimpleSelect value={selected} aria-label="Устройство для наблюдения" size="sm" disabled={busy}
            options={[
              { value: ALL_DEVICES, label: 'Все устройства' },
              ...devices.map((device) => ({
                value: device.id, label: deviceName(device, config), hint: segmentName(topology, device.segmentId),
              })),
            ]}
            onChange={(value) => { setSelected(value); setResult(null); setError(null) }} />
          {deviceFilter && <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={matchesOnly} onCheckedChange={setMatchesOnly} aria-label="Только совпадения с пресетами" />
            Только совпадения с пресетами
          </label>}
        </div>
        {busy && <p role="status" className="text-xs text-muted-foreground">Собираем TCP и UDP за 10 секунд.</p>}
      </Panel>
      {availability?.available === false && <Notice tone="info" title="Наблюдение недоступно">{availability.reason}</Notice>}
      {error && <div role="alert"><Notice tone="warn" title="Наблюдение не завершилось">{error}</Notice></div>}
      {result && (
        <>
          <p className="text-xs text-muted-foreground">
            {count(shown.length, ['поток', 'потока', 'потоков'])} · {result.seconds} с · <TimeAgo at={result.finishedAt} prefix="замер " />
          </p>
          {result.limited && <Notice tone="warn" title="Показана часть соединений">Достигнут лимит замера.</Notice>}
          {shown.length ? <ul className="divide-y overflow-hidden rounded-xl border border-border" aria-label="Наблюдаемые потоки">
            {shown.map(row)}
          </ul> : <EmptyState icon={<Radar />} title={matchesOnly ? 'Совпадений с пресетами нет' : 'Соединений не найдено'}>
            {matchesOnly ? 'Отключите фильтр, чтобы увидеть остальные потоки замера.' : 'Запустите игру на выбранном устройстве и повторите замер.'}
          </EmptyState>}
        </>
      )}
    </div>
  )
}
