import { Suspense, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react'
import { KeyRound, Loader2, Lock, PanelLeft, Wifi, WifiOff, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navFor } from './nav'
import { useRoute, href, sectionPaths } from '@/state/router'
import { useCaps, useRuntime } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { useSettingsSaving } from '@/state/live-config'
import { StatusDot, type Tone } from '@/components/rh/status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TimeAgo } from '@/components/rh/controls'
import { DetailSheet } from '@/components/rh/sheet'
import { SkeletonBlock } from '@/components/rh/layout'
import { DraftDock } from './DraftDock'
import { ApplyFlow } from './ApplyFlow'
import { TrialBanner } from './TrialBanner'
import { TaskCenter } from './TaskCenter'
import { ScenarioLab } from './ScenarioLab'
import { isDemo } from '@/api/mode'
import { CommandPalette, openPalette } from './CommandPalette'
import { MobileTabBar, MoreMenu, Sidebar, type NavBadges } from './Navigation'

/* ───────────── per-section health badges ───────────── */

function useNavBadges(): NavBadges {
  const { data: rt } = useRuntime()
  if (!rt) return {}
  const out: NavBadges = {}
  const groups = Object.values(rt.groups)
  if (groups.some((g) => g.state === 'failed')) out[sectionPaths['/exits']] = { tone: 'bad', label: 'Отказ группы выходов' }
  else if (groups.some((g) => g.state === 'degraded') || Object.values(rt.profiles).some((p) => p.state === 'missing'))
    out[sectionPaths['/exits']] = { tone: 'warn', label: 'Есть переключения или исчезнувшие профили' }
  if (rt.services.dns.state !== 'running') out[sectionPaths['/dns']] = { tone: 'warn', label: rt.services.dns.label }
  if (rt.services.zapret.state === 'failed') out[sectionPaths['/zapret']] = { tone: 'bad', label: rt.services.zapret.label }
  else if (rt.services.zapret.state !== 'running') out[sectionPaths['/zapret']] = { tone: 'warn', label: rt.services.zapret.label }
  if (rt.services.collector.state === 'failed') out[sectionPaths['/journal']] = { tone: 'warn', label: 'Сбор телеметрии остановлен' }
  return out
}

function RouterIdentity({ compact }: { compact?: boolean }) {
  const { data: caps } = useCaps()
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground text-background shadow-sm">
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="5" cy="18" r="2.2" />
          <circle cx="19" cy="6" r="2.2" />
          <path d="M7 17c5-1 4-9 10-10" />
        </svg>
      </div>
      {!compact && (
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[14px] font-semibold tracking-tight">RouteHub</div>
          <div className="truncate text-[11.5px] text-muted-foreground">{caps ? `${caps.device.model.replace('Keenetic ', '')} · ${caps.routehub.version}` : '…'}</div>
        </div>
      )}
    </div>
  )
}

/* ───────────── top status bar ───────────── */

