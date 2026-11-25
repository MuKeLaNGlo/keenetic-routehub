import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ArrowRight, ChevronRight, Ghost, PauseCircle, Play, RefreshCw, Route, Search, Star } from 'lucide-react'
import type { EngineId, Profile } from '@/api/contract'
import { api } from '@/api'
import { useCaps, useCanWrite, useRuntime, useTask, useTasks } from '@/state/resource'
import { useDraft, useDrafted } from '@/state/draft'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'
import { EmptyState, KV, Notice, Panel, Section } from '@/components/rh/layout'
import { ProbeBadge, StatusBadge } from '@/components/rh/status'
import { TruthLadder, DraftMark } from '@/components/rh/truth'
import { Mono, Segmented, SimpleSelect, TimeAgo, WriteButton } from '@/components/rh/controls'
import { Coverage, CoverageLegend, CapabilityNote } from '@/components/rh/coverage'
import { DetailSheet } from '@/components/rh/sheet'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ENGINE_LABEL, COUNTRY_FLAG, profileFormatLabel, profileFormatSummary } from '@/lib/labels'
import { count } from '@/lib/format'
import { cn } from '@/lib/utils'
import ImportModal from './import'
import { ProfileConnection } from './profile-connection'
import { ProfileRemove } from './profile-remove'
import { ExitDisclosure } from './disclosure'
import { ExitSettingRow } from './setting-row'
import {
  LIFECYCLE_META,
  TaskById,
  effectiveProbe,
  engineName,
  hasActiveProfileProbe,
  isPaused,
  originLabel,
  probeVerified,
  probeableProfiles,
  profileLabel,
  startOperation,
} from './shared'

/* ═══════════════════════ вкладка ═══════════════════════ */

type Scope = 'all' | 'subscription' | 'problems'

