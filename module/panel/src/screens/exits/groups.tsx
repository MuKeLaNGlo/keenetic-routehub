import { useEffect, useState, type ReactNode } from 'react'
import { Reorder, useDragControls } from 'motion/react'
import { AlertTriangle, ArrowRight, ChevronRight, GripVertical, Pin, RefreshCw, ShieldQuestion } from 'lucide-react'
import type { Capabilities, Config, ExitGroup, ExitGroupRuntime, GroupMode, Profile } from '@/api/contract'
import { api } from '@/api'
import { useCaps, useCanWrite, useRuntime, useTask } from '@/state/resource'
import { useDraft, useDrafted } from '@/state/draft'
import { closeQuery, href, setQuery, useRoute } from '@/state/router'
import { EmptyState, KV, Notice, Panel, Section } from '@/components/rh/layout'
import { ProbeBadge, StatusBadge } from '@/components/rh/status'
import { TruthLadder, DraftMark } from '@/components/rh/truth'
import { Mono, Segmented, SimpleSelect, TimeAgo, WriteButton } from '@/components/rh/controls'
import { DetailSheet } from '@/components/rh/sheet'
import { Input } from '@/components/ui/input'
import { SavingSwitch } from '@/components/ui/switch'
import { COUNTRY_FLAG } from '@/lib/labels'
import { count } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ExitDisclosure } from './disclosure'
import { ExitSettingRow } from './setting-row'
import { effectiveProbe, profileLabel, startOperation, TaskById } from './shared'

/* ═══════════════════════ вкладка ═══════════════════════ */

export default function GroupsTab({ compact = false }: { compact?: boolean }) {
  const { config } = useDraft()
  const { data: rt } = useRuntime()
  const openId = useRoute().query.get('g')
  if (!config) return null

  return (
    <>
      <Section
        title={compact ? undefined : 'Группы выходов'}
        description={compact ? undefined : 'Группа выбирает рабочий профиль из разрешённых кандидатов и хранит причину выбора. Профили разных источников можно смешивать в одной группе.'}
      >
        {config.exitGroups.length === 0 ? (
          <EmptyState icon={<ShieldQuestion />} title="Групп пока нет">
            {!compact && 'Группа нужна, чтобы трафик переключался между профилями при отказе или выбирал лучший из подтверждённых.'}
          </EmptyState>
        ) : (
          <div className={compact ? 'divide-y divide-border overflow-hidden rounded-xl border border-border bg-card' : 'space-y-3'}>
            {config.exitGroups.map((g) => (
              <GroupCard key={g.id} group={g} runtime={rt?.groups[g.id]} config={config} onOpen={() => setQuery({ g: g.id })} compact={compact} />
            ))}
          </div>
        )}
      </Section>

      <GroupSheet groupId={openId} compact={compact} />
    </>
  )
}

const MODE: Record<GroupMode, { label: string; hint: string }> = {
  manual: { label: 'Вручную', hint: 'Работает закреплённый профиль или первый доступный по порядку. Автоматика не переключает.' },
  failover: { label: 'По порядку', hint: 'Следующий доступный по порядку списка. Переключение — после серии неудачных проверок.' },
  best: { label: 'Лучший', hint: 'Наиболее подходящий из подтверждённых: стабильность, потери, задержка и разброс, с минимальным преимуществом.' },
}

type FailKind = ExitGroup['failAction']['kind']

const groupState: Record<ExitGroupRuntime['state'], { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  ok: { label: 'Работает', tone: 'ok' },
  degraded: { label: 'Переключается', tone: 'warn' },
  failed: { label: 'Отказ', tone: 'bad' },
}

const FAIL_OPTION: Record<FailKind, { label: string; shortLabel: string; hint: string }> = {
  suspend: {
    label: 'Приостановить новые подключения (по умолчанию)',
    shortLabel: 'Приостановить подключения',
    hint: 'Роутер продолжает обслуживать локальную сеть и правила других сайтов. Новые подключения по правилам этой группы не устанавливаются.',
  },
  direct: {
    label: 'Временный прямой выход',
    shortLabel: 'Временный прямой выход',
    hint: 'Разрешить явный резерв через выбранный физический выход. В диагностике видно, что действует резерв и с какого времени.',
  },
  group: {
    label: 'Другая группа',
    shortLabel: 'Другая группа',
    hint: 'Передавать новые подключения в другую доступную группу. Если и она недоступна, сработает её собственное действие при отказе.',
  },
}

function failActionLabel(a: ExitGroup['failAction'], config: Config, caps: Capabilities | undefined): string {
  if (a.kind === 'suspend') return 'приостановить новые подключения'
  if (a.kind === 'direct') return `прямой резерв · ${caps?.ispUplinks.find((u) => u.id === a.uplinkId)?.name ?? a.uplinkId}`
  return `перейти в группу «${config.exitGroups.find((g) => g.id === a.groupId)?.name ?? a.groupId}»`
}

