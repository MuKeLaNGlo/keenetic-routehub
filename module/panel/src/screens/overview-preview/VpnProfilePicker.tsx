import { useEffect, useId, useState, type ReactNode } from 'react'
import { Activity, Check, ChevronRight, Loader2, RefreshCw, Search, Upload } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Profile, Subscription, SubscriptionPreview, SubscriptionStatus } from '@/api/contract'
import { TimeAgo, WriteButton } from '@/components/rh/controls'
import { Notice } from '@/components/rh/layout'
import { DetailSheet, Modal } from '@/components/rh/sheet'
import { ProbeBadge, StatusBadge, StatusDot, TASK, type Tone } from '@/components/rh/status'
import { TaskCard } from '@/components/rh/task'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { count } from '@/lib/format'
import { profileFormatLabel, profileFormatSummary, xrayGroupDescription } from '@/lib/labels'
import { hasSubscriptionChanges, subscriptionCatalogLabel, subscriptionProfiles } from '@/lib/subscriptions'
import { cn } from '@/lib/utils'
import { useRuntime, useServerConfig } from '@/state/resource'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'
import { effectiveProbe, profileLabel } from '@/screens/exits/shared'
import { SubscriptionProbe, SubscriptionProbeBatch, useSubscriptionPreviewProbes } from '@/screens/exits/subscription-probe'
import { SubscriptionAttemptError, SubscriptionPreviewError, SubscriptionPreviewTime } from '@/screens/exits/subscription-status'
import type { PrimaryProfileSwitch } from './usePrimaryProfileSwitch'
import { useVpnProfiles } from './useVpnProfiles'

type Catalog = ReturnType<typeof useVpnProfiles>
const pickerParam = 'vpnProfiles'
const profileCount = (length: number) => count(length, ['профиль', 'профиля', 'профилей'])
export function VpnProfilePicker() {
  const route = useRoute()
  const open = route.query.get(pickerParam) === '1'
  const catalog = useVpnProfiles()
  const { activeId, profiles, preview, previewBusyId, closeSubscriptionPreview, profileSwitch } = catalog
  const probes = useSubscriptionPreviewProbes(preview?.result)
  const [showSwitch, setShowSwitch] = useState(false)
  const switchOpen = open && (showSwitch || profileSwitch.busy) && !!profileSwitch.state
  const primary = profiles.find((profile) => profile.id === activeId)
  const label = primary ? profileLabel(primary) : catalog.loading ? 'Загрузка…' : 'Выбрать профиль'
  const refreshing = preview ? catalog.isRefreshing(preview.subscription.id) : false

  useEffect(() => {
    if (open) return
    setShowSwitch(false)
    if (preview || previewBusyId) closeSubscriptionPreview()
  }, [open, preview, previewBusyId, closeSubscriptionPreview])

  function closePicker() {
    setShowSwitch(false)
    closeSubscriptionPreview()
    closeQuery(pickerParam)
  }

  function select(profile: Profile) {
    if (profileSwitch.start(profile)) setShowSwitch(true)
  }

  function reviewDraft() {
    closeSubscriptionPreview()
    setShowSwitch(false)
    setQuery({ [pickerParam]: null, review: '1' }, { replace: true })
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setShowSwitch(profileSwitch.busy)
          setQuery({ [pickerParam]: '1' })
        }}
        className="relative mx-auto flex min-h-14 w-full max-w-[450px] cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card py-2 pr-8 pl-3 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-[min(100%,7rem)] flex-1">
          <span className="block text-[11.5px] leading-snug text-muted-foreground">Основной профиль VPN</span>
          <span className="mt-0.5 block truncate text-[13.5px] leading-snug font-semibold" title={label}>{label}</span>
          {primary && <span className="mt-0.5 block text-[11.5px] leading-snug break-words text-muted-foreground">{profileFormatSummary(primary)}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-[12.5px]">
          {primary && <ProbeBadge probe={effectiveProbe(primary, catalog.runtime)} compact />}
          {profileSwitch.busy && <StatusBadge tone="info" icon={<Loader2 className="motion-safe:animate-spin" />}>Переключаем…</StatusBadge>}
        </span>
        <ChevronRight className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      </button>

      <DetailSheet
        open={open && !switchOpen}
        onClose={closePicker}
        width="lg"
        title={preview ? `Обновление «${preview.subscription.name}»` : 'Профили VPN'}
        description={preview?.result.ok ? 'Изменения в каталоге после обновления подписки' : undefined}
        footer={preview ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={closeSubscriptionPreview}>К списку</Button>
            {preview.result.ok ? (
              <WriteButton disabled={refreshing || Boolean(probes.busy)} onClick={() => void catalog.refreshPreview()}>
                {refreshing ? 'Запускаем…' : hasSubscriptionChanges(preview.result) ? 'Обновить подписку' : 'Сохранить результат'}
              </WriteButton>
            ) : (
              <WriteButton disabled={!!previewBusyId} onClick={() => void catalog.openSubscriptionPreview(preview.subscription.id)}>
                {previewBusyId ? 'Проверяем…' : 'Повторить загрузку'}
              </WriteButton>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <WriteButton variant="outline" disabled={!catalog.batchProfiles().length || catalog.probing} onClick={() => void catalog.probeBatch()}>
              <Activity aria-hidden="true" /> Проверить все профили
            </WriteButton>
            <Button variant="outline" render={<a href={href('/exits-preview', { tab: 'profiles', import: '1' })} />} nativeButton={false}>
              <Upload aria-hidden="true" /> Импорт профиля
            </Button>
            <Button variant="ghost" render={<a href={href('/exits-preview', { tab: 'subscriptions' })} />} nativeButton={false}>
              Подписки <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        )}
      >
        {preview ? <UpdatePreview result={preview.result} catalog={catalog} probes={probes} /> : <ProfileCatalog catalog={catalog} onSelect={select} />}
      </DetailSheet>

      {profileSwitch.state && (
        <ProfileSwitchModal
          open={switchOpen}
          state={profileSwitch.state}
          busy={profileSwitch.busy}
          onClose={closePicker}
          onBack={() => setShowSwitch(false)}
          onReview={catalog.outdated ? reviewDraft : undefined}
          outdated={catalog.outdated}
        />
      )}
    </>
  )
}