export default function ProfilesTab({ compact = false }: { compact?: boolean }) {
  const { config, server } = useDraft()
  const { data: rt } = useRuntime()
  const { data: tasks } = useTasks()
  const route = useRoute()
  const [q, setQ] = useState('')
  const [localScope, setScope] = useState<Scope>('all')
  const [subId, setSubId] = useState<string>('')
  const [selected, setSelected] = useState<string[]>([])
  const [taskId, setTaskId] = useState<string | null>(null)

  if (!config) return null
  const needle = q.trim().toLowerCase()
  const linkedSub = route.query.get('sub')
  const scope = linkedSub ? 'subscription' : localScope
  const effSub = linkedSub || subId || config.subscriptions[0]?.id || ''

  const groupsOf = (id: string) => config.exitGroups.filter((g) => g.memberIds.includes(id))
  const problems = (p: Profile) => {
    const s = effectiveProbe(p, rt).state
    return p.lifecycle !== 'active' || isPaused(p) || s === 'down' || s === 'degraded' || s === 'stale' || s === 'missing' || s === 'incompatible'
  }

  const list = config.profiles.filter((p) => {
    if (scope === 'problems' && !problems(p)) return false
    if (scope === 'subscription' && !(p.origin.type === 'subscription' && p.origin.subscriptionId === effSub)) return false
    if (!needle) return true
    const hay = [profileLabel(p), p.name, profileFormatSummary(p), originLabel(p, config), ENGINE_LABEL[p.adapter.engine], ...p.tags, ...groupsOf(p.id).map((g) => g.name)]
    return hay.some((x) => x.toLowerCase().includes(needle))
  })

  if (compact && server?.primaryProfileId) {
    const primaryIndex = list.findIndex((profile) => profile.id === server.primaryProfileId)
    if (primaryIndex > 0) list.unshift(...list.splice(primaryIndex, 1))
  }

  const problemCount = config.profiles.filter(problems).length
  const readyProfiles = probeableProfiles(server?.profiles)
  const batchIds = readyProfiles.filter(({ origin }) => scope !== 'subscription' ||
    (origin.type === 'subscription' && origin.subscriptionId === effSub)).map(({ id }) => id)
  const readyIds = new Set(readyProfiles.map(({ id }) => id))
  const selectedIds = selected.filter((id) => readyIds.has(id))
  const probing = hasActiveProfileProbe(tasks)
  const allSelected = list.length > 0 && list.every((p) => selected.includes(p.id))
  const toggle = (id: string, on: boolean) => setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)))

  const probe = (ids: string[]) => {
    if (!ids.length) return
    void startOperation(() => api.probeProfiles(ids), setTaskId)
  }
  const selectionActions = (
    <div className="flex flex-wrap items-center gap-2">
      <WriteButton
        variant="outline" size="sm" disabled={probing || !batchIds.length}
        reason={probing ? 'Уже идёт проверка профилей' : 'Нет сохранённых активных профилей для проверки'}
        onClick={() => probe(batchIds)}
      >
        <RefreshCw aria-hidden="true" /> {scope === 'subscription' ? 'Проверить профили подписки' : 'Проверить все профили'}
      </WriteButton>
      <Button variant="ghost" size="sm" disabled={!list.length} onClick={() => setSelected(allSelected ? [] : list.map((p) => p.id))}>
        {allSelected ? 'Снять выбор' : 'Выбрать все'}
      </Button>
      <WriteButton variant="outline" size="sm" disabled={probing || !selectedIds.length} onClick={() => probe(selectedIds)}>
        <RefreshCw aria-hidden="true" /> Проверить выбранные{selectedIds.length ? ` (${selectedIds.length})` : ''}
      </WriteButton>
    </div>
  )

  return (
    <>
      <Section
        title={compact ? undefined : 'Каталог профилей'}
        description={compact ? undefined : 'Профили любого происхождения — в одном каталоге. Задержка — время HTTPS-запроса через сам профиль; разные методы сравниваются отдельно.'}
        actions={compact ? undefined : selectionActions}
      >
        <div className={cn('mb-3 flex flex-col gap-2 sm:flex-row sm:items-center', compact && 'sm:flex-wrap')}>
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={compact ? 'Имя или протокол' : 'Имя, протокол, транспорт, группа'} className={cn('pl-8', compact && 'h-9 bg-card')} aria-label="Поиск профилей" />
          </div>
          <div className={compact ? 'min-w-0' : '-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0'}>
            <Segmented
              value={scope}
              onChange={(v) => {
                setScope(v)
                if (linkedSub && v !== 'subscription') setQuery({ sub: null })
                setSelected([])
              }}
              options={[
                { value: 'all', label: 'Все' },
                { value: 'subscription', label: 'По подписке', disabled: !config.subscriptions.length },
                { value: 'problems', label: `Проблемы${problemCount ? ` · ${problemCount}` : ''}` },
              ]}
              aria-label="Фильтр профилей"
            />
          </div>
          {scope === 'subscription' && (
            <SimpleSelect
              size="sm"
              className={cn('min-w-44', compact && 'max-w-full')}
              value={effSub || null}
              options={config.subscriptions.map((s) => ({ value: s.id, label: s.name, hint: `${count(config.profiles.filter((p) => p.origin.type === 'subscription' && p.origin.subscriptionId === s.id).length, ['профиль', 'профиля', 'профилей'])}` }))}
              onChange={(v) => {
                if (linkedSub) setQuery({ sub: v })
                setSubId(v)
                setSelected([])
              }}
              aria-label="Подписка профилей"
            />
          )}
        </div>

        {compact && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-xs text-muted-foreground">{count(list.length, ['профиль', 'профиля', 'профилей'])}</span>
            {selectionActions}
          </div>
        )}

        {list.length === 0 ? (
          <EmptyState icon={<Search />} title="Ничего не найдено">
            {scope === 'problems' ? 'Среди профилей нет ни проблемных проверок, ни изменений жизненного цикла.' : 'Измените запрос, подписку или фильтр.'}
          </EmptyState>
        ) : (
          <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            {list.map((p) => (
              <ProfileRow
                key={p.id}
                profile={p}
                groups={groupsOf(p.id).map((g) => g.name)}
                selected={selected.includes(p.id)}
                onSelect={(on) => toggle(p.id, on)}
                onOpen={() => setQuery({ p: p.id })}
                compact={compact}
              />
            ))}
          </div>
        )}

        {!compact && <p className="mt-2 text-[12px] text-muted-foreground">
          {count(list.length, ['профиль', 'профиля', 'профилей'])} показано из {config.profiles.length}. «Не проверен» — это не «работает»: результат появляется только после проверки.
        </p>}

        <AnimatePresence>
          {taskId && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }} className="mt-4">
              <TaskById id={taskId} />
            </motion.div>
          )}
        </AnimatePresence>

        {!compact && <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">
          Импорт ссылки или текста: <a className="text-foreground underline-offset-2 hover:underline" href={href('/exits', { import: '1' })}>добавить профиль вручную</a>{' '}
          — протокол определяется автоматически там, где это однозначно. Подписки обновляются отдельно, во вкладке «Подписки».
        </p>}
      </Section>

      <ImportModal open={route.query.get('import') === '1'} onClose={() => closeQuery('import')} />
      <ProfileSheet profileId={route.query.get('p')} compact={compact} />
    </>
  )
}