/* ═══════════════════════ карточка группы ═══════════════════════ */

function GroupCard({ group: g, runtime, config, onOpen, compact }: { group: ExitGroup; runtime: ExitGroupRuntime | undefined; config: Config; onOpen: () => void; compact: boolean }) {
  const { data: rt } = useRuntime()
  const { data: caps } = useCaps()
  const change = useDrafted('exitGroups', g.id)
  const selected = runtime?.selectedProfileId ? config.profiles.find((p) => p.id === runtime.selectedProfileId) : undefined
  const failed = runtime?.state === 'failed' && !!runtime.fallback
  const pinId = g.pin?.profileId
  const pinProfile = pinId ? config.profiles.find((p) => p.id === pinId) : undefined
  const state = runtime ? groupState[runtime.state] : undefined

  if (compact) return (
    <button type="button" aria-haspopup="dialog" onClick={onOpen} className="flex min-h-[66px] w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="min-w-0 text-[13.5px] font-semibold [overflow-wrap:anywhere]">{g.name}</span>
          <DraftMark change={change} />
        </span>
        <span className="block text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
          {runtime?.state === 'failed' ? runtime.fallback?.description ?? 'Нет доступного выхода' : selected ? profileLabel(selected) : 'Выход не выбран'}
        </span>
        <span className="block text-[11.5px] text-muted-foreground">{MODE[g.mode].label} · {count(g.memberIds.length, ['кандидат', 'кандидата', 'кандидатов'])}{g.pin ? ' · закреплён' : ''}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
        <StatusBadge tone={state?.tone ?? 'muted'}>{state?.label ?? 'Нет данных'}</StatusBadge>
        {selected && runtime?.state !== 'failed' && <ProbeBadge probe={effectiveProbe(selected, rt)} compact />}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  )

  return (
    <Panel className="overflow-hidden">
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[15px] font-semibold">{g.name}</span>
            <DraftMark change={change} />
            <StatusBadge tone="muted">{MODE[g.mode].label}</StatusBadge>
            {g.pin && (
              <StatusBadge tone="warn" icon={<Pin />}>
                {pinProfile ? profileLabel(pinProfile) : 'закреплено'}
                {g.pin.until ? ` до ${new Date(g.pin.until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ' · до отмены'}
              </StatusBadge>
            )}
            {runtime?.state === 'degraded' && <StatusBadge tone="warn">идёт переключение</StatusBadge>}
            {failed && (
              <StatusBadge tone="bad" icon={<AlertTriangle />}>
                отказ
              </StatusBadge>
            )}
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            {count(g.memberIds.length, ['кандидат', 'кандидата', 'кандидатов'])} · при отказе — {failActionLabel(g.failAction, config, caps)}
          </div>
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </button>

      <div className="border-t px-3.5 py-2.5">
        <div className="divide-y divide-border/70">
          {g.memberIds.map((id) => {
            const p = config.profiles.find((x) => x.id === id)
            if (!p) return null
            return (
              <div key={id} className="flex items-center gap-2.5 py-1.5">
                <span className="w-4 text-center text-[14px]" aria-hidden>
                  {COUNTRY_FLAG[p.country] ?? '🏳️'}
                </span>
                <span className={cn('min-w-0 flex-1 truncate text-[13px]', id === runtime?.selectedProfileId && 'font-medium')}>{profileLabel(p)}</span>
                {id === runtime?.selectedProfileId && <StatusBadge tone="ok">выбран</StatusBadge>}
                <ProbeBadge probe={effectiveProbe(p, rt)} />
              </div>
            )
          })}
        </div>
        {runtime && (
          <div className="mt-1.5 border-t pt-2 text-[12px] leading-relaxed text-muted-foreground">
            {selected ? (
              <>
                <span className="font-medium text-foreground">{profileLabel(selected)}</span> · {runtime.reason} · <TimeAgo at={runtime.since} />
              </>
            ) : (
              <>Никто не выбран · {runtime.reason}</>
            )}
          </div>
        )}
      </div>

      {failed && (
        <div className="px-3.5 pb-3">
          <FallbackNotice group={g} runtime={runtime} config={config} />
        </div>
      )}
    </Panel>
  )
}

/** Громкое объяснение: что именно происходит сейчас при отказе группы. */
function FallbackNotice({ group: g, runtime, config }: { group: ExitGroup; runtime: ExitGroupRuntime | undefined; config: Config }) {
  const { data: caps } = useCaps()
  const fallback = runtime?.fallback
  if (!fallback) return null
  const affectedRules = config.policies.flatMap((pol) =>
    pol.rules.filter((r) => r.action.kind === 'vpn' && r.action.target.type === 'group' && r.action.target.groupId === g.id).map((r) => r.name),
  )
  const directRules = config.policies
    .flatMap((pol) => pol.rules.filter((r) => r.action.kind === 'direct').map((r) => r.name))
    .slice(0, 2)

  return (
    <Notice tone="bad" title={`Группа недоступна — ${fallback.description}`}>
      <p>
        {fallback.reason}. С <TimeAgo at={fallback.since} />.
      </p>
      {g.failAction.kind === 'suspend' ? (
        <p className="mt-1">
          Новые подключения по правилам этой группы ({affectedRules.length ? affectedRules.slice(0, 3).map((n) => `«${n}»`).join(', ') : 'правил нет'}) приостанавливаются. Локальная сеть и
          остальные правила продолжают работать
          {directRules.length
            ? `: ${directRules.map((n) => `«${n}»`).join(', ')} по-прежнему идут напрямую.`
            : '; прямое правило другого сайта не затронуто.'}
        </p>
      ) : (
        <p className="mt-1">Новые подключения идут запасным маршрутом: {failActionLabel(g.failAction, config, caps)}. Остальные правила, включая прямые, не меняются.</p>
      )}
    </Notice>
  )
}

/* ═══════════════════════ детальный лист ═══════════════════════ */

function GroupSheet({ groupId, compact }: { groupId: string | null; compact: boolean }) {
  const { config } = useDraft()
  const { data: rt } = useRuntime()
  const g = config?.exitGroups.find((x) => x.id === groupId)
  return (
    <DetailSheet
      fixedMobileHeight
      open={!!groupId}
      onClose={() => closeQuery('g')}
      title={g ? g.name : 'Группа не найдена'}
      description={g ? `${MODE[g.mode].label} · ${count(g.memberIds.length, ['кандидат', 'кандидата', 'кандидатов'])}` : undefined}
      headerExtra={g && !compact ? <GroupLadder group={g} runtime={rt?.groups[g.id]} /> : undefined}
      width={compact ? 'md' : 'lg'}
    >
      {g ? <GroupDetail key={g.id} group={g} compact={compact} /> : <EmptyState title="Группа удалена">Возможно, её убрали в черновике.</EmptyState>}
    </DetailSheet>
  )
}

function GroupLadder({ group: g, runtime }: { group: ExitGroup; runtime: ExitGroupRuntime | undefined }) {
  const { server } = useDraft()
  const { data: rt } = useRuntime()
  const change = useDrafted('exitGroups', g.id)
  const verified: 'ok' | 'fail' | 'partial' | 'untested' | 'na' = !runtime ? 'untested' : runtime.state === 'ok' ? 'ok' : runtime.state === 'degraded' ? 'partial' : 'fail'
  return (
    <TruthLadder
      draft={!!change}
      savedRevision={server?.revision ?? null}
      active={rt ? rt.loadedRevision === server?.revision : false}
      verified={verified}
      notes={{ verified: runtime ? `Последний выбор: ${runtime.reason}` : 'Группа ещё не выбирала профиль' }}
    />
  )
}

function GroupDetail({ group: g, compact }: { group: ExitGroup; compact: boolean }) {
  const { config, server, edit } = useDraft()
  const { data: rt } = useRuntime()
  const { data: caps } = useCaps()
  const can = useCanWrite()
  const [taskId, setTaskId] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [openSetting, setOpenSetting] = useState<'mode' | 'failure' | 'probes' | 'thresholds' | 'revert' | null>(null)
  const measureTask = useTask(taskId)
  const change = useDrafted('exitGroups', g.id)
  if (!config) return null

  const runtime = rt?.groups[g.id]
  const selected = runtime?.selectedProfileId ? config.profiles.find((p) => p.id === runtime.selectedProfileId) : undefined
  const otherGroups = config.exitGroups.filter((x) => x.id !== g.id)
  const failed = runtime?.state === 'failed' && !!runtime.fallback
  const pinId = g.pin?.profileId
  const pinProfile = pinId ? config.profiles.find((p) => p.id === pinId) : undefined
  const toggleSetting = (setting: Exclude<typeof openSetting, null>) =>
    setOpenSetting((current) => current === setting ? null : setting)

  const patch = (label: string, fn: (x: ExitGroup) => void) =>
    edit(label, (c) => {
      const x = c.exitGroups.find((q) => q.id === g.id)
      if (x) fn(x)
    })

  const setFailKind = (kind: FailKind) => {
    if (kind === g.failAction.kind) return
    if (kind === 'group' && !otherGroups.length) return
    patch(`Отказ группы «${g.name}»: ${FAIL_OPTION[kind].label}`, (x) => {
      if (kind === 'suspend') x.failAction = { kind: 'suspend' }
      else if (kind === 'direct') x.failAction = { kind: 'direct', uplinkId: caps?.ispUplinks[0]?.id ?? 'isp-main' }
      else x.failAction = { kind: 'group', groupId: otherGroups[0].id }
    })
  }

  const fallbackNotice = (
    <>
      {failed && runtime && <FallbackNotice group={g} runtime={runtime} config={config} />}
    </>
  )

  const current = (
    <>
      <Section title="Что происходит сейчас" description="Действующее решение группы, а не её настройка.">
        <KV
          items={[
            [
              'Выбранный профиль',
              selected ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span aria-hidden>{COUNTRY_FLAG[selected.country] ?? '🏳️'}</span>
                  {profileLabel(selected)}
                  <ProbeBadge probe={effectiveProbe(selected, rt)} />
                </span>
              ) : (
                <span className="text-warn">никто — {runtime?.reason ?? 'нет данных'}</span>
              ),
            ],
            ['Почему', runtime?.reason ?? '—'],
            ['С какого времени', runtime ? <TimeAgo at={runtime.since} /> : '—'],
            [
              'Состояние',
              runtime ? (
                <StatusBadge tone={runtime.state === 'ok' ? 'ok' : runtime.state === 'degraded' ? 'warn' : 'bad'}>
                  {runtime.state === 'ok' ? 'работает' : runtime.state === 'degraded' ? 'переключается' : 'отказ'}
                </StatusBadge>
              ) : (
                <StatusBadge tone="muted" dashed>
                  нет данных
                </StatusBadge>
              ),
            ],
            [
              'Закрепление',
              g.pin
                ? `${pinProfile ? profileLabel(pinProfile) : g.pin.profileId}${g.pin.until ? ` до ${new Date(g.pin.until).toLocaleString('ru-RU')}` : ' — до отмены'}`
                : 'нет',
            ],
          ]}
        />
      </Section>
    </>
  )

  const mode = (
    <>
      <Section title={compact ? undefined : 'Режим выбора'} description={MODE[g.mode].hint}>
        <Segmented
          value={g.mode}
          onChange={(m) => m !== g.mode && patch(`Режим группы «${g.name}»: ${MODE[m].label}`, (x) => void (x.mode = m))}
          options={(Object.keys(MODE) as GroupMode[]).map((m) => ({ value: m, label: MODE[m].label, hint: MODE[m].hint, disabled: !can }))}
          aria-label="Режим выбора профиля"
          size={compact ? 'sm' : 'md'}
          className={compact ? 'max-w-full flex-wrap' : undefined}
        />
        {compact && <p className="mt-1.5 text-xs text-muted-foreground">{MODE[g.mode].hint}</p>}
        {!compact && <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {g.mode === 'manual'
            ? 'Порядок профилей сохраняется, но автоматика не переключает группу: работает закреплённый или первый доступный профиль.'
            : g.mode === 'failover'
              ? 'Переключение происходит после серии неудачных проверок; пауза между сменами защищает от «мигания».'
              : 'Выбор учитывает медиану, разброс и потери по серии проб; смена требует минимального преимущества.'}{' '}
          Причина последнего выбора видна в журнале и в проверке маршрута.
        </p>}
      </Section>
    </>
  )

  const members = (
    <>
      <Section title="Кандидаты" description="Перетащите профиль, чтобы изменить приоритет.">
        <MemberList group={g} compact={compact} />
        {g.autoInclude && (
          <div className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
            Автосостав: подписка «{config.subscriptions.find((s) => s.id === g.autoInclude!.subscriptionId)?.name ?? g.autoInclude.subscriptionId}», фильтр{' '}
            {g.autoInclude.filter}. Будущие узлы {g.autoInclude.includeFuture ? 'включаются автоматически' : 'не включаются без явного разрешения'} — итоговый состав показан выше.
          </div>
        )}
      </Section>
    </>
  )

  const probeAddress = (
    <div className={compact ? undefined : 'rounded-lg px-3 py-2 ring-1 ring-border'}>
      <div className="text-[12px] text-muted-foreground">Адрес проверки</div>
      <Mono className="break-all">{g.probe.url}</Mono>
      <div className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        Метод — HTTPS через профиль. TCP, ICMP и рукопожатие сравниваются отдельно и не смешиваются с этим результатом.
      </div>
    </div>
  )

  const scheduleField = compact ? 'grid min-w-0 gap-1' : 'flex items-center justify-between gap-3 rounded-lg px-3 py-2 ring-1 ring-border'
  const probeSchedule = (
    <>
      <label className={scheduleField}>
        <span className="text-[12.5px] text-muted-foreground">Интервал</span>
        <SimpleSelect
          size="sm"
          className={compact ? 'w-full min-w-0' : 'min-w-28'}
          aria-label={compact ? 'Интервал проверки' : undefined}
          disabled={!can}
          value={String(g.probe.intervalSec)}
          options={[
            { value: '30', label: '30 с' },
            { value: '60', label: '1 мин' },
            { value: '120', label: '2 мин' },
            { value: '300', label: '5 мин' },
            { value: '600', label: '10 мин' },
          ]}
          onChange={(v) => patch(`Интервал проверки группы «${g.name}»`, (x) => void (x.probe.intervalSec = Number(v)))}
        />
      </label>
      <label className={scheduleField}>
        <span className="text-[12.5px] text-muted-foreground">Проб в серии</span>
        <SimpleSelect
          size="sm"
          className={compact ? 'w-full min-w-0' : 'min-w-28'}
          aria-label={compact ? 'Проб в серии' : undefined}
          disabled={!can}
          value={String(g.probe.samples)}
          options={[
            { value: '3', label: '3' },
            { value: '5', label: '5' },
            { value: '7', label: '7' },
          ]}
          onChange={(v) => patch(`Проб в серии группы «${g.name}»`, (x) => void (x.probe.samples = Number(v)))}
        />
      </label>
    </>
  )

  const probeThresholds = (
    <>
      <NumberRow
        compact={compact}
        label="Минимальное преимущество"
        value={g.probe.minAdvantageMs}
        suffix="мс"
        disabled={!can}
        onCommit={(n) => patch(`Преимущество группы «${g.name}»`, (x) => void (x.probe.minAdvantageMs = n))}
      />
      <NumberRow
        compact={compact}
        label="Пауза между сменами"
        value={g.probe.switchPauseSec}
        suffix="с"
        disabled={!can}
        onCommit={(n) => patch(`Пауза смены группы «${g.name}»`, (x) => void (x.probe.switchPauseSec = n))}
      />
      <NumberRow
        compact={compact}
        label="Порог отказа"
        value={g.probe.failThreshold}
        suffix="проб"
        disabled={!can}
        onCommit={(n) => patch(`Порог отказа группы «${g.name}»`, (x) => void (x.probe.failThreshold = Math.max(1, n)))}
      />
    </>
  )

  const probeLimit = (
    <p className={cn('text-[11.5px] leading-relaxed text-muted-foreground', !compact && 'px-3 py-2 ring-1 ring-border sm:col-span-2')}>
      Проверка идёт через сам профиль, с явным выходом. Лимит одновременных проверок ограничен на роутере; отложенная проверка не считается успешной.
    </p>
  )

  const probes = (
    <Section title="Проверки" description="Как группа проверяет кандидатов, прежде чем выбрать.">
      <div className="space-y-2">
        {probeAddress}
        <div className="grid gap-2 sm:grid-cols-2">
          {probeSchedule}{probeThresholds}{probeLimit}
        </div>
      </div>
    </Section>
  )

  const revert = (
    <>
      <Section title={compact ? undefined : 'Возврат к предпочтительному'}>
        <label className={cn('flex items-center justify-between gap-3', !compact && 'rounded-xl px-3.5 py-3 ring-1 ring-border')}>
          <span>
            <span className="block text-[13.5px]">Возвращаться к первому приоритетному профилю</span>
            {!compact && <span className="block text-[12px] text-muted-foreground">После серии успешных проверок, с задержкой — чтобы не дёргать маршрут</span>}
          </span>
          <SavingSwitch
            checked={g.revertToPreferred.enabled}
            disabled={!can}
            onSave={(v) => patch(`${v ? 'Включён' : 'Выключен'} возврат группы «${g.name}»`, (x) => void (x.revertToPreferred.enabled = v))}
          />
        </label>
        {g.revertToPreferred.enabled && (
          <div className={cn('mt-2 grid', compact ? 'divide-y divide-border' : 'gap-2 sm:grid-cols-2')}>
            <NumberRow
              compact={compact}
              label="Задержка"
              value={g.revertToPreferred.delaySec}
              suffix="с"
              disabled={!can}
              onCommit={(n) => patch(`Задержка возврата группы «${g.name}»`, (x) => void (x.revertToPreferred.delaySec = n))}
            />
            <NumberRow
              compact={compact}
              label="Успешных подряд"
              value={g.revertToPreferred.successStreak}
              suffix="проб"
              disabled={!can}
              onCommit={(n) => patch(`Порог возврата группы «${g.name}»`, (x) => void (x.revertToPreferred.successStreak = Math.max(1, n)))}
            />
          </div>
        )}
      </Section>
    </>
  )

  const failure = (
    <>
      <Section title={compact ? undefined : 'При отказе группы'} description="Что делать, когда ни один кандидат не проходит проверку.">
        {compact ? (
          <SimpleSelect
            aria-label="Действие при отказе группы"
            className="w-full min-w-0"
            value={g.failAction.kind}
            options={(Object.keys(FAIL_OPTION) as FailKind[]).map((kind) => ({
              value: kind,
              label: FAIL_OPTION[kind].shortLabel,
              hint: kind === 'group' && !otherGroups.length ? 'Других групп нет' : FAIL_OPTION[kind].hint,
              disabled: kind === 'group' && !otherGroups.length,
            }))}
            disabled={!can}
            onChange={(kind) => setFailKind(kind as FailKind)}
          />
        ) : (
          <div role="radiogroup" className="grid gap-2">
            {(Object.keys(FAIL_OPTION) as FailKind[]).map((k) => {
              const active = g.failAction.kind === k
              const disabled = !can || (k === 'group' && !otherGroups.length)
              return (
                <button
                  key={k}
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => setFailKind(k)}
                  className={cn(
                    'pressable flex items-start gap-3 rounded-xl bg-card px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60',
                    active ? 'ring-2 ring-foreground' : 'ring-1 ring-border hover:bg-surface-2',
                  )}
                >
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1', active ? 'bg-foreground ring-foreground' : 'ring-muted-foreground/40')}>
                    {active && <span className="size-1.5 rounded-full bg-background" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium">{FAIL_OPTION[k].label}</span>
                    <span className="block text-[12.5px] leading-relaxed text-muted-foreground">
                      {k === 'group' && !otherGroups.length ? 'Других групп нет — действие недоступно.' : FAIL_OPTION[k].hint}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {g.failAction.kind === 'direct' && (
          <div className="mt-3 space-y-1.5">
            <div className="text-[13px] font-medium">Физический выход для резерва</div>
            <SimpleSelect
              className={compact ? 'w-full min-w-0' : 'w-full'}
              aria-label={compact ? 'Физический выход для резерва' : undefined}
              disabled={!can}
              value={g.failAction.uplinkId}
              options={(caps?.ispUplinks ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.iface }))}
              onChange={(v) => patch(`Резервный выход группы «${g.name}»`, (x) => void (x.failAction = { kind: 'direct', uplinkId: v }))}
            />
            {!compact && <p className="text-[12px] leading-relaxed text-muted-foreground">
              Резерв разрешён явно для этой группы и будет виден в диагностике как временный прямой выход — с причиной и временем начала.
            </p>}
          </div>
        )}

        {g.failAction.kind === 'group' && (
          <div className="mt-3 space-y-1.5">
            <div className="text-[13px] font-medium">Куда переводить новые подключения</div>
            <SimpleSelect
              className={compact ? 'w-full min-w-0' : 'w-full'}
              aria-label={compact ? 'Группа для новых подключений' : undefined}
              disabled={!can}
              value={g.failAction.groupId}
              options={otherGroups.map((x) => ({
                value: x.id,
                label: x.name,
                hint: `${MODE[x.mode].label} · ${count(x.memberIds.length, ['кандидат', 'кандидата', 'кандидатов'])}`,
              }))}
              onChange={(v) => patch(`Запасная группа «${g.name}»`, (x) => void (x.failAction = { kind: 'group', groupId: v }))}
            />
          </div>
        )}

        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          {compact ? 'Действие применяется к новым подключениям. Активные сессии зависят от возможностей адаптера.' : (
            <>Сейчас при отказе: {failActionLabel(g.failAction, config, caps)}. Активные сессии не перенаправляются автоматически: новые соединения получают новый маршрут,
            существующие — по возможностям адаптера.</>
          )}
        </p>
      </Section>
    </>
  )

  const trace = (
    <>
      <a href={href('/trace')} className="pressable flex items-center gap-3 rounded-xl bg-info/8 px-3.5 py-3 text-[13.5px] ring-1 ring-info/20 hover:bg-info/12">
        <span className="flex-1">
          <span className="font-medium">Почему так?</span> <span className="text-muted-foreground">Объяснить, какой выход выберется и почему</span>
        </span>
        <ArrowRight className="size-4 text-muted-foreground" />
      </a>
    </>
  )


  if (!compact) return (
    <div className="space-y-7">
      {fallbackNotice}{current}{mode}{members}{probes}{revert}{failure}{trace}
    </div>
  )

  const state = runtime ? groupState[runtime.state] : undefined
  const candidateIds = g.memberIds.filter((id) => {
    const profile = server?.profiles.find((item) => item.id === id)
    if (!profile) return false
    return !['disabled', 'missing', 'incompatible'].includes(effectiveProbe(profile, rt).state)
  })
  const measuringNow = measuring || measureTask?.state === 'pending' || measureTask?.state === 'running'

  async function measure() {
    setMeasuring(true)
    try {
      await startOperation(() => api.probeProfiles(candidateIds), setTaskId)
    } finally {
      setMeasuring(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel className="space-y-2 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={state?.tone ?? 'muted'}>{state?.label ?? 'Нет данных'}</StatusBadge>
          {!!change && <StatusBadge tone="draft">Черновик</StatusBadge>}
          {g.pin && <StatusBadge tone="warn" icon={<Pin />}>Есть закрепление</StatusBadge>}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
          <span className="font-medium [overflow-wrap:anywhere]">
            {runtime?.state === 'failed' ? runtime.fallback?.description ?? 'Нет доступного выхода' : selected ? profileLabel(selected) : 'Выход не выбран'}
          </span>
          {selected && runtime?.state !== 'failed' && <ProbeBadge probe={effectiveProbe(selected, rt)} />}
        </div>
        {runtime && <p className="text-xs text-muted-foreground">{runtime.reason} · <TimeAgo at={runtime.since} /></p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="min-h-8" disabled={!candidateIds.length || measuringNow} onClick={() => void measure()}>
            <RefreshCw aria-hidden="true" className={measuringNow ? 'motion-safe:animate-spin' : undefined} />
            {measuringNow ? 'Проверяем…' : 'Проверить кандидатов'}
          </Button>
          <a href={href('/trace-preview')} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[12.5px] text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            Проверить маршрут <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </Panel>
      {taskId && <TaskById id={taskId} />}
      <Tabs defaultValue="members" onValueChange={() => setOpenSetting(null)} className="min-w-0 gap-3">
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Настройки группы" className="h-9 max-w-full p-0">
            <TabsTrigger value="members" className="px-2 text-xs after:bottom-[-3px] sm:px-3">Состав</TabsTrigger>
            <TabsTrigger value="failure" className="px-2 text-xs after:bottom-[-3px] sm:px-3">При отказе</TabsTrigger>
            <TabsTrigger value="settings" className="px-2 text-xs after:bottom-[-3px] sm:px-3">Настройки</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="members" className="space-y-4 [&_section]:mb-0">
          <Panel>
            <ExitSettingRow label="Режим выбора" value={MODE[g.mode].label} open={can && openSetting === 'mode'} onToggle={() => toggleSetting('mode')}>
              {mode}
            </ExitSettingRow>
          </Panel>
          {members}
        </TabsContent>
        <TabsContent value="failure" className="space-y-4 [&_section]:mb-0">
          {fallbackNotice}
          <Panel>
            <ExitSettingRow label="Действие при отказе" value={failActionLabel(g.failAction, config, caps)} open={can && openSetting === 'failure'} onToggle={() => toggleSetting('failure')}>
              {failure}
            </ExitSettingRow>
          </Panel>
        </TabsContent>
        <TabsContent value="settings" className="space-y-4 [&_section]:mb-0">
          <Panel className="divide-y divide-border">
            <ExitSettingRow
              label="Проверки"
              value={`Каждые ${g.probe.intervalSec} с · ${count(g.probe.samples, ['проба', 'пробы', 'проб'])} в серии`}
              open={can && openSetting === 'probes'}
              onToggle={() => toggleSetting('probes')}
            >
              <div className="grid grid-cols-2 gap-2.5">{probeSchedule}</div>
            </ExitSettingRow>
            <ExitSettingRow
              label="Пороги переключения"
              value={`${g.probe.minAdvantageMs} мс преимущество · ${g.probe.switchPauseSec} с пауза · ${count(g.probe.failThreshold, ['сбой', 'сбоя', 'сбоев'])} до отказа`}
              open={can && openSetting === 'thresholds'}
              onToggle={() => toggleSetting('thresholds')}
            >
              <div className="divide-y divide-border">{probeThresholds}</div>
            </ExitSettingRow>
            <ExitSettingRow
              label="Возврат к первому профилю"
              value={g.revertToPreferred.enabled ? `Через ${g.revertToPreferred.delaySec} с · ${count(g.revertToPreferred.successStreak, ['успешная проба', 'успешные пробы', 'успешных проб'])} подряд` : 'Выключен'}
              open={can && openSetting === 'revert'}
              onToggle={() => toggleSetting('revert')}
            >
              {revert}
            </ExitSettingRow>
          </Panel>
          <ExitDisclosure title="Метод и адрес проверки">
            {probeAddress}{probeLimit}
          </ExitDisclosure>
          <ExitDisclosure title="Состояние группы">
            <GroupLadder group={g} runtime={runtime} />
            {current}
          </ExitDisclosure>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ═══════════════════════ кандидаты и перетаскивание ═══════════════════════ */

function MemberList({ group: g, compact }: { group: ExitGroup; compact: boolean }) {
  const { config, edit } = useDraft()
  const can = useCanWrite()
  if (!config) return null
  const members = g.memberIds.map((id) => config.profiles.find((p) => p.id === id)).filter((p): p is Profile => !!p)

  const reorder = (ids: string[]) =>
    edit(`Порядок профилей группы «${g.name}»`, (c) => {
      const x = c.exitGroups.find((q) => q.id === g.id)
      if (x) x.memberIds = ids
    })

  if (!can) {
    return (
      <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
        {members.map((p, i) => (
          <MemberRow key={p.id} profile={p} group={g} index={i} compact={compact} />
        ))}
      </div>
    )
  }
  return <DraggableMembers group={g} members={members} onReorder={reorder} compact={compact} />
}

function DraggableMembers({ group: g, members, onReorder, compact }: { group: ExitGroup; members: Profile[]; onReorder: (ids: string[]) => void; compact: boolean }) {
  const [order, setOrder] = useState(members.map((p) => p.id))
  useEffect(() => setOrder(members.map((p) => p.id)), [members])
  const byId = new Map(members.map((p) => [p.id, p]))
  return (
    <Reorder.Group axis="y" values={order} onReorder={setOrder} className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
      {order.map((id, i) => {
        const p = byId.get(id)
        if (!p) return null
        return (
          <DraggableMember key={id} id={id} onDrop={() => order.join() !== g.memberIds.join() && onReorder(order)}>
            {(handle) => <MemberRow profile={p} group={g} index={i} dragHandle={handle} compact={compact} />}
          </DraggableMember>
        )
      })}
    </Reorder.Group>
  )
}

function DraggableMember({ id, children, onDrop }: { id: string; children: (handle: ReactNode) => ReactNode; onDrop: () => void }) {
  const controls = useDragControls()
  return (
    <Reorder.Item
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="relative bg-card"
      whileDrag={{ scale: 1.01, boxShadow: '0 12px 28px -12px rgb(0 0 0 / 0.35)', zIndex: 10 }}
      transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
    >
      {children(
        <button
          type="button"
          onPointerDown={(e) => controls.start(e)}
          className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground active:cursor-grabbing"
          aria-label="Перетащить, чтобы изменить порядок"
        >
          <GripVertical className="size-3.5" />
        </button>,
      )}
    </Reorder.Item>
  )
}

function MemberRow({ profile: p, group: g, index, dragHandle, compact }: { profile: Profile; group: ExitGroup; index: number; dragHandle?: ReactNode; compact: boolean }) {
  const { edit } = useDraft()
  const { data: rt } = useRuntime()
  const pinned = g.pin?.profileId === p.id
  const togglePin = () =>
    edit(pinned ? `Снято закрепление профиля «${profileLabel(p)}»` : `Закрепление «${profileLabel(p)}» в группе «${g.name}»`, (c) => {
      const x = c.exitGroups.find((q) => q.id === g.id)
      if (!x) return
      x.pin = pinned ? null : { profileId: p.id, until: null }
    })

  const pinButton = (
    <WriteButton
      size="icon-sm"
      variant="ghost"
      reason={pinned ? 'Снять закрепление' : 'Закрепить этот профиль в группе'}
      title={pinned ? 'Снять закрепление' : 'Закрепить этот профиль в группе'}
      aria-label={pinned ? `Снять закрепление «${profileLabel(p)}»` : `Закрепить «${profileLabel(p)}»`}
      onClick={togglePin}
    >
      <Pin className={pinned ? 'text-warn' : undefined} aria-hidden="true" />
    </WriteButton>
  )

  if (compact) return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 bg-card px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        {dragHandle}
        <span className="tabular text-[11px] text-muted-foreground">{index + 1}</span>
      </div>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="text-[13px] leading-snug font-medium">{profileLabel(p)}{pinned && <Pin className="ml-1 inline size-3 text-warn" aria-label="Закреплён" />}</p>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
          {p.transport && <span>{p.transport}</span>}
          <ProbeBadge probe={effectiveProbe(p, rt)} compact />
        </div>
      </div>
      {pinButton}
    </div>
  )

  return (
    <div className="flex items-center gap-2 bg-card px-3 py-2">
      {dragHandle}
      <span className="tabular w-4 shrink-0 text-right text-[11.5px] text-muted-foreground">{index + 1}</span>
      <span className="w-4 shrink-0 text-center text-[14px]" aria-hidden>
        {COUNTRY_FLAG[p.country] ?? '🏳️'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium">{profileLabel(p)}</span>
          {pinned && (
            <StatusBadge tone="warn" icon={<Pin />}>
              закреплён
            </StatusBadge>
          )}
          {!p.enabled && <StatusBadge tone="muted">отключён</StatusBadge>}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground">{p.transport}</div>
      </div>
      <ProbeBadge probe={effectiveProbe(p, rt)} compact />
      {pinButton}
    </div>
  )
}

function NumberRow({ label, value, suffix, disabled, onCommit, compact }: {
  label: string
  value: number
  suffix: string
  disabled: boolean
  onCommit: (n: number) => void
  compact?: boolean
}) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  return (
    <label className={cn('flex items-center justify-between', compact ? 'gap-2 py-1.5' : 'gap-3 rounded-lg px-3 py-2 ring-1 ring-border')}>
      <span className={cn('text-[12.5px] text-muted-foreground', compact && 'min-w-0 [overflow-wrap:anywhere]')}>{label}</span>
      <span className={cn('flex items-center gap-1.5', compact && 'shrink-0')}>
        <Input
          className={cn('tabular h-7 text-right', compact ? 'w-16' : 'w-20')}
          type="number"
          inputMode="numeric"
          value={v}
          disabled={disabled}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={compact ? (e) => { if (e.key === 'Enter') e.currentTarget.blur() } : undefined}
          onBlur={() => {
            const n = Number(v)
            if (v.trim() !== '' && Number.isFinite(n) && n !== value) onCommit(Math.max(0, Math.round(n)))
            else setV(String(value))
          }}
        />
        <span className="text-[11.5px] text-muted-foreground">{suffix}</span>
      </span>
    </label>
  )
}