function ProfileSwitchModal({ open, state, busy, outdated, onClose, onBack, onReview }: {
  open: boolean
  state: PrimaryProfileSwitch
  busy: boolean
  outdated: boolean
  onClose: () => void
  onBack: () => void
  onReview?: () => void
}) {
  const task = 'task' in state ? state.task : undefined
  const status = state.phase === 'checking'
    ? 'Проверяем актуальную конфигурацию…'
    : state.phase === 'starting'
      ? 'Запускаем применение…'
      : state.phase === 'syncing'
        ? 'Обновляем данные о профиле…'
        : undefined

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Смена основного профиля VPN"
      description={state.target.label}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!busy && onReview && <Button type="button" variant="outline" onClick={onReview}>Сверить черновик</Button>}
          {!busy && <Button type="button" variant="ghost" onClick={onBack}>К профилям</Button>}
          <Button type="button" variant={busy ? 'outline' : 'default'} onClick={onClose}>{busy ? 'Свернуть' : 'Готово'}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {status && (
          <div role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 shrink-0 text-info motion-safe:animate-spin" aria-hidden="true" /> {status}
          </div>
        )}
        {task && <TaskCard task={task} showSteps={state.phase === 'applying' || task.state !== 'done'} />}
        {state.phase === 'blocked' && (
          <div role="alert">
            <Notice tone="bad" title={state.title}>
              {state.details.map((detail) => <p key={detail} className="[overflow-wrap:anywhere]">{detail}</p>)}
            </Notice>
          </div>
        )}
        {state.phase === 'finished' && (
          <>
            {(!task || task.state === 'done') && (
              <p role="status" className="flex items-start gap-2 text-[13px]">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
                {state.note ?? (task ? 'Основной профиль обновлён.' : 'Этот профиль уже основной.')}
              </p>
            )}
            {task && task.state !== 'done' && <p role="status" className="sr-only">{TASK[task.state].label}</p>}
            {outdated && <Notice tone="warn" title="Черновик от предыдущей ревизии">Сверьте его перед применением.</Notice>}
          </>
        )}
        {busy && <p className="text-xs text-muted-foreground">После запуска ход применения также виден в центре задач.</p>}
      </div>
    </Modal>
  )
}