/* ═══════════════════════ строка списка ═══════════════════════ */

function ProfileRow({ profile: p, groups, selected, onSelect, onOpen, compact }: { profile: Profile; groups: string[]; selected: boolean; onSelect: (on: boolean) => void; onOpen: () => void; compact: boolean }) {
  const { config, server } = useDraft()
  const { data: rt } = useRuntime()
  const change = useDrafted('profiles', p.id)
  if (!config) return null
  const life = LIFECYCLE_META[p.lifecycle]
  const probe = effectiveProbe(p, rt)
  const paused = isPaused(p)
  const isPrimary = config.primaryProfileId === p.id
  const primarySaved = server?.primaryProfileId === p.id
  if (compact) return (
    <div className={cn('flex min-w-0 items-center gap-1.5 px-3', selected ? 'bg-draft/4' : 'bg-card')}>
      <Checkbox className="shrink-0" checked={selected} onCheckedChange={(value) => onSelect(value === true)} aria-label={`Выбрать профиль «${profileLabel(p)}» для проверки`} />
      <button type="button" aria-haspopup="dialog" onClick={onOpen} className="flex min-h-13 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]">{profileLabel(p)}</span>
            {primarySaved && <StatusBadge tone="ok">Основной</StatusBadge>}
            {isPrimary && !primarySaved && <StatusBadge tone="draft">Основной в черновике</StatusBadge>}
            <DraftMark change={change} />
          </span>
          <span className="block text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
            {profileFormatSummary(p)}{paused ? ' · На паузе' : ''}
          </span>
        </span>
        <span className="shrink-0 text-[12px]"><ProbeBadge probe={probe} compact /></span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  )
  return (
    <div className={cn('flex items-center gap-2 px-3 py-2.5', selected ? 'bg-draft/4' : 'bg-card')}>
      <Checkbox
        className="shrink-0"
        checked={selected}
        onCheckedChange={(v) => onSelect(v === true)}
        aria-label={`Выбрать профиль «${profileLabel(p)}» для проверки`}
      />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex-nowrap">
        <span className="w-5 shrink-0 text-center text-[16px] leading-none" aria-hidden>
          {COUNTRY_FLAG[p.country] ?? '🏳️'}
        </span>
        <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-2rem)]">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[14px] font-medium">{profileLabel(p)}</span>
            <DraftMark change={change} />
            {isPrimary && (
              <StatusBadge tone="ok" icon={<Star />}>
                основной
              </StatusBadge>
            )}
            {life && (
              <StatusBadge tone={life.tone} icon={life.tone === 'warn' ? <AlertTriangle /> : <Ghost />} dashed={life.tone === 'warn'}>
                {life.label}
              </StatusBadge>
            )}
            {paused && (
              <StatusBadge tone="warn" icon={<PauseCircle />}>
                пауза до <TimeAgo at={p.pausedUntil} />
              </StatusBadge>
            )}
            {!p.enabled && !paused && (
              <StatusBadge tone="muted" icon={<PauseCircle />}>
                отключён
              </StatusBadge>
            )}
          </div>
          <div className="truncate text-[12px] text-muted-foreground">
            {profileFormatSummary(p)}
            <span className="hidden sm:inline">
              {' · '}
              {engineName(p.adapter.engine)}
              {p.adapter.mode === 'manual' && ' (вручную)'}
            </span>
            <span className="hidden md:inline"> · {originLabel(p, config)}</span>
          </div>
          {groups.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {groups.map((g) => (
                <span key={g} className="rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 max-sm:basis-full max-sm:pl-8">
          <ProbeBadge probe={probe} />
        </div>
      </button>
    </div>
  )
}

/* ═══════════════════════ детальный лист ═══════════════════════ */

function ProfileSheet({ profileId, compact }: { profileId: string | null; compact: boolean }) {
  const { config } = useDraft()
  const p = config?.profiles.find((x) => x.id === profileId)
  return (
    <DetailSheet
      open={!!profileId}
      onClose={() => closeQuery('p')}
      title={p ? profileLabel(p) : 'Профиль не найден'}
      description={p ? `${profileFormatSummary(p)} · ${COUNTRY_FLAG[p.country] ?? '🏳️'}` : undefined}
      headerExtra={p && !compact ? <ProfileLadder profile={p} /> : undefined}
      width={compact ? 'md' : 'lg'}
    >
      {p ? (
        <ProfileDetail key={p.id} profile={p} compact={compact} />
      ) : (
        <EmptyState title="Профиль удалён из каталога">Возможно, подписка убрала его или его удалили в черновике.</EmptyState>
      )}
    </DetailSheet>
  )
}

function ProfileLadder({ profile: p }: { profile: Profile }) {
  const { server } = useDraft()
  const { data: rt } = useRuntime()
  const change = useDrafted('profiles', p.id)
  const probe = effectiveProbe(p, rt)
  return (
    <TruthLadder
      draft={!!change}
      savedRevision={server?.revision ?? null}
      active={rt ? rt.loadedRevision === server?.revision : false}
      verified={probeVerified(probe)}
      notes={{ verified: probe.measuredAt ? 'Проверено HTTPS-запросом через профиль' : 'Измерений через этот профиль ещё не было' }}
    />
  )
}

function ProfileDetail({ profile: p, compact }: { profile: Profile; compact: boolean }) {
  const { config, server, edit } = useDraft()
  const { data: rt } = useRuntime()
  const { data: caps } = useCaps()
  const can = useCanWrite()
  const [aliasDraft, setAliasDraft] = useState<string | null>(null)
  const [openSetting, setOpenSetting] = useState<'alias' | 'adapter' | 'participation' | 'connection' | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const measureTask = useTask(taskId)
  const change = useDrafted('profiles', p.id)
  if (!config) return null

  const label = profileLabel(p)
  const probe = effectiveProbe(p, rt)
  const groups = config.exitGroups.filter((g) => g.memberIds.includes(p.id))
  const isPrimary = config.primaryProfileId === p.id
  const rules = config.policies.flatMap((pol) =>
    pol.rules
      .filter(
        (r) =>
          r.action.kind === 'vpn' &&
          ((r.action.target.type === 'profile' && r.action.target.profileId === p.id) || (r.action.target.type === 'primary' && isPrimary)),
      )
      .map((r) => ({ ruleId: r.id, rule: r.name, policyId: pol.id, policy: pol.name, viaPrimary: r.action.kind === 'vpn' && r.action.target.type === 'primary' })),
  )
  const paused = isPaused(p)
  const engineOptions = [
    { value: 'auto', label: 'Автоматически', hint: 'Проверить протокол, транспорт и установленное ядро при применении' },
    ...(rt?.engines ?? []).map((e) => ({
      value: e.id,
      label: engineName(e.id),
      text: engineName(e.id),
      hint: e.installed ? `Установлено ${e.installed}` : 'Ядро не установлено',
      disabled: !e.installed,
    })),
  ]
  const udpTransport = p.protocol === 'awg' || p.protocol === 'hysteria2' || /QUIC|UDP/i.test(p.transport)

  const setPaused = (minutes: number | null) =>
    edit(minutes ? `Пауза профиля «${label}»` : `Профиль «${label}» снова активен`, (c) => {
      const x = c.profiles.find((q) => q.id === p.id)
      if (!x) return
      if (minutes) x.pausedUntil = new Date(Date.now() + minutes * 60_000).toISOString()
      else delete x.pausedUntil
    })

  const commitAlias = () => {
    if (aliasDraft === null) return
    const alias = aliasDraft.trim() || undefined
    if (alias !== p.alias) {
      edit(`Псевдоним профиля «${label}»`, (c) => {
        const x = c.profiles.find((q) => q.id === p.id)
        if (x) x.alias = alias
      })
    }
    setAliasDraft(null)
  }

  const toggleSetting = (setting: Exclude<typeof openSetting, null>) => {
    setOpenSetting((current) => current === setting ? null : setting)
  }

  const notices = (
    <>
      {p.lifecycle !== 'active' && (
        <Notice tone={p.lifecycle === 'renamed-upstream' ? 'info' : 'warn'} title={LIFECYCLE_META[p.lifecycle]?.label}>
          {p.lifecycle === 'missing-upstream' && 'Подписка больше не содержит этот профиль. Он остаётся в каталоге и в группах; новые подключения по нему невозможны, пока источник не вернёт его или вы не замените его вручную. Автоматической замены по имени нет.'}
          {p.lifecycle === 'renamed-upstream' && 'Поставщик переименовал профиль. Устойчивый ключ тот же, поэтому псевдоним, избранное и участие в группах сохранены.'}
          {p.lifecycle === 'ambiguous-replacement' && 'Найдено несколько кандидатов на замену исчезнувшего профиля. Автоматическая замена не выполняется — выберите вручную в предпросмотре подписки.'}
        </Notice>
      )}

      {!p.enabled && (
        <Notice tone="muted" title="Профиль отключён" icon={<PauseCircle />}>
          Он остаётся в каталоге и в группах, но не используется для новых подключений. <TimeAgo at={probe.measuredAt} /> — последний замер.
        </Notice>
      )}
    </>
  )

  const state = (
    <>
      <Section title="Состояние">
        <KV
          items={[
            p.xrayGroup ? ['Формат', profileFormatSummary(p)] : ['Протокол', profileFormatLabel(p)],
            ...(!p.xrayGroup && p.transport ? [['Транспорт', <Mono>{p.transport}</Mono>] as [string, ReactNode]] : []),
            ['Движок', <EngineChip profile={p} />],
            ...(compact ? [['Причина выбора', p.adapter.reason] as [string, string]] : []),
            ['Происхождение', originLabel(p, config)],
            ['Проверка', <ProbeBadge probe={probe} />],
            ['Теги', p.tags.length ? p.tags.join(', ') : '—'],
          ]}
        />
      </Section>
    </>
  )

  const host = (
    <>
      <Section title="Сервер" description="Адрес показан в маскированном виде: ключи, UUID и параметры обфускации не передаются в панель.">
        <Panel className="px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Mono>{p.server}</Mono>
            <StatusBadge tone="muted">секрет скрыт</StatusBadge>
          </div>
          {p.origin.type === 'subscription' && (
            <div className="mt-1.5 text-[12px] text-muted-foreground">
              Устойчивый ключ источника: <Mono>{p.origin.upstreamKey.replace(/[^:]+$/, '••••')}</Mono> — по нему сопоставляются переименования.
            </div>
          )}
        </Panel>
      </Section>
    </>
  )

  const adapter = (
    <>
      <Section title={compact ? undefined : 'Адаптер'} description="Какой движок исполняет профиль и почему.">
        <div className="space-y-2">
          <SimpleSelect
            aria-label={compact ? 'Ядро адаптера профиля' : undefined}
            className={compact ? 'w-full min-w-0' : undefined}
            value={p.adapter.mode === 'manual' ? p.adapter.engine : 'auto'}
            disabled={!can}
            options={engineOptions}
            onChange={(v) =>
              edit(v === 'auto' ? `Адаптер «${label}»: автоматически` : `Адаптер «${label}»: ${engineName(v as EngineId)}`, (c) => {
                const x = c.profiles.find((q) => q.id === p.id)
                if (!x) return
                x.adapter =
                  v === 'auto'
                    ? { mode: 'auto', engine: x.adapter.engine, reason: 'Автоматически: движок пересчитывается при применении по протоколу, транспорту и установленным ядрам' }
                    : { mode: 'manual', engine: v as EngineId, reason: `Выбрано вручную в панели; автоматика предложила ${engineName(p.adapter.engine)}` }
              })
            }
          />
          {!compact && (
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Почему так: </span>
              {p.adapter.reason}
            </p>
          )}
          {p.adapter.mode === 'manual' && (
            <p className="text-[12px] text-muted-foreground">Ручной выбор проверяется при применении: если ядро не поддерживает транспорт, конфигурация не будет применена и прежняя останется действующей.</p>
          )}
        </div>
      </Section>
    </>
  )

  const name = (
    <>
      <Section title={compact ? undefined : 'Имя в каталоге'}>
        <Input
          aria-label={compact ? 'Псевдоним профиля' : undefined}
          value={aliasDraft ?? p.alias ?? ''}
          placeholder={p.name}
          disabled={!can}
          onChange={(e) => setAliasDraft(e.target.value)}
          onBlur={commitAlias}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <p className="mt-1.5 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
          Настоящее имя поставщика: <Mono>{p.name}</Mono>. Псевдоним переживает переименование в подписке.
        </p>
      </Section>
    </>
  )

  const participation = (
    <>
      <Section title={compact ? undefined : 'Включение и пауза'}>
        <div className={compact ? 'divide-y' : 'divide-y overflow-hidden rounded-xl ring-1 ring-border'}>
          <div className={compact ? 'flex flex-wrap items-center justify-between gap-2 pb-2.5' : 'flex items-center justify-between gap-3 bg-card px-3.5 py-3'}>
            <span>
              <span className="block text-[13.5px]">{compact ? 'Участие в маршрутизации' : 'Профиль участвует в работе'}</span>
              {!compact && <span className="block text-[12px] text-muted-foreground">Выключенный профиль остаётся в каталоге и группах, но не используется</span>}
            </span>
            <WriteButton
              size="sm"
              variant="outline"
              disabled={p.lifecycle === 'missing-upstream'}
              reason="Профиль исчез из подписки — включать нечего"
              onClick={() =>
                edit(`${p.enabled ? 'Выключен' : 'Включён'} профиль «${label}»`, (c) => {
                  const x = c.profiles.find((q) => q.id === p.id)
                  if (x) x.enabled = !x.enabled
                })
              }
            >
              {p.enabled ? <PauseCircle /> : <Play />}
              {p.enabled ? 'Отключить' : 'Включить'}
            </WriteButton>
          </div>
          <div className={compact ? 'flex flex-wrap items-center justify-between gap-2 pt-2.5' : 'flex flex-wrap items-center justify-between gap-3 bg-card px-3.5 py-3'}>
            <span>
              <span className="block text-[13.5px]">Временная пауза</span>
              {!compact && <span className="block text-[12px] text-muted-foreground">{paused ? <>Снимется автоматически <TimeAgo at={p.pausedUntil} /></> : 'Не использовать профиль ограниченное время, не выключая его в группах'}</span>}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {paused ? (
                <WriteButton size="sm" variant="outline" onClick={() => setPaused(null)}>
                  Снять паузу
                </WriteButton>
              ) : (
                <>
                  <WriteButton size="sm" variant="outline" onClick={() => setPaused(15)}>
                    15 мин
                  </WriteButton>
                  <WriteButton size="sm" variant="outline" onClick={() => setPaused(60)}>
                    1 час
                  </WriteButton>
                </>
              )}
            </div>
          </div>
        </div>
      </Section>
    </>
  )

  const primary = (
    <>
      <Section title="Основной профиль" description="Используется там, где политика выбирает «основной профиль».">
        {isPrimary ? (
          <div className="flex items-center gap-2 rounded-xl bg-ok/8 px-3.5 py-3 ring-1 ring-ok/20">
            <Star className="size-4 text-ok" />
            <span className="text-[13px]">Сейчас основной профиль сети.</span>
          </div>
        ) : (
          <WriteButton
            variant="outline"
            disabled={!p.enabled}
            reason="Отключённый профиль не может быть основным"
            onClick={() => edit(`Основной профиль: «${label}»`, (c) => void (c.primaryProfileId = p.id))}
          >
            <Star /> Сделать основным
          </WriteButton>
        )}
      </Section>
    </>
  )

  const usage = (
    <>
      <Section title="Где используется" description="Группы и правила, которые выбирают этот профиль. Изменения не должны разорвать эти ссылки.">
        {groups.length === 0 && rules.length === 0 && !isPrimary ? (
          <p className="text-[13px] text-muted-foreground">Ни одна группа и ни одно правило не ссылаются на этот профиль.</p>
        ) : (
          <div className="space-y-2">
            {isPrimary && (
              <div className="flex items-center gap-2 text-[13px]">
                <StatusBadge tone="ok" icon={<Star />}>основной</StatusBadge>
                <span className="text-muted-foreground">действие «Основной профиль» в правилах и политиках</span>
              </div>
            )}
            {groups.map((g) => (
              <a key={g.id} href={href(compact ? '/exits-preview' : '/exits', { tab: 'groups', g: g.id })} className="pressable flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-[13px] ring-1 ring-border hover:bg-surface-2">
                <ArrowRight className="size-3.5 text-muted-foreground" />
                Группа «{g.name}»
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {g.memberIds.indexOf(p.id) + 1} из {g.memberIds.length}
                </span>
              </a>
            ))}
            {rules.map((r) => (
              <a key={`${r.policyId}/${r.ruleId}`} href={href(compact ? '/rules-preview' : '/rules', { policy: r.policyId, rule: compact ? r.ruleId : null })} className="pressable flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-[13px] ring-1 ring-border hover:bg-surface-2">
                <ArrowRight className="size-3.5 text-muted-foreground" />
                Правило «{r.rule}»
                {r.viaPrimary && <StatusBadge tone="muted">через основной</StatusBadge>}
                <span className="ml-auto text-[12px] text-muted-foreground">политика «{r.policy}»</span>
              </a>
            ))}
          </div>
        )}
      </Section>
    </>
  )

  const coverage = (
    <>
      {caps && (
        <Section title="Покрытие" description="Что подтверждено трафиком на этой установке для путей этого профиля.">
          <Coverage coverage={caps.interception.coverage} size="md" />
          <div className="mt-3">
            <CoverageLegend />
          </div>
          {udpTransport && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
              Профиль работает по UDP. Прозрачный перехват UDP на этой установке — «частично»: только через TPROXY и локальный SOCKS5, и это не проверено на KN‑3811. TCP-пути профиля от этого не зависят.
            </p>
          )}
          <div className="mt-3">
            <CapabilityNote availability={caps.ipv6}>IPv6</CapabilityNote>
          </div>
        </Section>
      )}
    </>
  )

  const trace = (
    <>
      <a href={href('/trace')} className="pressable flex items-center gap-3 rounded-xl bg-info/8 px-3.5 py-3 text-[13.5px] ring-1 ring-info/20 hover:bg-info/12">
        <Route className="size-4 text-info" />
        <span className="flex-1">
          <span className="font-medium">Почему так?</span> <span className="text-muted-foreground">Объяснить, куда пойдёт трафик и какой выход выберется</span>
        </span>
        <ArrowRight className="size-4 text-muted-foreground" />
      </a>
    </>
  )


  if (!compact) return (
    <div className="space-y-7">
      {notices}{state}{host}{adapter}{name}{participation}{primary}{usage}{coverage}{trace}
    </div>
  )

  const availability = probe.state === 'incompatible' ? 'Профиль несовместим с ядром'
    : p.lifecycle === 'missing-upstream' ? 'Профиль исчез из подписки'
    : paused ? 'Профиль на паузе'
    : !p.enabled ? 'Профиль отключён'
    : rt?.engines.some((engine) => engine.id === p.adapter.engine && !engine.installed) ? 'Ядро не установлено'
    : undefined
  const persisted = server?.profiles.some((item) => item.id === p.id)
  const primarySaved = server?.primaryProfileId === p.id
  const primaryInDraft = isPrimary && !primarySaved
  const measuringNow = measuring || measureTask?.state === 'pending' || measureTask?.state === 'running' || probe.state === 'probing'

  async function measure() {
    setMeasuring(true)
    try {
      await startOperation(() => api.probeProfiles([p.id]), setTaskId)
    } finally {
      setMeasuring(false)
    }
  }

  return (
    <div className="space-y-3">
      <Panel className="space-y-2 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <ProbeBadge probe={probe} />
          {probe.state === 'stale' && <span className="text-xs text-warn">Замер устарел</span>}
          {primarySaved && <StatusBadge tone="ok">Основной</StatusBadge>}
          {primaryInDraft && <StatusBadge tone="draft">Основной в черновике</StatusBadge>}
          {!!change && <StatusBadge tone="draft">Черновик</StatusBadge>}
        </div>
        {availability && <p className="text-xs text-muted-foreground">{availability}{paused && <> до <TimeAgo at={p.pausedUntil} /></>}</p>}
        {p.lifecycle === 'ambiguous-replacement' && <p className="text-xs text-warn">Выберите замену в предпросмотре подписки.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="min-h-8" disabled={!persisted || !!availability || measuringNow} onClick={() => void measure()}>
            <RefreshCw className={measuringNow ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
            {measuringNow ? 'Измеряем…' : 'Измерить задержку'}
          </Button>
          {!isPrimary && <WriteButton size="sm" className="min-h-8" disabled={!!availability} reason={availability}
            onClick={() => edit(`Основной профиль: «${label}»`, (current) => void (current.primaryProfileId = p.id))}
          ><Star aria-hidden="true" /> Сделать основным</WriteButton>}
          {paused && <WriteButton variant="outline" size="sm" className="min-h-8" onClick={() => setPaused(null)}>Снять паузу</WriteButton>}
        </div>
        {!persisted && <p className="text-xs text-muted-foreground">Измерение доступно после применения профиля.</p>}
      </Panel>
      {taskId && <TaskById id={taskId} />}
      <Panel className="divide-y divide-border">
        <ExitSettingRow label="Псевдоним" value={p.alias || 'Не задан'} open={can && openSetting === 'alias'} onToggle={() => toggleSetting('alias')}>
          {name}
        </ExitSettingRow>
        {persisted && p.origin.type !== 'subscription' && api.replaceProfileConnection && <ExitSettingRow
          label="Параметры подключения"
          value={profileFormatLabel(p)}
          open={can && openSetting === 'connection'}
          onToggle={() => toggleSetting('connection')}
        >
          <ProfileConnection profile={p} />
        </ExitSettingRow>}
        {caps?.features?.engineSelection?.available !== false && <ExitSettingRow
          label="Адаптер"
          value={`${engineName(p.adapter.engine)} · ${p.adapter.mode === 'auto' ? 'автоматически' : 'вручную'}`}
          open={can && openSetting === 'adapter'}
          onToggle={() => toggleSetting('adapter')}
        >
          {adapter}
        </ExitSettingRow>}
        {caps?.features?.profilePause?.available !== false && <ExitSettingRow
          label="Включение и пауза"
          value={<>{p.enabled ? 'Включён' : 'Отключён'}{paused && <> · пауза <TimeAgo at={p.pausedUntil} /></>}</>}
          open={can && openSetting === 'participation'}
          onToggle={() => toggleSetting('participation')}
        >
          {participation}
        </ExitSettingRow>}
      </Panel>
      <ExitDisclosure title="Сервер и покрытие">
        <ProfileLadder profile={p} />
        {state}{host}{coverage}
      </ExitDisclosure>
      <ExitDisclosure title="Где используется">
        {usage}
      </ExitDisclosure>
      <a href={href('/trace-preview')} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-[13px] text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        <Route className="size-4" aria-hidden="true" /> Проверить маршрут <ArrowRight className="size-3.5" aria-hidden="true" />
      </a>
      {persisted && api.replaceProfileConnection && <ProfileRemove profile={p} onRemoved={() => closeQuery('p')} />}
    </div>
  )
}

function EngineChip({ profile: p }: { profile: Profile }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{engineName(p.adapter.engine)}</span>
      <StatusBadge tone={p.adapter.mode === 'manual' ? 'info' : 'muted'} dashed={p.adapter.mode === 'auto'}>
        {p.adapter.mode === 'manual' ? 'выбрано вручную' : 'автоматически'}
      </StatusBadge>
    </span>
  )
}
