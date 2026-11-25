import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { api } from '@/api'
import type { ActiveVpnHealth } from '@/api/contract'
import { isDemo } from '@/api/mode'
import { useCanWrite, useCaps, useRuntime } from '@/state/resource'
import { SimpleSelect } from '@/components/rh/controls'
import { StatusBadge, type Tone } from '@/components/rh/status'
import { dateTime } from '@/lib/format'
import { BeaconMascot } from './BeaconMascot'
import { VpnMascotScene } from './VpnMascotScene'
import { useVpnDemo, type VpnPhase, type VpnScenario } from './vpn-demo'
import './vpn-control.css'

const stateCopy: Record<VpnPhase, { label: string; action?: string; hint?: string }> = {
  off: { label: 'Подключить VPN' },
  connecting: { label: 'Подключение…', action: 'Отменить подключение' },
  success: { label: 'Подключено', action: 'Отключить VPN' },
  connected: { label: 'Подключено', action: 'Отключить VPN' },
  disconnecting: { label: 'Отключение…' },
  disconnected: { label: 'Отключено', action: 'Подключить VPN' },
  'connect-error': { label: 'Не удалось подключиться', action: 'Повторить подключение' },
  'disconnect-error': { label: 'Ошибка отключения', action: 'Повторить отключение', hint: 'Туннель остаётся активным' },
  canceled: { label: 'Подключение отменено', action: 'Подключить VPN' },
  reconnecting: { label: 'Восстановление…', action: 'Отменить восстановление', hint: 'Соединение прервалось' },
  'connection-lost': { label: 'Связь потеряна', action: 'Подключить снова', hint: 'Нет связи с выходом VPN' },
}

const scenarios: { value: VpnScenario; label: string }[] = [
  { value: 'normal', label: 'Обычное соединение' },
  { value: 'connect-error', label: 'Отказ подключения' },
  { value: 'timeout', label: 'Тайм-аут подключения' },
  { value: 'disconnect-error', label: 'Отказ отключения' },
  { value: 'recover', label: 'Обрыв с восстановлением' },
  { value: 'drop', label: 'Обрыв без восстановления' },
]

function Control({
  phase, busy, toggle, hint, label, action, children,
}: {
  phase: VpnPhase
  busy: boolean
  toggle: () => void
  hint?: string
  label?: string
  action?: string
  children?: ReactNode
}) {
  const hintId = useId()
  const state = stateCopy[phase]
  const text = label ?? state.label
  const actionText = action ?? state.action
  return (
    <section className="vpn-control" data-phase={phase} aria-label={isDemo ? 'Демонстрация управления VPN' : 'Управление VPN'}>
      <button
        type="button"
        className="vpn-control__toggle"
        aria-label={actionText ? `${text} — ${actionText}` : undefined}
        aria-describedby={hint ? hintId : undefined}
        aria-disabled={busy || undefined}
        title={actionText}
        disabled={busy}
        onClick={toggle}
      >
        <span className="vpn-control__stage">
          <VpnMascotScene><BeaconMascot /></VpnMascotScene>
        </span>
        <span className="vpn-control__footer">
          <span className="vpn-control__status-line">
            <span className="vpn-control__status-label">
              <span className="vpn-control__status-dot" aria-hidden="true" />
              <span className="vpn-control__title">{text}</span>
            </span>
            {isDemo && <span className="vpn-control__demo" aria-hidden="true">Демо</span>}
          </span>
        </span>
      </button>
      {hint && <span id={hintId} className="vpn-control__hint">{hint}</span>}
      <span className="sr-only" role="status">{text}{hint ? ` ${hint}` : ''}</span>
      {children}
    </section>
  )
}

function DemoControl() {
  const { phase, scenario, setScenario, toggle, failureReason } = useVpnDemo()
  const scenarioId = useId()
  const busy = phase === 'disconnecting'
  const canCancel = phase === 'connecting' || phase === 'reconnecting'
  const hint = phase === 'connect-error'
    ? failureReason === 'timeout' ? 'Время ожидания истекло' : 'Профиль VPN отклонил подключение'
    : stateCopy[phase].hint
  return (
    <Control phase={phase} busy={busy} toggle={toggle} hint={hint}>
      <details className="vpn-control__scenarios">
        <summary>Сценарии VPN <ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="vpn-control__scenario-options">
          <div className="vpn-control__scenario-field">
            <label htmlFor={scenarioId}>Сценарий VPN</label>
            <SimpleSelect
              id={scenarioId}
              className="w-full min-w-0 bg-card text-[13px] text-foreground data-[size=default]:h-9"
              value={scenario}
              disabled={busy || canCancel}
              options={scenarios}
              onChange={(value) => setScenario(value as VpnScenario)}
            />
          </div>
        </div>
      </details>
    </Control>
  )
}

