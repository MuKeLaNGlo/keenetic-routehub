import { useId, type MouseEvent, type ReactNode } from 'react'
import { Monitor, Moon, MoreHorizontal, Search, Sun } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { Kbd } from '@/components/rh/controls'
import { StatusDot, type Tone } from '@/components/rh/status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { href } from '@/state/router'
import { useTheme, type ThemePref } from '@/state/theme'
import { openPalette } from './CommandPalette'
import { NAV, NAV_GROUPS, navFor, type NavItem } from './nav'
import { ScenarioLabButton } from './ScenarioLab'

export type NavBadges = Partial<Record<string, { tone: Tone; label: string }>>

interface NavigationProps {
  path: string
  badges: NavBadges
}

const groups = (Object.keys(NAV_GROUPS) as NavItem['group'][]).map((id) => ({ id, items: NAV.filter((item) => item.group === id) }))
const quickLinks = NAV.filter((item) => item.mobile)
const focus = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
const slide = { type: 'spring', bounce: 0, duration: 0.32 } as const

function ActivePlate({ id, className, reduced }: { id: string; className: string; reduced: boolean | null }) {
  if (reduced) return <span className={className} aria-hidden="true" />
  return <motion.span layoutId={id} className={className} transition={slide} aria-hidden="true" />
}

