import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/api'
import type { Profile, Subscription, SubscriptionPreview, Task } from '@/api/contract'
import { hasPreviewDetails, subscriptionPreviewFailure } from '@/lib/subscriptions'
import { useDraft } from '@/state/draft'
import { useCanWrite, useRuntime, useServerConfig, useSubscriptionStatus, useTasks } from '@/state/resource'
import { rememberSubscriptionPreview, useSuccessfulPreviews } from '@/state/subscription-previews'
import { hasActiveProfileProbe, probeableProfiles } from '@/screens/exits/shared'
import { profileUnavailable, usePrimaryProfileSwitch } from './usePrimaryProfileSwitch'

interface Preview {
  subscription: Subscription
  result: SubscriptionPreview
}

interface TaskReceipt {
  task: Task
  receivedAt: number
  successVisibleUntil?: number
}

const refreshSuccessDuration = 3000

function isRunning(task?: Task): boolean {
  return task?.state === 'pending' || task?.state === 'running'
}

function latestRefreshTask(receipt: TaskReceipt, tasks?: Task[]): Task {
  const live = tasks?.find(({ id }) => id === receipt.task.id)
  if (!live || (!isRunning(receipt.task) && isRunning(live))) return receipt.task
  return live
}

function successDeadline(task: Task, observedAt: number): number {
  const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : NaN
  return (Number.isFinite(finishedAt) ? Math.min(finishedAt, observedAt) : observedAt) + refreshSuccessDuration
}