function ProfileCatalog({ catalog, onSelect }: { catalog: Catalog; onSelect: (profile: Profile) => void }) {
  const { profiles, subscriptions, subscriptionStatuses, loading, error } = catalog
  const { data: server, error: serverError } = useServerConfig()
  const { data: runtime, error: runtimeError } = useRuntime()
  const [query, setQuery] = useState('')
  const active = server?.profiles.find((profile) => profile.id === catalog.activeId)
  const loaded = !!runtime && !!server && !serverError && !runtimeError && runtime.loadedRevision === server.revision
  const activeTitle = loaded && active ? 'Действующий профиль' : 'Сохранённый профиль'
  const other = profiles.filter((profile) => profile.id !== catalog.activeId)
  const manual = other.filter(({ origin }) => origin.type !== 'subscription')
  const subscriptionIds = new Set(subscriptions.map(({ id }) => id))
  const unknownSource = other.filter(({ origin }) => origin.type === 'subscription' && !subscriptionIds.has(origin.subscriptionId))
  const emptyCatalog = profiles.length === 0 && subscriptions.length === 0
  const batchTask = catalog.batchTask()
  const needle = query.trim().toLocaleLowerCase('ru')
  const results = needle ? other.filter((profile) => {
    const origin = profile.origin
    const source = origin.type === 'subscription' ? subscriptions.find(({ id }) => id === origin.subscriptionId)?.name : undefined
    return [profileLabel(profile), profile.name, profileFormatSummary(profile), source].some((term) => term?.toLocaleLowerCase('ru').includes(needle))
  }) : []

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border bg-card px-3 py-2.5" aria-label={activeTitle}>
        <h3 className="text-[11.5px] font-medium text-muted-foreground">{activeTitle}</h3>
        {active ? (
          <ul className="mt-0.5">
            <ProfileRow profile={active} catalog={catalog} onSelect={onSelect} current />
          </ul>
        ) : (
          <p className="mt-0.5 text-[13px] text-muted-foreground">{loading ? 'Загрузка…' : 'Профиль не найден'}</p>
        )}
        {active && !loaded && (
          <p className="mt-1 text-[11.5px] text-warn">Сейчас на роутере не подтверждён</p>
        )}
      </section>

      {error && <Notice tone="warn" title="Часть данных недоступна">Не удалось обновить каталог или состояние проверок.</Notice>}
      {batchTask && <TaskCard task={batchTask} />}

      {(other.length > 0 || query) && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Имя или протокол" aria-label="Найти VPN-профиль" className="h-9 pl-8" />
        </div>
      )}

      {needle ? (
        <div className="rounded-xl border border-border bg-card">
          <ProfileList profiles={results} catalog={catalog} onSelect={onSelect} empty="Нет других профилей по этому запросу" />
        </div>
      ) : (
        (!emptyCatalog || (!error && !loading)) && (
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            <section aria-label="Вручную и из файлов">
              <h3 className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-[13px]">
                <span className="font-semibold">Вручную и из файлов</span>
                <span className="text-[11.5px] text-muted-foreground">{profileCount(manual.length)}</span>
              </h3>
              <ProfileList profiles={manual} catalog={catalog} onSelect={onSelect} />
            </section>
            {subscriptions.map((sub) => (
              <SubscriptionGroup
                key={sub.id}
                subscription={sub}
                profiles={subscriptionProfiles(other, sub.id)}
                includesActiveProfile={active?.origin.type === 'subscription' && active.origin.subscriptionId === sub.id}
                status={subscriptionStatuses.find((status) => status.subscriptionId === sub.id)}
                catalog={catalog}
                onSelect={onSelect}
              />
            ))}
            {unknownSource.length > 0 && (
              <ProfileGroup title="Источник недоступен" metadata={profileCount(unknownSource.length)}>
                <ProfileList profiles={unknownSource} catalog={catalog} onSelect={onSelect} />
              </ProfileGroup>
            )}
          </div>
        )
      )}
    </div>
  )
}

