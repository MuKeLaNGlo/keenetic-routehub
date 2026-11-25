import type { ComponentType, ReactNode } from 'react'
import { lazy } from 'react'
import { sectionPaths } from '@/state/router'
import { Activity, Globe, LayoutDashboard, ListTree, MonitorSmartphone, Network, Route, Settings2, ShieldCheck, Zap } from 'lucide-react'

export interface NavItem {
  path: string
  label: string
  /** Longer label for page titles / palette. */
  title: string
  icon: ReactNode
  group: 'state' | 'policy' | 'exits' | 'system'
  /** Shown in the mobile tab bar. */
  mobile?: boolean
  screen: ComponentType
}

export const NAV_GROUPS: Record<NavItem['group'], string> = {
  state: 'Состояние',
  policy: 'Политика',
  exits: 'Выходы и службы',
  system: 'Система',
}

export const NAV: NavItem[] = [
  {
    path: sectionPaths['/'], label: 'Обзор', title: 'Обзор', icon: <LayoutDashboard />, group: 'state', mobile: true,
    screen: lazy(() => import('@/screens/overview-preview')),
  },
  {
    path: sectionPaths['/journal'], label: 'Журнал', title: 'Журнал и телеметрия', icon: <Activity />, group: 'state',
    screen: lazy(() => import('@/screens/journal-preview')),
  },
  {
    path: sectionPaths['/networks'], label: 'Сети', title: 'Сети и шаблоны', icon: <Network />, group: 'policy',
    screen: lazy(() => import('@/screens/networks-preview')),
  },
  {
    path: sectionPaths['/devices'], label: 'Устройства', title: 'Устройства', icon: <MonitorSmartphone />, group: 'policy', mobile: true,
    screen: lazy(() => import('@/screens/devices-preview')),
  },
  {
    path: sectionPaths['/rules'], label: 'Правила', title: 'Правила и наборы', icon: <ListTree />, group: 'policy', mobile: true,
    screen: lazy(() => import('@/screens/rules-preview')),
  },
  {
    path: sectionPaths['/trace'], label: 'Проверка', title: 'Проверка маршрута', icon: <Route />, group: 'policy', mobile: true,
    screen: lazy(() => import('@/screens/trace-preview')),
  },
  {
    path: sectionPaths['/exits'], label: 'Выходы VPN', title: 'Профили, группы и подписки', icon: <ShieldCheck />, group: 'exits',
    screen: lazy(() => import('@/screens/exits-preview')),
  },
  {
    path: sectionPaths['/zapret'], label: 'Zapret', title: 'Zapret: YouTube и Discord', icon: <Zap />, group: 'exits',
    screen: lazy(() => import('@/screens/zapret-preview')),
  },
  {
    path: sectionPaths['/dns'], label: 'DNS', title: 'DNS', icon: <Globe />, group: 'exits',
    screen: lazy(() => import('@/screens/dns-preview')),
  },
  {
    path: sectionPaths['/system'], label: 'Обслуживание', title: 'Ревизии, обновления и копии', icon: <Settings2 />, group: 'system',
    screen: lazy(() => import('@/screens/system-preview')),
  },
]

export function navFor(path: string): NavItem {
  const first = '/' + (path.split('/').filter(Boolean)[0] ?? '')
  return NAV.find((n) => n.path === first) ?? NAV[0]
}
