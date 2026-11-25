import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown, CloudDownload, Plus, RefreshCw, Settings2, ShieldAlert } from 'lucide-react'
import type { Subscription, SubscriptionInput, SubscriptionPreview, SubscriptionStatus } from '@/api/contract'
import { api } from '@/api'
import { useDraft } from '@/state/draft'
import { useSubscriptionStatus, useTasks } from '@/state/resource'
import { forgetSubscriptionPreview, rememberSubscriptionPreview, useSuccessfulPreviews } from '@/state/subscription-previews'
import { href } from '@/state/router'
import { EmptyState, KV, Notice, Panel, Section } from '@/components/rh/layout'
import { StatusBadge, StatusDot, type Tone } from '@/components/rh/status'
import { Mono, TimeAgo, WriteButton } from '@/components/rh/controls'
import { Modal } from '@/components/rh/sheet'
import { Button, buttonVariants } from '@/components/ui/button'
import { count } from '@/lib/format'
import { xrayGroupDescription } from '@/lib/labels'
import { hasPreviewDetails, hasSubscriptionChanges, subscriptionCatalogLabel, subscriptionPreviewFailure, subscriptionProfiles } from '@/lib/subscriptions'
import { hasActiveProfileProbe, probeableProfiles, startOperation, TaskById } from './shared'
import { SubscriptionEditor } from './subscription-editor'
import { SubscriptionProbe, SubscriptionProbeBatch, useSubscriptionPreviewProbes } from './subscription-probe'
import { SubscriptionAttemptError, SubscriptionPreviewError, SubscriptionPreviewTime } from './subscription-status'
import { toast } from 'sonner'