function Sections({ path, badges, onClose }: NavigationProps & { onClose?: () => void }) {
  const active = navFor(path).path
  const reduced = useReducedMotion()
  const mobile = !!onClose
  const headingId = useId()

  function select(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onClose?.()
  }

  return (
    <nav
      aria-label="Разделы"
      className={mobile ? '@container min-w-0' : 'min-h-0 flex-1 overflow-y-auto px-3 py-2'}
    >
      <div className={mobile ? 'grid min-w-0 items-start gap-3 @min-[330px]:grid-cols-2' : 'space-y-3'}>
        {groups.map(({ id, items }) => (
          <section key={id} aria-labelledby={`${headingId}-${id}`} className="min-w-0">
            <h2 id={`${headingId}-${id}`} className={cn('pb-1 text-[11.5px] font-medium text-muted-foreground', mobile ? 'px-1' : 'px-2.5')}>
              {NAV_GROUPS[id]}
            </h2>
            <ul className="min-w-0 space-y-0.5">
              {items.map((item) => {
                const selected = item.path === active
                const badge = badges[item.path]
                return (
                  <li key={item.path} className="min-w-0">
                    <a
                      href={href(item.path)}
                      onClick={mobile ? select : undefined}
                      aria-current={selected ? 'page' : undefined}
                      className={cn(
                        'pressable relative flex min-w-0 items-center gap-2.5 rounded-lg text-[13px]',
                        mobile ? 'min-h-11 px-2.5 py-1.5' : 'min-h-[30px] px-2.5 py-1',
                        selected ? 'font-semibold text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/65 hover:text-foreground',
                        focus,
                      )}
                    >
                      {selected && (
                        <ActivePlate
                          id={mobile ? 'more-current' : 'sidebar-current'}
                          className="pointer-events-none absolute inset-0 rounded-lg bg-sidebar-accent"
                          reduced={reduced}
                        />
                      )}
                      <span aria-hidden="true" className="relative flex shrink-0 [&_svg]:size-4">{item.icon}</span>
                      <span className="relative min-w-0 flex-1 leading-tight [overflow-wrap:anywhere]">{item.label}</span>
                      {badge && (
                        <>
                          {mobile ? (
                            <StatusDot tone={badge.tone} />
                          ) : (
                            <Tooltip>
                              <TooltipTrigger render={<span className="relative flex shrink-0" />}>
                                <StatusDot tone={badge.tone} pulse={badge.tone === 'bad' && !reduced} />
                              </TooltipTrigger>
                              <TooltipContent side="right">{badge.label}</TooltipContent>
                            </Tooltip>
                          )}
                          <span className="sr-only">. {badge.label}</span>
                        </>
                      )}
                    </a>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  )
}

const themes: { value: ThemePref; label: string; icon: typeof Moon }[] = [
  { value: 'light', label: 'Светлая', icon: Sun },
  { value: 'system', label: 'Как в системе', icon: Monitor },
  { value: 'dark', label: 'Тёмная', icon: Moon },
]

function ThemeSwitch({ mobile = false }: { mobile?: boolean }) {
  const name = useId()
  const [theme, setTheme] = useTheme()
  return (
    <fieldset className="min-w-0">
      <legend className={mobile ? 'mb-1.5 px-1 text-[11.5px] font-medium text-muted-foreground' : 'sr-only'}>Тема</legend>
      <div className="grid min-w-0 grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
        {themes.map(({ value, label, icon: Icon }) => (
          <label key={value} title={label} className="min-w-0 cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name={name}
              value={value}
              checked={theme === value}
              onChange={() => setTheme(value)}
            />
            <span className={cn('flex min-w-0 items-center justify-center gap-1 rounded-md px-1 text-muted-foreground hover:text-foreground peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-ring/70 dark:peer-checked:bg-sidebar-accent', mobile ? 'min-h-11' : 'min-h-8')}>
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className={mobile ? 'min-w-0 text-[11px] font-medium [overflow-wrap:anywhere]' : 'sr-only'}>{label}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function Sidebar({ identity, ...navigation }: NavigationProps & { identity: ReactNode }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div className="px-4 pt-4 pb-3">{identity}</div>
      <button
        type="button"
        onClick={openPalette}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className={cn('pressable mx-3 mb-1 flex min-h-9 shrink-0 items-center gap-2 rounded-lg border border-sidebar-border bg-card px-2.5 text-[13px] text-muted-foreground hover:text-foreground', focus)}
      >
        <Search className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-left">Поиск</span>
        <span aria-hidden="true"><Kbd>Ctrl K</Kbd></span>
      </button>
      <Sections {...navigation} />
      <div className="grid shrink-0 gap-2 border-t border-sidebar-border px-3 py-2.5 [&>button]:justify-start [&>button]:text-xs">
        <ThemeSwitch />
        <ScenarioLabButton inline />
      </div>
    </aside>
  )
}

export function MoreMenu({ onClose, ...navigation }: NavigationProps & { onClose: () => void }) {
  return (
    <div className="min-w-0 space-y-3.5">
      <Sections {...navigation} onClose={onClose} />
      <div className="grid gap-2 border-t border-border pt-3 [&>button]:min-h-11 [&>button]:justify-start [&>button]:text-xs">
        <ThemeSwitch mobile />
        <ScenarioLabButton inline onOpen={onClose} />
      </div>
    </div>
  )
}

export function MobileTabBar({ path, badges, moreOpen, onMore }: NavigationProps & { moreOpen: boolean; onMore: () => void }) {
  const current = navFor(path)
  const reduced = useReducedMotion()
  const moreActive = !quickLinks.some((item) => item.path === current.path)
  const otherBadges = NAV.filter((item) => !item.mobile).map((item) => badges[item.path]).filter(Boolean)
  const moreBadge = otherBadges.find((badge) => badge?.tone === 'bad') ?? otherBadges[0]
  const link = cn('pressable relative flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 text-[10.5px] leading-tight', focus)

  return (
    <nav className="material-strong fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Быстрые разделы">
      <div className="grid grid-cols-5">
        {quickLinks.map((item) => {
          const active = item.path === current.path
          const badge = badges[item.path]
          return (
            <a
              key={item.path}
              href={href(item.path)}
              aria-current={active ? 'page' : undefined}
              className={cn(link, active ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <MobileIcon icon={item.icon} active={active} badge={badge} reduced={reduced} />
              <span className="max-w-full truncate">{item.label}</span>
              {badge && <span className="sr-only">. {badge.label}</span>}
            </a>
          )
        })}
        <button
          type="button"
          onClick={onMore}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          className={cn(link, moreActive ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          <MobileIcon icon={<MoreHorizontal />} active={moreActive} badge={moreBadge} reduced={reduced} />
          <span>Ещё</span>
          {moreActive && <span className="sr-only">. Текущий раздел {current.label}</span>}
          {moreBadge && <span className="sr-only">. Есть предупреждения в разделах</span>}
        </button>
      </div>
    </nav>
  )
}

function MobileIcon({ icon, active, badge, reduced }: { icon: ReactNode; active: boolean; badge?: NonNullable<NavBadges[string]>; reduced: boolean | null }) {
  return (
    <span aria-hidden="true" className="relative flex h-7 w-10 items-center justify-center">
      {active && <ActivePlate id="mobile-current" className="pointer-events-none absolute inset-0 rounded-xl bg-sidebar-accent" reduced={reduced} />}
      <span className="relative flex [&_svg]:size-[19px]">{icon}</span>
      {badge && <StatusDot tone={badge.tone} className="absolute top-0 right-0" />}
    </span>
  )
}