function LinkPill() {
  const { data: rt, error } = useRuntime()
  const state = error ? 'offline' : rt?.link.state
  if (!state)
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-muted-foreground ring-1 ring-border ring-inset">
        <Wifi className="size-3.5 animate-pulse" />
        <span className="hidden sm:inline">Подключение…</span>
      </span>
    )
  const tone: Tone = state === 'online' ? 'ok' : state === 'slow' ? 'warn' : 'bad'
  const label = state === 'online' ? 'На связи' : state === 'slow' ? 'Медленная связь' : 'Нет связи'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] ring-1 ring-inset', state === 'online' ? 'ring-border text-muted-foreground' : tone === 'warn' ? 'bg-warn/10 ring-warn/30 text-warn' : 'bg-bad/10 ring-bad/30 text-bad')} />
        }
      >
        {state === 'offline' ? <WifiOff className="size-3.5" /> : <Wifi className="size-3.5" />}
        <span className="hidden sm:inline">{label}</span>
        {state === 'online' && rt && <span className="tabular hidden text-muted-foreground lg:inline">· {rt.link.latencyMs} мс</span>}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start">
        <span className="font-medium">Связь панели с роутером: {label.toLowerCase()}</span>
        {rt && (
          <span>
            Последняя синхронизация <TimeAgo at={rt.link.lastSyncAt} />
          </span>
        )}
        {error && <span>{error}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function RevisionPill() {
  const { data: rt } = useRuntime()
  const { server } = useDraft()
  if (!rt || !server) return null
  const lagging = rt.loadedRevision !== server.revision
  return (
    <Tooltip>
      <TooltipTrigger
        render={<a href={href('/system', { tab: 'revisions' })} className="pressable hidden h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-muted-foreground ring-1 ring-border ring-inset hover:text-foreground sm:inline-flex" />}
      >
        <span className="tabular font-medium text-foreground">r{server.revision}</span>
        <span className="hidden lg:inline">· применено <TimeAgo at={rt.lastApply.at} /></span>
        {lagging && <StatusDot tone="warn" />}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start">
        <span>Сохранённая ревизия r{server.revision}</span>
        <span>Демон работает с r{rt.loadedRevision}{lagging ? ' — ещё не загрузил новую' : ''}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/** Visible reason for locked controls: a tooltip alone is invisible on touch screens. */
function ReadOnlyBar() {
  const { data: caps } = useCaps()
  if (caps?.access !== 'read') return null
  return (
    <div role="status" className="flex items-start gap-2 border-b border-warn/25 bg-warn/8 px-4 py-2 text-[12.5px] leading-snug text-foreground md:px-6">
      <Lock className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <span>
        <span className="font-medium">Ключ только для чтения.</span>{' '}
        <span className="text-muted-foreground">Можно смотреть, проверять маршруты и запускать проверки. Изменения, применение и возврат ревизий заблокированы.</span>
      </span>
    </div>
  )
}

function AccessPill() {
  const { data: caps } = useCaps()
  if (caps?.access !== 'read') return null
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-warn/10 px-2.5 text-[12.5px] font-medium text-warn ring-1 ring-warn/30 ring-inset" />}>
        <Lock className="size-3.5" />
        <span className="hidden sm:inline">Только чтение</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">Этот ключ панели может смотреть и запускать проверки, но не может сохранять изменения.</TooltipContent>
    </Tooltip>
  )
}

function TopBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const route = useRoute()
  const item = navFor(route.path)
  const saving = useSettingsSaving()
  const mobileAction = 'pressable inline-flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 md:hidden'
  return (
    <div className="material sticky top-0 z-30 flex h-13 items-center gap-2 border-b px-4 md:px-6">
      <div className="md:hidden">
        <RouterIdentity compact />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13.5px]">
        <span className="truncate font-medium">{item.label}</span>
        <span role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {saving && <><Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /><span className="sr-only sm:not-sr-only">Сохраняем…</span></>}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <AccessPill />
        <LinkPill />
        <RevisionPill />
        <TaskCenter />
        <a
          href={href('/system', { tab: 'access' })}
          aria-label="Пароль и сессия"
          title="Пароль и сессия"
          className="pressable hidden size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 sm:inline-flex"
        >
          <KeyRound aria-hidden="true" className="size-4" />
        </a>
        <button type="button" onClick={openPalette} className={mobileAction} aria-label="Поиск" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">
          <Search className="size-4" />
        </button>
        <button type="button" onClick={onMore} className={mobileAction} aria-label="Все разделы" aria-haspopup="dialog" aria-expanded={moreOpen}>
          <PanelLeft className="size-4" />
        </button>
      </div>
    </div>
  )
}

/* ───────────── shell ───────────── */

export function Shell() {
  const route = useRoute()
  const item = navFor(route.path)
  const Screen = item.screen
  const badges = useNavBadges()
  const reducedMotion = useReducedMotion()
  const [more, setMore] = useState(false)
  return (
    <div className="flex min-h-dvh">
      <Sidebar path={route.path} badges={badges} identity={<RouterIdentity />} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar onMore={() => setMore(true)} moreOpen={more} />
        <TrialBanner />
        <ReadOnlyBar />
        <main className="flex-1">
          <MotionConfig reducedMotion="user">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={item.path} initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reducedMotion ? undefined : { opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.12 }}>
                <Suspense fallback={<LoadingPage />}>
                  <Screen />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </MotionConfig>
        </main>
        <DraftDock />
      </div>
      <MobileTabBar path={route.path} badges={badges} moreOpen={more} onMore={() => setMore(true)} />
      <DetailSheet open={more} onClose={() => setMore(false)} title="Все разделы">
        <MoreMenu path={route.path} badges={badges} onClose={() => setMore(false)} />
      </DetailSheet>
      <ApplyFlow />
      {isDemo && <ScenarioLab />}
      <CommandPalette />
    </div>
  )
}

function LoadingPage(): ReactNode {
  return (
    <div className="mx-auto max-w-[1120px] px-4 pt-8 md:px-8">
      <SkeletonBlock rows={5} />
    </div>
  )
}
