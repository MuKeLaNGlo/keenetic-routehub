import { useEffect, useState, useSyncExternalStore } from 'react'
import { FlaskRound, GitBranch, LockKeyhole, Moon, Route, Sun, Monitor, Smartphone, ShieldCheck, ListTree } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { NAV } from './nav'
import { navigate, href, useRoute } from '@/state/router'
import { useTopology } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { setTheme } from '@/state/theme'
import { COUNTRY_FLAG } from '@/lib/labels'
import { deviceIp, deviceName } from '@/lib/entities'

let isOpen = false
const ls = new Set<() => void>()
const setOpen = (v: boolean) => {
  isOpen = v
  ls.forEach((l) => l())
}
export const openPalette = () => setOpen(true)

/** ⌘K / Ctrl K: jump anywhere — sections, devices, profiles, rules, actions. */
export function CommandPalette() {
  const open = useSyncExternalStore(
    (l) => {
      ls.add(l)
      return () => ls.delete(l)
    },
    () => isOpen,
  )
  const [q, setQ] = useState('')
  const route = useRoute()
  const { data: topo } = useTopology()
  const { config, dirty } = useDraft()

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const go = (to: string) => {
    setOpen(false)
    setQ('')
    navigate(to)
  }

  const rules = config ? config.policies.flatMap((p) => p.rules.map((r) => ({ r, p }))) : []

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Поиск" description="Разделы, устройства, профили, правила и действия" className="sm:max-w-xl">
      <Command loop>
        <CommandInput placeholder="Раздел, устройство, профиль, правило…" value={q} onValueChange={setQ} />
        <CommandList className="max-h-[min(60dvh,440px)]">
          <CommandEmpty>Ничего не найдено</CommandEmpty>
          <CommandGroup heading="Действия">
            <CommandItem onSelect={() => go(href('/trace'))}>
              <Route /> Проверить маршрут…
            </CommandItem>
            <CommandItem onSelect={() => go(href('/system', { tab: 'access' }))}>
              <LockKeyhole /> Пароль и сессия
            </CommandItem>
            {dirty && (
              <CommandItem onSelect={() => go(href(route.path, { review: '1' }))}>
                <GitBranch className="text-draft" /> Просмотреть черновик
              </CommandItem>
            )}
            <CommandItem onSelect={() => go(href('/', { lab: '1' }))}>
              <FlaskRound /> Лаборатория сценариев
            </CommandItem>
            <CommandItem onSelect={() => (setTheme('light'), setOpen(false))}>
              <Sun /> Светлая тема
            </CommandItem>
            <CommandItem onSelect={() => (setTheme('dark'), setOpen(false))}>
              <Moon /> Тёмная тема
            </CommandItem>
            <CommandItem onSelect={() => (setTheme('system'), setOpen(false))}>
              <Monitor /> Тема как в системе
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Разделы">
            {NAV.map((n) => (
              <CommandItem key={n.path} value={`раздел ${n.title} ${n.label}`} onSelect={() => go(href(n.path))}>
                {n.icon} {n.title}
              </CommandItem>
            ))}
          </CommandGroup>
          {topo && (
            <CommandGroup heading="Устройства">
              {topo.devices.map((d) => (
                <CommandItem key={d.id} value={`устройство ${deviceName(d, config)} ${d.hostname} ${deviceIp(d)}`} onSelect={() => go(href('/devices', { d: d.id }))}>
                  <Smartphone /> {deviceName(d, config)}
                  <CommandShortcut>{deviceIp(d)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {config && (
            <CommandGroup heading="Профили">
              {config.profiles.map((p) => (
                <CommandItem key={p.id} value={`профиль ${p.name} ${p.alias ?? ''} ${p.protocol}`} onSelect={() => go(href('/exits', { tab: 'profiles', p: p.id }))}>
                  <ShieldCheck /> <span>{COUNTRY_FLAG[p.country] ?? ''}</span> {p.alias ?? p.name}
                  <CommandShortcut>{p.protocol.toUpperCase()}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {q.length > 1 && (
            <CommandGroup heading="Правила">
              {rules.slice(0, 60).map(({ r, p }) => (
                <CommandItem key={`${p.id}/${r.id}`} value={`правило ${r.name} ${p.name}`} onSelect={() => go(href('/rules', { policy: p.id, rule: r.id }))}>
                  <ListTree /> {r.name}
                  <CommandShortcut>{p.name}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
