import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '@/api'
import type { ProfileProbeUpdate, SubscriptionPreview } from '@/api/contract'
import { ProbeBadge } from '@/components/rh/status'
import { WriteButton } from '@/components/rh/controls'

type ProbeItem = ProfileProbeUpdate | { profileId: string; state: 'pending' }

interface PreviewProbes {
  token: string
  items: Record<string, ProbeItem>
  checked: number
  skipped: number
  total: number
  running: boolean
  error?: string
}

export function useSubscriptionPreviewProbes(preview?: SubscriptionPreview) {
  const [results, setResults] = useState<PreviewProbes>()
  const running = useRef<AbortController | null>(null)
  const token = preview?.token

  useEffect(() => () => running.current?.abort(), [token])

  async function probe(ids: string[]) {
    if (running.current || !preview || !token || !ids.length || !api.probeSubscriptionProfiles) return
    const operation = new AbortController()
    running.current = operation
    setResults((current) => ({
      token,
      items: {
        ...(current?.token === token ? current.items : {}),
        ...Object.fromEntries(ids.map((profileId) => [profileId, { profileId, state: 'pending' as const }])),
      },
      checked: 0, skipped: 0, total: ids.length, running: true,
    }))

    try {
      await api.probeSubscriptionProfiles(preview.subscriptionId, token, ids, (update) => {
        if (operation.signal.aborted) return
        setResults((current) => current?.token !== token ? current : ({
          ...current,
          items: { ...current.items, [update.profileId]: update },
          checked: current.checked + Number(update.state === 'done' || update.state === 'error'),
          skipped: current.skipped + Number(update.state === 'skipped'),
        }))
      }, operation.signal)
    } catch (error) {
      if (!operation.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Проверка не выполнена.'
        setResults((current) => current?.token === token ? { ...current, error: message } : current)
      }
    } finally {
      running.current = null
      setResults((current) => current?.token === token ? { ...current, running: false } : current)
    }
  }

  const current = results?.token === token ? results : undefined
  const ids = [...new Set([...(preview?.added.map(({ upstreamKey }) => upstreamKey) ?? []), ...(preview?.changed.map(({ profileId }) => profileId) ?? [])])]
  return {
    available: Boolean(token && api.probeSubscriptionProfiles),
    batchSize: ids.length,
    busy: Boolean(current?.running),
    current,
    probe,
    probeAll: () => probe(ids),
  }
}

type ProbeControls = ReturnType<typeof useSubscriptionPreviewProbes>

export function SubscriptionProbeBatch({ controls, disabled }: { controls: ProbeControls; disabled?: boolean }) {
  if (!controls.available || controls.batchSize === 0) return null
  const progress = controls.current
  return (
    <div className="flex flex-wrap items-center gap-2">
      {controls.batchSize > 1 && (
        <WriteButton variant="outline" size="sm" disabled={disabled || controls.busy} onClick={() => void controls.probeAll()}>
          <RefreshCw aria-hidden="true" className={controls.busy ? 'motion-safe:animate-spin' : undefined} />
          Проверить профили предпросмотра ({controls.batchSize})
        </WriteButton>
      )}
      {progress?.error ? <span role="alert" className="text-[12px] text-bad">{progress.error}</span>
        : progress && <span role="status" className="text-[12px] text-muted-foreground">
          Проверено {progress.checked} из {progress.total}.
          {progress.running && ` Одновременно проверяется: ${Object.values(progress.items).filter(({ state }) => state === 'running').length}.`}
          {progress.skipped > 0 && ` Пропущено: ${progress.skipped}.`}
        </span>}
    </div>
  )
}

export function SubscriptionProbe({ id, name, controls, disabled }: {
  id: string
  name: string
  controls: ProbeControls
  disabled?: boolean
}) {
  if (!controls.available) return null
  const item = controls.current?.items[id]
  const testing = item?.state === 'running'
  const pending = controls.busy && item?.state === 'pending'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <WriteButton
        variant="ghost" size="sm" disabled={controls.busy || disabled}
        aria-label={`Проверить профиль «${name}»`} onClick={() => void controls.probe([id])}
      >
        <RefreshCw aria-hidden="true" className={testing ? 'motion-safe:animate-spin' : undefined} />
        {testing ? 'Проверяем…' : pending ? 'В очереди' : 'Проверить'}
      </WriteButton>
      <span className="text-xs" aria-live="polite">
        {item?.state === 'error' && <span className="text-bad">{item.error}</span>}
        {item?.state === 'skipped' && <span className="text-muted-foreground" title={item.error}>Пропущено</span>}
        {item?.state === 'done' && <span title={item.result.note}><ProbeBadge probe={item.result} compact /></span>}
      </span>
    </div>
  )
}