function ProbeButton({ profile, catalog }: { profile: Profile; catalog: Catalog }) {
  const label = `Измерить задержку «${profileLabel(profile)}»`
  const probing = catalog.isProbing(profile.id)
  const unavailable = catalog.unavailableReason(profile)
  return (
    <Button size="icon-sm" variant="ghost" className="size-8" aria-label={label} title={unavailable ?? label} disabled={!!unavailable || probing || catalog.probing || !catalog.canWrite} onClick={() => void catalog.probe(profile.id)}>
      {probing ? <RefreshCw aria-hidden="true" className="motion-safe:animate-spin" /> : <Activity aria-hidden="true" />}
    </Button>
  )
}

function SelectButton({ profile, catalog, onSelect }: { profile: Profile; catalog: Catalog; onSelect: (profile: Profile) => void }) {
  const unavailable = catalog.selectReason(profile)
  return (
    <WriteButton
      size="sm"
      variant="outline"
      className="min-h-8 text-[12px]"
      aria-label={`Выбрать «${profileLabel(profile)}» основным профилем`}
      disabled={!!unavailable || !catalog.canWrite}
      reason={unavailable}
      onClick={() => onSelect(profile)}
    >
      Выбрать
    </WriteButton>
  )
}

function ProfileList({ profiles, catalog, onSelect, empty = 'Других профилей нет' }: { profiles: Profile[]; catalog: Catalog; onSelect: (profile: Profile) => void; empty?: string }) {
  if (!profiles.length) return <p className="px-3 py-2.5 text-[12px] text-muted-foreground">{empty}</p>
  return (
    <ul className="divide-y divide-border">
      {profiles.map((profile) => <ProfileRow key={profile.id} profile={profile} catalog={catalog} onSelect={onSelect} />)}
    </ul>
  )
}