export default function SubscriptionsTab({ compact = false }: { compact?: boolean }) {
  const { config, server } = useDraft()
  const { data: statuses, error: statusError } = useSubscriptionStatus()
  const { data: tasks } = useTasks()
  const successfulPreviews = useSuccessfulPreviews()
  const [review, setReview] = useState<{ preview: SubscriptionPreview; subscription: Subscription } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [taskOf, setTaskOf] = useState<Record<string, string>>({})
  const [probeTaskOf, setProbeTaskOf] = useState<Record<string, string>>({})
  const [unchanged, setUnchanged] = useState<{ subscriptionId: string } | null>(null)
  const [editor, setEditor] = useState<{ subscription?: Subscription; revision: number } | null>(null)
  const preview = review?.preview
  const previewOf = review?.subscription
  const probes = useSubscriptionPreviewProbes(preview)

  useEffect(() => {
    if (!unchanged) return
    const timer = window.setTimeout(() => setUnchanged(null), 4000)
    return () => window.clearTimeout(timer)
  }, [unchanged])

  if (!config) return null
  const status = (id: string): SubscriptionStatus | undefined => statuses?.find((s) => s.subscriptionId === id)

  const openPreview = async (sub: Subscription) => {
    if (busyId) return
    if (!server?.subscriptions.some((saved) => saved.id === sub.id)) {
      toast.error('Сначала примените добавленную подписку')
      return
    }
    setBusyId(sub.id)
    setUnchanged(null)
    const preview = await api.previewSubscription(sub.id).catch(() =>
      subscriptionPreviewFailure(sub.id, 'Не удалось получить ответ API панели. Повторите запрос.'))
    rememberSubscriptionPreview(preview)
    if (compact && preview.ok && !preview.token && !hasPreviewDetails(preview)) {
      setUnchanged({ subscriptionId: sub.id })
      setReview(null)
    } else setReview({ preview, subscription: sub })
    setBusyId(null)
  }

  const apply = async () => {
    if (!previewOf || !preview?.ok || applying || probes.busy) return
    const subId = previewOf.id
    setApplying(true)
    try {
      const t = await api.refreshSubscription(subId, preview.token)
      setTaskOf((prev) => ({ ...prev, [subId]: t.id }))
      setReview(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  const save = async (input: SubscriptionInput) => {
    if (!editor || !api.saveSubscription) return
    await api.saveSubscription(input, editor.revision)
    if (input.id && (input.url || input.deviceId !== undefined || input.userAgent !== undefined)) {
      forgetSubscriptionPreview(input.id)
    }
    toast.success(editor.subscription ? 'Настройки подписки сохранены' : 'Подписка добавлена')
  }

  const remove = async () => {
    if (!editor?.subscription || !api.deleteSubscription) return
    await api.deleteSubscription(editor.subscription.id, editor.revision)
    forgetSubscriptionPreview(editor.subscription.id)
    toast.success('Подписка удалена')
  }

  const canEdit = Boolean(api.saveSubscription && server)
  const canProbe = probeableProfiles(server?.profiles)
  const probing = hasActiveProfileProbe(tasks)

  return (
    <>
      <Section
        title={compact ? undefined : 'Подписки'}
        description={compact ? undefined : 'Подписка пополняет каталог и сохраняет назначение профилей в правилах.'}
        actions={canEdit && (
          <WriteButton size="sm" variant="outline" onClick={() => server && setEditor({ revision: server.revision })}>
            <Plus aria-hidden="true" /> Добавить подписку
          </WriteButton>
        )}
      >
        {statusError && <Notice tone="warn" title="Статус подписок недоступен" className="mb-3">{statusError}</Notice>}
        {config.subscriptions.length === 0 ? (
          <EmptyState icon={<CloudDownload />} title="Подписок нет">
            {!compact && 'Профили можно добавлять вручную, из файла или подпиской по ссылке.'}
          </EmptyState>
        ) : (
          <div className={compact ? 'divide-y divide-border overflow-hidden rounded-xl border border-border bg-card' : 'space-y-3'}>
            {config.subscriptions.map((sub) => {
              const task = tasks?.find(({ id }) => id === taskOf[sub.id])
              const pending = task?.state === 'pending' || task?.state === 'running'
              const probeIds = canProbe.filter(({ origin }) => origin.type === 'subscription' && origin.subscriptionId === sub.id).map(({ id }) => id)
              const profiles = subscriptionProfiles(config.profiles, sub.id)
              return <SubscriptionCard
                key={sub.id}
                subscription={sub}
                status={status(sub.id)}
                lastPreview={successfulPreviews.get(sub.id)}
                catalogLabel={subscriptionCatalogLabel(profiles)}
                profileCount={profiles.filter((p) => !compact || p.lifecycle !== 'missing-upstream').length}
                busy={busyId === sub.id || pending}
                pending={pending}
                disabled={!!busyId || pending}
                compact={compact}
                unchanged={unchanged?.subscriptionId === sub.id}
                taskId={taskOf[sub.id] ?? null}
                probeTaskId={probeTaskOf[sub.id] ?? null}
                probing={probing}
                onPreview={() => void openPreview(sub)}
                onProbe={probeIds.length ? () => void startOperation(() => api.probeProfiles(probeIds), (id) =>
                  setProbeTaskOf((previous) => ({ ...previous, [sub.id]: id }))) : undefined}
                onEdit={canEdit && server?.subscriptions.some(({ id }) => id === sub.id)
                  ? () => setEditor({ subscription: sub, revision: server.revision })
                  : undefined}
              />
            })}
          </div>
        )}

        {!compact && <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <ShieldAlert className="size-3.5 shrink-0" />
          Загрузка идёт по HTTPS с ограничением объёма ответа. Переадресации разрешены в пределах того же домена и порта. В каталоге отображается маскированная ссылка. Ключи профилей хранятся на роутере.
        </p>}
      </Section>

      <Modal
        open={!!previewOf}
        onClose={() => { if (!applying && !busyId) setReview(null) }}
        dismissible={!applying && !busyId}
        size={compact ? 'md' : 'lg'}
        title={previewOf ? `Обновление подписки «${previewOf.name}»` : 'Предпросмотр обновления'}
        description={preview?.ok ? 'Изменения в каталоге после применения обновления' : undefined}
        footer={
          <div className="space-y-2.5">
            {preview?.ok && preview.changed.some((change) => change.kind === 'renamed') && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                При переименовании сохраняются псевдонимы, закрепления и участие в группах.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="min-h-9" disabled={applying || !!busyId} onClick={() => setReview(null)}>
                {preview?.ok ? 'Отмена' : 'Закрыть'}
              </Button>
              {preview?.ok ? (
                <WriteButton className="min-h-9" disabled={applying || Boolean(probes.busy)} onClick={() => void apply()}>
                  {applying ? 'Запускаем…' : hasSubscriptionChanges(preview) ? 'Применить обновление' : 'Сохранить результат'}
                </WriteButton>
              ) : previewOf && (
                <WriteButton className="min-h-9" disabled={!!busyId} onClick={() => void openPreview(previewOf)}>
                  {busyId ? 'Проверяем…' : 'Повторить загрузку'}
                </WriteButton>
              )}
            </div>
          </div>
        }
      >
        {preview && <PreviewBody preview={preview} status={status(preview.subscriptionId)} applying={applying} probes={probes} />}
      </Modal>
      {editor && <SubscriptionEditor
        subscription={editor.subscription}
        close={() => setEditor(null)}
        save={save}
        remove={editor.subscription && api.deleteSubscription ? remove : undefined}
      />}
    </>
  )
}

/* ═══════════════════════ карточка подписки ═══════════════════════ */

function SubscriptionCard({
  subscription: sub,
  status,
  lastPreview,
  catalogLabel,
  profileCount,
  busy,
  pending,
  disabled,
  compact,
  unchanged,
  taskId,
  probeTaskId,
  probing,
  onPreview,
  onProbe,
  onEdit,
}: {
  subscription: Subscription
  status: SubscriptionStatus | undefined
  lastPreview?: string
  catalogLabel?: string
  profileCount: number
  busy: boolean
  pending: boolean
  disabled: boolean
  compact: boolean
  unchanged: boolean
  taskId: string | null
  probeTaskId: string | null
  probing: boolean
  onPreview: () => void
  onProbe?: () => void
  onEdit?: () => void
}) {
  const lastSuccess = status?.lastSuccess
  const attempt = status?.lastAttempt
  const failed = attempt && !attempt.ok
  const details: [ReactNode, ReactNode][] = [
    ['Источник', <Mono className="[overflow-wrap:anywhere]">{sub.url}</Mono>],
    ['User-Agent запроса', sub.userAgent ? 'Настроен' : 'RouteHub'],
    ['Интервал', sub.enabled ? `каждые ${sub.intervalHours} ч` : 'вручную'],
    ['Снимок', lastSuccess?.revision ?? '—'],
    ['Следующий запуск', sub.enabled ? <TimeAgo at={status?.nextRun} /> : '—'],
  ]
  if (attempt?.ok) details.push(['Последняя попытка', <TimeAgo at={attempt.at} />])
  const shortcuts = (
    <>
      {onProbe && (
        <WriteButton variant="ghost" size="sm" disabled={probing} onClick={onProbe} aria-label={`Проверить профили подписки «${sub.name}»`}>
          <RefreshCw aria-hidden="true" /> Проверить профили
        </WriteButton>
      )}
      {profileCount > 0 && (
        <a href={href('/exits-preview', { sub: sub.id })} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          Профили подписки
        </a>
      )}
      {onEdit && (
        <WriteButton variant="ghost" size="sm" disabled={disabled} onClick={onEdit} aria-label={`Настроить подписку «${sub.name}»`}>
          <Settings2 aria-hidden="true" /> Настроить
        </WriteButton>
      )}
    </>
  )

  if (compact) return (
    <div className="min-w-0 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-semibold">{sub.name}</span>
            {failed && <StatusBadge tone="warn">Ошибка</StatusBadge>}
          </div>
          <p className="text-[12px] text-muted-foreground">
            {catalogLabel && `${catalogLabel} · `}{count(profileCount, ['профиль', 'профиля', 'профилей'])}
            {!sub.enabled && ' · автообновление выключено'}
          </p>
          {status && <p className="text-[11.5px] text-muted-foreground">
            {lastSuccess ? <>Успешная синхронизация <TimeAgo at={lastSuccess.at} /></> : 'Успешной синхронизации ещё не было'}
          </p>}
          {lastPreview && <p className="text-[11.5px] text-muted-foreground">Успешный предпросмотр в этой вкладке <TimeAgo at={lastPreview} /></p>}
        </div>
        <WriteButton variant="outline" size="sm" className="min-h-8" onClick={onPreview} disabled={disabled} aria-label={`Обновить подписку «${sub.name}»`}>
          <RefreshCw className={busy ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" /> {pending ? 'Обновляем…' : busy ? 'Проверяем…' : 'Обновить'}
        </WriteButton>
      </div>
      <div role="status" aria-live="polite">
        {unchanged && (
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-ok/10 px-2 py-1 text-xs font-medium text-ok">
            <Check className="size-3.5" aria-hidden="true" /> Изменений нет
          </span>
        )}
      </div>
      {failed && <div className="mt-1"><SubscriptionAttemptError attempt={attempt} /></div>}
      <details className="group mt-1">
        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          Сведения <ChevronDown className="size-3.5 group-open:rotate-180" aria-hidden="true" />
        </summary>
        <KV items={details} />
      </details>
      {(profileCount > 0 || onEdit || onProbe) && <div className="flex flex-wrap gap-1">{shortcuts}</div>}
      {taskId && <div className="mt-2"><TaskById id={taskId} /></div>}
      {probeTaskId && <div className="mt-2"><TaskById id={probeTaskId} /></div>}
    </div>
  )

  return (
    <Panel className="space-y-3 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <CloudDownload className="size-4 text-muted-foreground" />
        <span className="text-[15px] font-semibold">{sub.name}</span>
        {catalogLabel && <StatusBadge tone="muted">{catalogLabel}</StatusBadge>}
        <StatusBadge tone={sub.enabled ? 'ok' : 'muted'}>{sub.enabled ? 'автообновление' : 'обновляется вручную'}</StatusBadge>
        <StatusBadge tone="muted">{count(profileCount, ['профиль', 'профиля', 'профилей'])} в каталоге</StatusBadge>
      </div>

      <KV
        items={[
          [
            'Источник',
            <span className="inline-flex flex-wrap items-center gap-2">
              <Mono className="break-all">{sub.url}</Mono>
              <StatusBadge tone="muted">маскировано</StatusBadge>
            </span>,
          ],
          ['User-Agent запроса', sub.userAgent ? 'Настроен' : 'RouteHub'],
          ['Интервал', sub.enabled ? `каждые ${sub.intervalHours} ч` : 'вручную'],
          [
            'Последняя успешная синхронизация',
            lastSuccess ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Mono>{lastSuccess.revision}</Mono>
                <span>{count(lastSuccess.profiles, ['профиль', 'профиля', 'профилей'])}</span>
                <TimeAgo at={lastSuccess.at} />
              </span>
            ) : (
              status ? 'ещё не было' : '—'
            ),
          ],
          [
            'Последняя попытка',
            attempt?.ok ? <TimeAgo at={attempt.at} /> : failed ? 'ошибка' : 'ещё не было',
          ],
          ['Успешный предпросмотр в этой вкладке', lastPreview ? <TimeAgo at={lastPreview} /> : '—'],
          ['Следующий запуск', sub.enabled ? <TimeAgo at={status?.nextRun} /> : '—'],
        ]}
      />

      {failed && (
        <Notice tone="warn" title="Последняя попытка завершилась ошибкой">
          <SubscriptionAttemptError attempt={attempt} />
          <p className="mt-1">Каталог сохранён.</p>
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <WriteButton variant="outline" onClick={onPreview} disabled={disabled}>
          <RefreshCw className={busy ? 'animate-spin' : undefined} /> {busy ? 'Проверяем…' : 'Обновить'}
        </WriteButton>
        {shortcuts}
      </div>

      {taskId && <TaskById id={taskId} />}
      {probeTaskId && <TaskById id={probeTaskId} />}
    </Panel>
  )
}

/* ═══════════════════════ предпросмотр ═══════════════════════ */

function PreviewBody({ preview: pv, status, applying, probes }: {
  preview: SubscriptionPreview; status?: SubscriptionStatus; applying: boolean; probes: ReturnType<typeof useSubscriptionPreviewProbes>
}) {
  const { config } = useDraft()
  const profileName = (id: string) => config?.profiles.find((p) => p.id === id)?.alias ?? config?.profiles.find((p) => p.id === id)?.name ?? id

  return (
    <div className="space-y-4">
      <SubscriptionPreviewTime preview={pv} />
      {pv.ok && <SubscriptionProbeBatch controls={probes} disabled={applying} />}
      {!pv.ok && <SubscriptionPreviewError error={pv.error} status={status} />}
      {pv.ok && !hasSubscriptionChanges(pv) && (
        <Notice tone="ok" title="Изменений нет">
          Профили, псевдонимы и участие в группах останутся как есть.
        </Notice>
      )}
      {pv.ok && (
        <>
          {pv.added.length > 0 && (
            <PreviewBlock tone="ok" title={`Добавятся · ${pv.added.length}`} hint="Новые профили появятся в каталоге, но не в группах: участие профиля в группе задаёт администратор.">
              {pv.added.map((a) => (
                <div key={a.upstreamKey} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-medium">{a.name}</span>
                  {a.xrayGroup && <StatusBadge tone="info">{xrayGroupDescription(a.groupSize)}</StatusBadge>}
                  <Mono className="text-muted-foreground">{maskKey(a.upstreamKey)}</Mono>
                  <SubscriptionProbe id={a.upstreamKey} name={a.name} controls={probes} disabled={applying} />
                </div>
              ))}
            </PreviewBlock>
          )}

          {pv.changed.length > 0 && (
            <PreviewBlock tone="info" title={`Изменятся · ${pv.changed.length}`} hint="Профиль опознаётся по устойчивому ключу, а не по имени, поэтому псевдоним и закрепления не теряются.">
              {pv.changed.map((c) => (
                <div key={c.profileId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-medium">{c.from}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-medium">{c.to}</span>
                  <StatusBadge tone={c.kind === 'renamed' ? 'info' : 'warn'}>
                    {c.kind === 'renamed' ? 'переименован — псевдоним и закрепления сохранены' : 'изменились параметры'}
                  </StatusBadge>
                  <SubscriptionProbe id={c.profileId} name={c.to} controls={probes} disabled={applying} />
                </div>
              ))}
            </PreviewBlock>
          )}

          {pv.missing.length > 0 && (
            <PreviewBlock tone="warn" title={`Исчезнут · ${pv.missing.length}`} hint="Профиль останется в каталоге со статусом «исчез из подписки»; автоматической замены по совпадению имени нет.">
              {pv.missing.map((m) => (
                <div key={m.profileId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-medium">{profileName(m.profileId)}</span>
                  {m.usedBy.length ? (
                    m.usedBy.map((u) => (
                      <StatusBadge key={u} tone="warn">
                        используется: {u}
                      </StatusBadge>
                    ))
                  ) : (
                    <span className="text-[12px] text-muted-foreground">нигде не используется</span>
                  )}
                </div>
              ))}
            </PreviewBlock>
          )}

          {pv.ambiguous.length > 0 && (
            <PreviewBlock tone="warn" title={`Неоднозначны · ${pv.ambiguous.length}`} hint="Несколько кандидатов на замену — выбор только вручную, автоматическая замена запрещена.">
              {pv.ambiguous.map((a) => (
                <div key={a.profileId} className="flex flex-col gap-1 px-3 py-2">
                  <span className="font-medium">{profileName(a.profileId)}</span>
                  <span className="text-[12px] text-muted-foreground">Кандидаты: {a.candidates.join(', ')}</span>
                </div>
              ))}
            </PreviewBlock>
          )}

          <p className="text-[12px] leading-relaxed text-muted-foreground">
            При применении сохранится показанный снимок. Если проверка на роутере завершится ошибкой, продолжит действовать предыдущий каталог.
          </p>
        </>
      )}
      {pv.incompatible.length > 0 && (
        <PreviewBlock tone="bad" title={`Несовместимы · ${pv.incompatible.length}`} hint="Эти профили пропущены при разборе подписки.">
          {pv.incompatible.map((i) => (
            <div key={i.upstreamKey} className="flex flex-col gap-1 px-3 py-2 [overflow-wrap:anywhere]">
              <span className="font-medium">{i.name}</span>
              <span className="text-[12px] text-muted-foreground">{i.reason}</span>
            </div>
          ))}
        </PreviewBlock>
      )}
    </div>
  )
}

function PreviewBlock({ tone, title, hint, children }: { tone: Tone; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl ring-1 ring-border">
      <header className="flex items-center gap-2 bg-muted/40 px-3 py-2">
        <StatusDot tone={tone} />
        <span className="text-[13px] font-medium">{title}</span>
      </header>
      <div className="divide-y divide-border/70 bg-card text-[13px]">{children}</div>
      <p className="bg-card px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>
    </section>
  )
}

const maskKey = (key: string) => key.replace(/[^:]+$/, '••••')