const healthStates: Record<ActiveVpnHealth['status'], { label: string; tone: Tone }> = {
  verified: { label: 'HTTPS подтверждён', tone: 'ok' },
  failed: { label: 'Ошибка HTTPS', tone: 'bad' },
  unverified: { label: 'Ответ не подтверждён', tone: 'warn' },
  unavailable: { label: 'Проверка недоступна', tone: 'muted' },
}

function ActiveVpnCheck({ health, staleRuntime }: { health?: ActiveVpnHealth; staleRuntime: boolean }) {
  const [currentTime, setCurrentTime] = useState(Date.now)
  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 15_000)
    return () => window.clearInterval(interval)
  }, [])

  const checkedAt = health ? Date.parse(health.checkedAt) : NaN
  const validDate = Number.isFinite(checkedAt)
  const expired = !validDate || currentTime - checkedAt > 6 * 60 * 1000
  const stale = staleRuntime || (health !== undefined && expired)
  const status = health ? healthStates[health.status] : undefined
  const verifiedMs = health?.status === 'verified' && health.latencyMs != null &&
    Number.isFinite(health.latencyMs) && health.latencyMs >= 0 ? Math.round(health.latencyMs) : null

  return (
    <section aria-label="HTTPS через активный туннель" className="mx-auto mt-1 max-w-[450px] rounded-xl border border-border bg-card px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="font-medium">HTTPS через активный туннель</span>
        <span role="status" className="flex flex-wrap items-center gap-1.5">
          {stale ? <StatusBadge tone="warn">Замер устарел</StatusBadge>
            : status ? <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              : <StatusBadge tone="muted">Ожидаем замер</StatusBadge>}
          {!stale && verifiedMs !== null && <span className="font-medium tabular">{verifiedMs} мс</span>}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {validDate && <><time dateTime={new Date(checkedAt).toISOString()} className="tabular">{dateTime(checkedAt)}</time> · </>}
        Каждые 5 минут и после переключения
      </p>
      {health?.message && health.status !== 'verified' && !stale && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{health.message}</p>
      )}
    </section>
  )
}

function LiveControl() {
  const runtime = useRuntime()
  const { data: caps } = useCaps()
  const canWrite = useCanWrite()
  const [pending, setPending] = useState<boolean | null>(null)
  const [failure, setFailure] = useState<{ desired: boolean; info: string } | null>(null)
  const [changed, setChanged] = useState<boolean | null>(null)
  const vpn = runtime.data?.vpn
  useEffect(() => {
    if (changed === null) return
    const timeout = window.setTimeout(() => setChanged(null), 900)
    return () => window.clearTimeout(timeout)
  }, [changed])
  const toggle = () => {
    if (pending !== null || !canWrite || !vpn?.available || !api.setVpnEnabled || runtime.error) return
    const desired = !vpn.enabled
    setPending(desired)
    setFailure(null)
    setChanged(null)
    void api.setVpnEnabled(desired).then(() => {
      setChanged(desired)
      return runtime.refetch()
    }).catch((error: unknown) => {
      setFailure({ desired, info: error instanceof Error ? error.message : 'Состояние VPN не изменилось.' })
      void runtime.refetch()
    }).finally(() => setPending(null))
  }
  const phase: VpnPhase = pending !== null ? pending ? 'connecting' : 'disconnecting'
    : failure ? failure.desired ? 'connect-error' : 'disconnect-error'
      : changed === true ? 'success' : changed === false ? 'disconnected' : vpn?.enabled ? 'connected' : 'off'
  const busy = pending !== null || !vpn?.available || !canWrite || Boolean(runtime.error)
  const hint = (runtime.error || failure?.info) ?? (vpn && !vpn.available ? 'Добавьте профиль в разделе «Выходы VPN».' : undefined)
  const label = !vpn ? (runtime.error ? 'Статус VPN недоступен' : 'Читаем статус VPN…')
    : phase === 'connected' || phase === 'success' ? 'VPN включён' : undefined
  const healthAvailable = Boolean(vpn?.health || caps?.features?.activeVpnHealth?.available)
  return (
    <Control phase={phase} busy={busy} toggle={toggle} hint={hint} label={label} action={pending !== null ? '' : undefined}>
      {vpn?.enabled && pending === null && healthAvailable && <ActiveVpnCheck health={vpn.health} staleRuntime={Boolean(runtime.error)} />}
    </Control>
  )
}

export function VpnControl() {
  return isDemo ? <DemoControl /> : <LiveControl />
}