export function useVpnProfiles() {
  const draft = useDraft()
  const { data: server, error: configError } = useServerConfig()
  const { data: runtime, error: runtimeError } = useRuntime()
  const { data: subscriptionStatuses, error: subscriptionsError } = useSubscriptionStatus()
  const successfulPreviews = useSuccessfulPreviews()
  const { data: tasks, updatedAt: tasksUpdatedAt } = useTasks()
  const canWrite = useCanWrite()
  const profileSwitch = usePrimaryProfileSwitch(canWrite)

  const profiles = server?.profiles ?? []
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null)
  const [unchangedSubscriptionId, setUnchangedSubscriptionId] = useState<string | null>(null)
  const previewRequest = useRef(0)

  useEffect(() => {
    if (!unchangedSubscriptionId) return
    const timeout = window.setTimeout(() => setUnchangedSubscriptionId(null), 4000)
    return () => window.clearTimeout(timeout)
  }, [unchangedSubscriptionId])

  const operations = useRef(new Map<string, TaskReceipt | null>())
  const [renderedOperations, setRenderedOperations] = useState(operations.current)

  useEffect(() => {
    let timer: number | undefined
    const syncRefreshes = (updateFromFeed: boolean) => {
      const now = Date.now()
      const next = new Map(operations.current)
      let nextDeadline = Infinity
      let changed = false
      for (const [key, receipt] of operations.current) {
        if (!key.startsWith('refresh:') || !receipt) continue
        const task = updateFromFeed ? latestRefreshTask(receipt, tasks) : receipt.task
        const deadline = task.state === 'done' ? receipt.successVisibleUntil ?? successDeadline(task, now) : undefined
        if (deadline !== undefined && deadline <= now) {
          next.delete(key)
          changed = true
          continue
        }
        if (deadline !== undefined) nextDeadline = Math.min(nextDeadline, deadline)
        if (task !== receipt.task || deadline !== receipt.successVisibleUntil) {
          next.set(key, { ...receipt, task, successVisibleUntil: deadline })
          changed = true
        }
      }
      if (changed) {
        operations.current = next
        setRenderedOperations(next)
      }
      // Re-read the current receipts on expiry so a retry cannot lose its card.
      if (Number.isFinite(nextDeadline)) timer = window.setTimeout(() => syncRefreshes(false), Math.max(0, nextDeadline - Date.now()))
    }
    syncRefreshes(true)
    return () => window.clearTimeout(timer)
  }, [renderedOperations, tasks])

  function setOperation(key: string, receipt: TaskReceipt | null | undefined) {
    const next = new Map(operations.current)
    if (receipt === undefined) next.delete(key)
    else next.set(key, receipt)
    operations.current = next
    setRenderedOperations(next)
  }

  function liveTask(receipt?: TaskReceipt | null, refresh = false): Task | undefined {
    if (!receipt) return undefined
    if (refresh) return latestRefreshTask(receipt, tasks)
    const live = tasks?.find((task) => task.id === receipt.task.id)
    if (live) return live
    // The start response bridges the gap until the shared task feed catches up.
    if (tasksUpdatedAt === null || tasksUpdatedAt <= receipt.receivedAt) return receipt.task
  }

  function isBusy(receipt?: TaskReceipt | null, refresh = false): boolean {
    return receipt === null || isRunning(liveTask(receipt, refresh))
  }

  async function startOperation(key: string, run: () => Promise<Task>, errorTitle: string): Promise<boolean> {
    if (isBusy(operations.current.get(key), key.startsWith('refresh:'))) return false
    setOperation(key, null)
    try {
      const task = await run()
      setOperation(key, { task, receivedAt: Date.now() })
      return true
    } catch (e) {
      setOperation(key, undefined)
      toast.error(errorTitle, { description: e instanceof Error ? e.message : String(e) })
      return false
    }
  }

  function unavailableReason(profile: Profile): string | undefined {
    return profileUnavailable(profile, runtime)
  }

  function selectReason(profile: Profile): string | undefined {
    if (profileSwitch.busy) return 'Основной профиль уже переключается'
    return unavailableReason(profile)
  }

  async function probe(id: string) {
    const profile = server?.profiles.find((row) => row.id === id)
    const reason = profile ? unavailableReason(profile) : 'Сначала примените новый профиль'
    if (reason) {
      toast.error(reason)
      return
    }
    await startOperation(`probe:${id}`, () => api.probeProfiles([id]), 'Не удалось проверить профиль')
  }

  const availableForProbe = probeableProfiles(server?.profiles)

  function batchProfiles(subscriptionId?: string) {
    if (!subscriptionId) return availableForProbe
    return availableForProbe.filter(({ origin }) => origin.type === 'subscription' && origin.subscriptionId === subscriptionId)
  }

  async function probeBatch(subscriptionId?: string) {
    const ids = batchProfiles(subscriptionId).map(({ id }) => id)
    if (!ids.length || !canWrite) return
    await startOperation(`probe-batch:${subscriptionId ?? ''}`, () => api.probeProfiles(ids), 'Не удалось запустить проверку профилей')
  }

  async function openSubscriptionPreview(id: string) {
    const subscription = server?.subscriptions.find((item) => item.id === id)
    if (!subscription) {
      toast.error('Сначала примените новую подписку')
      return
    }

    const request = ++previewRequest.current
    setPreviewBusyId(id)
    setUnchangedSubscriptionId((current) => current === id ? null : current)
    const result = await api.previewSubscription(id).catch(() =>
      subscriptionPreviewFailure(id, 'Не удалось получить ответ API панели. Повторите запрос.'))
    if (previewRequest.current !== request) return
    rememberSubscriptionPreview(result)
    const unchanged = result.ok && !result.token && !hasPreviewDetails(result)
    setPreview(unchanged ? null : { subscription, result })
    if (unchanged) setUnchangedSubscriptionId(id)
    setPreviewBusyId(null)
  }

  function closeSubscriptionPreview() {
    previewRequest.current++
    setPreview(null)
    setPreviewBusyId(null)
    setUnchangedSubscriptionId(null)
  }

  async function refreshPreview() {
    if (!canWrite || !preview?.result.ok) return
    const { id } = preview.subscription
    if (!server?.subscriptions.some((item) => item.id === id)) {
      toast.error('Подписка уже недоступна')
      return
    }
    const started = await startOperation(`refresh:${id}`, () => api.refreshSubscription(id, preview.result.token), 'Не удалось обновить подписку')
    if (started) setPreview((current) => (current === preview ? null : current))
  }

  return {
    profiles,
    subscriptions: server?.subscriptions ?? [],
    runtime,
    subscriptionStatuses: subscriptionStatuses ?? [],
    successfulPreviews,
    activeId: server?.primaryProfileId,
    loading: !server && !configError,
    error: configError ?? runtimeError ?? subscriptionsError,
    canWrite,
    outdated: draft.outdated,
    profileSwitch,
    selectReason,
    unavailableReason,
    probe,
    probeBatch,
    batchProfiles,
    batchTask: (subscriptionId?: string) => liveTask(renderedOperations.get(`probe-batch:${subscriptionId ?? ''}`)),
    probing: hasActiveProfileProbe(tasks),
    isProbing: (id: string) => isBusy(renderedOperations.get(`probe:${id}`)),
    preview,
    previewBusyId,
    unchangedSubscriptionId,
    openSubscriptionPreview,
    closeSubscriptionPreview,
    refreshPreview,
    subscriptionTask: (id: string) => liveTask(renderedOperations.get(`refresh:${id}`), true),
    isRefreshing: (id: string) => isBusy(renderedOperations.get(`refresh:${id}`), true),
  }
}