function ProfileRow({ profile, catalog, onSelect, current = false }: { profile: Profile; catalog: Catalog; onSelect: (profile: Profile) => void; current?: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const label = profileLabel(profile)
  const probe = effectiveProbe(profile, catalog.runtime)
  const unavailable = catalog.unavailableReason(profile)
  return (
    <li className={current ? undefined : 'px-3 py-1.5'}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          aria-label={`Детали профиля «${label}»`}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="flex min-h-9 min-w-[min(100%,7rem)] flex-1 cursor-pointer items-center gap-1.5 rounded-md text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground', open && 'rotate-90')} aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className={cn('block leading-snug', current ? 'text-[14px] font-semibold' : 'text-[13px] font-medium')}>{label}</span>
            <span className="block text-[11.5px] text-muted-foreground">{profileFormatLabel(profile)}</span>
          </span>
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[12px]">
          {unavailable ? <span className="text-[11.5px] text-warn">{unavailable}</span> : (
            <>
              <ProbeBadge probe={probe} compact />
              {current && probe.measuredAt && <TimeAgo at={probe.measuredAt} className="text-[11.5px] text-muted-foreground" />}
              <ProbeButton profile={profile} catalog={catalog} />
              {profile.id !== catalog.activeId && <SelectButton profile={profile} catalog={catalog} onSelect={onSelect} />}
            </>
          )}
        </div>
      </div>
      <div id={id} hidden={!open} className="space-y-0.5 pt-1 pb-1 pl-[18px] text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
        {profile.xrayGroup ? <p>{xrayGroupDescription(profile.groupSize)}</p> : profile.transport && <p>Транспорт {profile.transport}</p>}
        <p className="flex flex-wrap items-center gap-x-2"><ProbeBadge probe={probe} />{probe.state === 'stale' && <span className="text-warn">Замер устарел</span>}</p>
      </div>
    </li>
  )
}

function ProfileGroup({ title, metadata, action, feedback, task, children }: { title: string; metadata: ReactNode; action?: ReactNode; feedback?: ReactNode; task?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section>
      <div className={cn('flex items-center gap-1.5 px-2.5', open && 'bg-muted/35')}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-150', open && 'rotate-90 text-foreground')} aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="block text-[13px] leading-snug font-semibold">{title}</span>
            <span className="block text-[11.5px] leading-snug text-muted-foreground">{metadata}</span>
          </span>
        </button>
        {action}
      </div>
      {feedback}
      {task}
      <div id={id} hidden={!open} className="mx-2.5 my-2.5 overflow-hidden rounded-lg border border-l-2 border-border border-l-muted-foreground/30 bg-muted/45">
        {open && children}
      </div>
    </section>
  )
}

function SubscriptionGroup({
  subscription,
  profiles,
  includesActiveProfile,
  status,
  catalog,
  onSelect,
}: {
  subscription: Subscription
  profiles: Profile[]
  includesActiveProfile: boolean
  status: SubscriptionStatus | undefined
  catalog: Catalog
  onSelect: (profile: Profile) => void
}) {
  const reduceMotion = useReducedMotion()
  const loading = catalog.previewBusyId === subscription.id
  const refreshing = catalog.isRefreshing(subscription.id)
  const task = catalog.subscriptionTask(subscription.id)
  const batchTask = catalog.batchTask(subscription.id)
  const failure = status?.lastAttempt?.ok === false ? status.lastAttempt : null
  const lastSuccess = status?.lastSuccess?.at
  const lastPreview = catalog.successfulPreviews.get(subscription.id)
  const catalogLabel = subscriptionCatalogLabel(subscriptionProfiles(catalog.profiles, subscription.id))

  return (
    <ProfileGroup
      title={subscription.name}
      metadata={
        <>
          {catalogLabel && `${catalogLabel} · `}{profileCount(profiles.length + Number(includesActiveProfile))}
          {!subscription.enabled && ' · автообновление выключено'}
          {lastSuccess && <> · Успешная синхронизация <TimeAgo at={lastSuccess} /></>}
          {failure && <> · <span className="text-warn">Ошибка обновления</span></>}
        </>
      }
      action={
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {catalog.batchProfiles(subscription.id).length > 0 && (
            <WriteButton
              size="sm" variant="ghost" className="min-h-8 text-[12px]"
              aria-label={`Проверить профили подписки «${subscription.name}»`}
              disabled={catalog.probing} onClick={() => void catalog.probeBatch(subscription.id)}
            >
              <Activity aria-hidden="true" /> Проверить
            </WriteButton>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="min-h-8 text-[12px]"
            aria-label={`Обновить подписку «${subscription.name}»`}
            disabled={!catalog.canWrite || !!catalog.previewBusyId || refreshing}
            onClick={() => void catalog.openSubscriptionPreview(subscription.id)}
          >
            <RefreshCw aria-hidden="true" className={loading || refreshing ? 'motion-safe:animate-spin' : undefined} />
            {loading ? 'Проверяем…' : refreshing ? 'Обновляем…' : 'Обновить'}
          </Button>
        </div>
      }
      feedback={
        <div role="status" aria-live="polite" aria-atomic="true">
          {catalog.unchangedSubscriptionId === subscription.id && (
            <p className="flex items-center gap-1.5 px-3 pb-2 text-[12px] text-ok">
              <Check className="size-3.5" aria-hidden="true" /> Изменений нет
            </p>
          )}
        </div>
      }
      task={
        <AnimatePresence initial={false}>
          {task && (
            <motion.div
              key="task"
              className="overflow-hidden px-3"
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              <div className="pt-px pb-2.5">
                <TaskCard key={task.id} task={task} showSteps={task.state === 'running' || task.state === 'error'} />
              </div>
            </motion.div>
          )}
          {batchTask && <div key="probe-batch" className="px-3 pb-2.5"><TaskCard task={batchTask} /></div>}
        </AnimatePresence>
      }
    >
      {(failure || lastPreview) && <div className="space-y-1 px-3 pt-2">
        {failure && <SubscriptionAttemptError attempt={failure} />}
        {lastPreview && <p className="text-[11.5px] text-muted-foreground">Успешный предпросмотр в этой вкладке <TimeAgo at={lastPreview} /></p>}
      </div>}
      <ProfileList profiles={profiles} catalog={catalog} onSelect={onSelect} />
    </ProfileGroup>
  )
}

function UpdatePreview({ result, catalog, probes }: {
  result: SubscriptionPreview; catalog: Catalog; probes: ReturnType<typeof useSubscriptionPreviewProbes>
}) {
  const name = (id: string, fallback?: string) => {
    const profile = catalog.profiles.find((item) => item.id === id)
    return profile ? profileLabel(profile) : fallback ?? id
  }
  const groups: { title: string; tone: Tone; items: { key: string; label: string; detail?: string; testable?: boolean }[] }[] = [
    {
      title: 'Добавятся', tone: 'ok',
      items: result.added.map((item) => ({
        key: item.upstreamKey, label: item.name, testable: true,
        detail: item.xrayGroup ? xrayGroupDescription(item.groupSize) : undefined,
      })),
    },
    {
      title: 'Изменятся', tone: 'info',
      items: result.changed.map((item) => ({
        key: item.profileId,
        label: name(item.profileId, item.kind === 'renamed' ? item.from : undefined),
        detail: item.kind === 'renamed' ? `Новое имя: ${item.to}` : 'Меняются параметры подключения',
        testable: true,
      })),
    },
    {
      title: 'Исчезнут из подписки', tone: 'warn',
      items: result.missing.map((item) => ({
        key: item.profileId,
        label: name(item.profileId, item.name),
        detail: [item.profileId === catalog.activeId ? 'Основной профиль' : '', ...item.usedBy].filter(Boolean).join(' · ') || 'В конфигурации нет ссылок на профиль',
      })),
    },
    {
      title: 'Несовместимы', tone: 'bad',
      items: result.incompatible.map((item) => ({ key: item.upstreamKey, label: item.name, detail: item.reason })),
    },
    {
      title: 'Требуют ручной замены', tone: 'warn',
      items: result.ambiguous.map((item) => ({ key: item.profileId, label: name(item.profileId) })),
    },
  ]
  const sections = groups.filter(({ items, tone }) => items.length > 0 && (result.ok || tone === 'bad'))
  const status = catalog.subscriptionStatuses.find(({ subscriptionId }) => subscriptionId === result.subscriptionId)

  return (
    <div className="space-y-4">
      <SubscriptionPreviewTime preview={result} />
      {result.ok && <SubscriptionProbeBatch controls={probes} disabled={catalog.isRefreshing(result.subscriptionId)} />}
      {!result.ok && <SubscriptionPreviewError error={result.error} status={status} />}
      {result.ok && !hasSubscriptionChanges(result) && (
        <Notice tone="ok" title="Изменений нет">Профили и их назначения сохранятся.</Notice>
      )}
      {sections.map(({ title, tone, items }) => (
        <section key={title} className="space-y-1.5">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold"><StatusDot tone={tone} /> {title} <span className="font-normal text-muted-foreground">{items.length}</span></h3>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {items.map(({ key, label, detail, testable }) => (
              <li key={key} className="flex flex-wrap items-center justify-between gap-x-2 px-3 py-2 text-[13px] [overflow-wrap:anywhere]">
                <div>
                  {label}
                  {detail && <p className="text-[12px] text-muted-foreground">{detail}</p>}
                </div>
                {testable && <SubscriptionProbe id={key} name={label} controls={probes} disabled={catalog.isRefreshing(result.subscriptionId)} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {result.changed.some((item) => item.kind === 'renamed') && (
        <p className="text-[12px] text-muted-foreground">При переименовании сохраняются псевдонимы и участие в группах.</p>
      )}
      {result.missing.length > 0 && (
        <p className="text-[12px] text-warn">Для исчезнувших профилей может понадобиться выбрать замену.</p>
      )}
    </div>
  )
}
