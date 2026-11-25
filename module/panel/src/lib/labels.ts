import type { Action, Capabilities, Config, Profile, VpnTarget } from '@/api/contract'
import { count } from '@/lib/format'

/** Context needed to name things (profiles, groups, uplinks). */
export interface LabelCtx {
  config: Pick<Config, 'profiles' | 'exitGroups' | 'primaryProfileId'>
  caps?: Pick<Capabilities, 'ispUplinks'> | null
}

export function profileName(ctx: LabelCtx, id: string): string {
  const p = ctx.config.profiles.find((x) => x.id === id)
  return p ? (p.alias ?? p.name) : `профиль ${id} (удалён)`
}

export function groupName(ctx: LabelCtx, id: string): string {
  return ctx.config.exitGroups.find((g) => g.id === id)?.name ?? `группа ${id} (удалена)`
}

export function uplinkName(ctx: LabelCtx, id: string): string {
  return ctx.caps?.ispUplinks.find((u) => u.id === id)?.name ?? id
}

export function vpnTargetLabel(ctx: LabelCtx, t: VpnTarget): string {
  switch (t.type) {
    case 'profile':
      return profileName(ctx, t.profileId)
    case 'group':
      return `группа «${groupName(ctx, t.groupId)}»`
    case 'primary':
      return `основной профиль (${profileName(ctx, ctx.config.primaryProfileId)})`
  }
}

/** Short, human label of a routing action — the one vocabulary used everywhere. */
export function actionLabel(ctx: LabelCtx, a: Action): string {
  switch (a.kind) {
    case 'keenetic':
      return 'Штатный Keenetic'
    case 'direct':
      return `Напрямую · ${uplinkName(ctx, a.uplinkId)}`
    case 'vpn':
      return `VPN · ${vpnTargetLabel(ctx, a.target)}`
    case 'zapret':
      return `Zapret → ${a.exit === 'direct' ? 'напрямую' : 'штатный Keenetic'}`
    case 'block':
      return 'Блокировать'
    case 'inherit':
      return 'Наследовать'
  }
}

export const ACTION_KIND_LABEL: Record<Action['kind'], string> = {
  keenetic: 'Штатный Keenetic',
  direct: 'Напрямую',
  vpn: 'VPN',
  zapret: 'Zapret',
  block: 'Блокировать',
  inherit: 'Наследовать',
}

export const MATCH_TYPE_LABEL: Record<string, string> = {
  domain: 'Домен',
  suffix: 'Домен и поддомены',
  ip: 'IP',
  cidr: 'Подсеть',
  geosite: 'GeoSite',
  geoip: 'GeoIP',
  set: 'Набор',
  port: 'Порт',
}

export const PROTOCOL_LABEL: Record<string, string> = {
  vless: 'VLESS',
  hysteria2: 'Hysteria2',
  trojan: 'Trojan',
  awg: 'AmneziaWG',
}

export function profileFormatLabel(profile: Pick<Profile, 'protocol' | 'xrayGroup'>): string {
  return profile.xrayGroup ? 'Группа Xray' : PROTOCOL_LABEL[profile.protocol]
}

export function xrayGroupDescription(groupSize?: number): string {
  return groupSize && groupSize > 0 ? `Группа Xray · ${count(groupSize, ['выход', 'выхода', 'выходов'])}` : 'Группа Xray'
}

export function profileFormatSummary(profile: Profile): string {
  if (profile.xrayGroup) return xrayGroupDescription(profile.groupSize)
  return [profileFormatLabel(profile), profile.transport].filter(Boolean).join(' · ')
}

export const ENGINE_LABEL: Record<string, string> = {
  xray: 'Xray',
  'sing-box': 'sing-box',
  'awg-keenetic': 'AWG KeeneticOS',
  'awg-routehub': 'AWG RouteHub',
}

export const COUNTRY_FLAG: Record<string, string> = {
  nl: '🇳🇱', ee: '🇪🇪', us: '🇺🇸', de: '🇩🇪', fi: '🇫🇮', ru: '🇷🇺', se: '🇸🇪', pl: '🇵🇱', lv: '🇱🇻', tr: '🇹🇷',
}
