/**
 * Fictional but internally consistent install: a Keenetic Hopper KN‑3811 with
 * four segments, a dozen clients, two subscriptions and the policies the spec's
 * verification scenarios need. Every name/address here is invented.
 */
import type {
  Capabilities,
  ClassifiedFlow,
  Config,
  EngineInfo,
  GeoSource,
  JournalEvent,
  Revision,
  Rule,
  Runtime,
  SubscriptionStatus,
  Topology,
  UpdateInfo,
  ZapretStrategy,
} from '../contract'

export const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
export const inMin = (min: number) => new Date(Date.now() + min * 60_000).toISOString()

/**
 * Config is versioned: the same revision must always have the same content,
 * or a draft based on "r148" diffs against a different "r148" after a reset.
 * So config never uses `ago()`. Its timestamps (import provenance) are fixed
 * relative to this install's epoch.
 */
const SEED_EPOCH = Date.parse('2026-11-19T09:00:00Z')
const atSeed = (minBefore: number) => new Date(SEED_EPOCH - minBefore * 60_000).toISOString()

/* ───────────────────────────── capabilities ─────────────────────────── */

export function seedCapabilities(): Capabilities {
  return {
    access: 'write',
    device: { model: 'Keenetic Hopper KN‑3811', name: 'Hopper‑Дом', firmware: 'KeeneticOS 5.0.4', arch: 'aarch64', entware: 'Entware 2026.09' },
    routehub: { version: '2.4.0', build: 'b1187' },
    interception: {
      mode: 'transparent-v4-tcp',
      label: 'Прозрачный перехват IPv4 TCP',
      coverage: {
        v4tcp: { state: 'verified', note: 'Проверено трафиком на сегменте «Дом»' },
        v4udp: { state: 'partial', note: 'Только через TPROXY и локальный SOCKS5; прозрачный перехват UDP не испытан' },
        v6tcp: { state: 'untested', note: 'Записи IPv6 принимаются в правилах, но перехват IPv6 на этой установке не испытан' },
        v6udp: { state: 'untested', note: 'Не испытано' },
      },
      notes: [
        'Перехват работает на сегменте «Дом». Для «Гости» и IoT применяется после испытания.',
        'IPv4 TPROXY (TCP+UDP) есть в коде, требует испытания на KN‑3811.',
      ],
    },
    actions: {
      keenetic: { available: true },
      direct: { available: true },
      vpn: { available: true },
      zapret: { available: true },
      block: { available: true },
      inherit: { available: true },
    },
    perSsidPolicy: {
      available: false,
      reason: 'SSID «RouteHub‑Home» и «RouteHub‑Home‑5G» входят в один мост Bridge0. Клиенты двух сетей неразличимы для маршрутизации: нет проверяемого признака подключения.',
      remedy: 'Вынесите второй SSID в отдельный сегмент в KeeneticOS — тогда у него появится своя политика.',
    },
    perDeviceDns: { available: false, reason: 'Перенаправление DNS по устройству требует подтверждённой IPv4-привязки и не испытано на этой прошивке.' },
    zapret: { available: true },
    gameRouting: {
      routeAtOpen: { available: true },
      lateSignalPriority: { available: true },
      intelliQos: { available: true },
      strictPriority: { available: false, reason: 'Строгий приоритет отдельных потоков требует отдельно проверенной интеграции с IntelliQoS.' },
    },
    ipv6: { available: false, reason: 'Перехват IPv6 не испытан на этой установке' },
    trialApply: { available: true },
    liveObservation: { available: true },
    ispUplinks: [
      { id: 'isp-main', name: 'Ростелеком (оптика)', iface: 'GigabitEthernet1' },
      { id: 'isp-lte', name: 'LTE резерв', iface: 'UsbLte0' },
    ],
  }
}

/* ───────────────────────────── topology ─────────────────────────────── */

export function seedTopology(): Topology {
  return {
    fetchedAt: ago(0.2),
    segments: [
      {
        id: 'Bridge0', name: 'Дом', iface: 'Bridge0', kind: 'bridge', v4: ['192.168.1.0/24'], v6: ['fd12:3456:1::/64'],
        ssidIds: ['ssid-home-24', 'ssid-home-5'], state: 'up', routable: { available: true }, isolation: 'Доступ ко всем сегментам',
      },
      {
        id: 'Bridge1', name: 'Гости', iface: 'Bridge1', kind: 'bridge', vlan: 20, v4: ['10.10.0.0/24'], v6: [],
        ssidIds: ['ssid-guest'], state: 'up', routable: { available: true }, isolation: 'Изолирован от «Дом» и IoT правилами Keenetic',
      },
      {
        id: 'Bridge2', name: 'IoT', iface: 'Bridge2', kind: 'bridge', vlan: 30, v4: ['10.20.0.0/24'], v6: [],
        ssidIds: ['ssid-iot'], state: 'up', routable: { available: true }, isolation: 'Нет доступа в «Дом»; «Дом» видит IoT',
      },
      {
        id: 'Vlan40', name: 'Офис', iface: 'GigabitEthernet0/Vlan40', kind: 'l3', vlan: 40, v4: ['172.16.40.0/24'], v6: [],
        ssidIds: [], state: 'up', routable: { available: true }, isolation: 'Изолирован полностью',
      },
    ],
    ssids: [
      { id: 'ssid-home-24', name: 'RouteHub‑Home', band: '2.4 ГГц', segmentId: 'Bridge0', distinguishable: { available: false, reason: 'Общий мост Bridge0' } },
      { id: 'ssid-home-5', name: 'RouteHub‑Home‑5G', band: '5 ГГц', segmentId: 'Bridge0', distinguishable: { available: false, reason: 'Общий мост Bridge0' } },
      { id: 'ssid-guest', name: 'RouteHub‑Guest', band: '5 ГГц', segmentId: 'Bridge1', distinguishable: { available: true } },
      { id: 'ssid-iot', name: 'RouteHub‑IoT', band: '2.4 ГГц', segmentId: 'Bridge2', distinguishable: { available: true } },
    ],
    devices: [
      dev('d-pixel', 'Pixel‑8', 'Google', 'phone', 'Bridge1', 'ssid-guest', '10.10.0.23', 'confirmed', true, 0.1, 'a4:c3:61:2e:10:8f', 'fd12:3456:2::23'),
      dev('d-mbp', 'MacBook‑Pro', 'Apple', 'laptop', 'Bridge0', 'ssid-home-5', '192.168.1.20', 'confirmed', true, 0.2, '3c:22:fb:91:aa:01', 'fd12:3456:1::20'),
      dev('d-pc', 'demo‑pc', 'MSI', 'desktop', 'Bridge0', undefined, '192.168.1.10', 'confirmed', true, 0.1, 'd8:43:ae:5f:00:12'),
      dev('d-ps5', 'PS5', 'Sony', 'console', 'Bridge0', 'ssid-home-5', '192.168.1.41', 'confirmed', true, 0.4, '78:c8:81:0b:7e:33'),
      dev('d-tv', 'LG‑OLED', 'LG', 'tv', 'Bridge0', 'ssid-home-5', '192.168.1.55', 'confirmed', true, 1, '64:cb:e9:12:4d:90'),
      dev('d-ipad', 'iPad‑Kids', 'Apple', 'tablet', 'Bridge0', 'ssid-home-24', '192.168.1.77', 'observed', true, 2, '9c:fc:e8:30:21:aa', undefined,
        'Адрес наблюдается по ARP, но DHCP-привязка не подтверждена — личные правила не исполняются, пока привязка не подтверждена.'),
      dev('d-oldphone', 'Galaxy‑A52', 'Samsung', 'phone', 'Bridge0', 'ssid-home-24', '192.168.1.80', 'lost', false, 340, 'f0:6b:ca:44:19:02', undefined,
        'Не появлялся 5 ч 40 мин. Привязка снята — при возвращении применится политика фактического сегмента.'),
      dev('d-vacuum', 'Roborock‑S8', 'Roborock', 'iot', 'Bridge2', 'ssid-iot', '10.20.0.31', 'confirmed', true, 0.5, '50:ec:50:7a:31:c0'),
      dev('d-plug', 'Розетка‑кухня', 'Tuya', 'iot', 'Bridge2', 'ssid-iot', '10.20.0.40', 'confirmed', true, 0.6, '84:e3:42:11:2a:9b'),
      dev('d-cam', 'Камера‑двор', 'Ezviz', 'iot', 'Bridge2', 'ssid-iot', '10.20.0.52', 'ambiguous', true, 0.3, 'c0:6d:ed:aa:01:5e', undefined,
        'Адрес 10.20.0.52 за последний час был у двух MAC-адресов. Применяется политика сегмента IoT.'),
      dev('d-echo', 'Колонка', 'Yandex', 'speaker', 'Bridge2', 'ssid-iot', '10.20.0.60', 'confirmed', true, 0.2, '1c:53:f9:0e:77:21'),
      dev('d-guest', 'Неизвестное устройство', '—', 'unknown', 'Bridge1', 'ssid-guest', '10.10.0.88', 'observed', true, 3, '2a:11:7f:00:9e:3c', undefined,
        'Новое устройство. Действует политика сегмента «Гости».'),
      dev('d-worklap', 'ThinkPad‑work', 'Lenovo', 'laptop', 'Vlan40', undefined, '172.16.40.12', 'confirmed', true, 0.3, '54:e1:ad:6c:02:91'),
    ],
  }
}

function dev(
  id: string, hostname: string, vendor: string, kind: Topology['devices'][number]['kind'], segmentId: string, ssidId: string | undefined,
  v4: string, binding: Topology['devices'][number]['binding'], online: boolean, seenMinAgo: number, mac: string, v6?: string, bindingNote?: string,
): Topology['devices'][number] {
  const addresses: Topology['devices'][number]['addresses'] = [
    { addr: v4, family: 'v4', source: binding === 'observed' ? 'arp' : 'dhcp', confirmed: binding === 'confirmed' },
  ]
  if (v6) addresses.push({ addr: v6, family: 'v6', source: 'ndp', confirmed: false })
  return { id, hostname, vendor, kind, mac, segmentId, ssidId, addresses, binding, bindingNote, online, lastSeen: ago(seenMinAgo) }
}

/* ───────────────────────────── config ───────────────────────────────── */

const r = (
  id: string, name: string, matches: Rule['matches'], action: Rule['action'], extra: Partial<Rule> = {},
): Rule => ({
  id, name, matches, action, families: ['v4', 'v6'], protos: ['tcp', 'udp'], enabled: true,
  source: { type: 'manual' }, ...extra,
})

const NL_EE = { kind: 'vpn', target: { type: 'group', groupId: 'grp-nl-ee' } } as const
const STREAM = { kind: 'vpn', target: { type: 'group', groupId: 'grp-stream' } } as const
const DIRECT = { kind: 'direct', uplinkId: 'isp-main' } as const

export function seedConfig(): Config {
  return {
    revision: 148,
    primaryProfileId: 'p-nl-ams',
    policies: [
      {
        id: 'pol-global', name: 'Общие правила', kind: 'global', parentId: null,
        description: 'Действуют во всех управляемых сетях после правил сети и шаблона.',
        defaultAction: { kind: 'keenetic' }, fallbackOverride: null, disabledParentRuleIds: [],
        rules: [
          r('g-gosuslugi', 'Госуслуги напрямую', [{ type: 'suffix', value: 'gosuslugi.ru' }], DIRECT, { source: { type: 'migration', label: 'Перенесено из 2.3' } }),
          r('g-banks', 'Банки напрямую', [{ type: 'set', value: 'set-banks' }], DIRECT, { source: { type: 'migration', label: 'Перенесено из 2.3' } }),
          r('g-blocked', 'Заблокированные ресурсы', [{ type: 'set', value: 'set-blocked' }, { type: 'geosite', value: 'ru-blocked' }], NL_EE),
          r('g-ai', 'ChatGPT и Claude', [{ type: 'suffix', value: 'openai.com' }, { type: 'suffix', value: 'chatgpt.com' }, { type: 'suffix', value: 'claude.ai' }], NL_EE),
          r('g-ads', 'Реклама и трекеры', [{ type: 'geosite', value: 'category-ads-all' }], { kind: 'block' }),
          r('g-media-cdn', 'CDN медиа-сайта напрямую', [{ type: 'cidr', value: '151.101.0.0/16' }], DIRECT, {
            families: ['v4'], note: 'Общий CDN: адреса обслуживают много доменов',
            source: { type: 'import', label: 'Импорт «cdn.txt»', at: atSeed(60 * 24 * 3) },
          }),
        ],
      },
      {
        id: 'pol-tpl-home', name: 'Домашний шаблон', kind: 'template', parentId: 'pol-global',
        description: 'Общий набор для домашних сетей. На него ссылаются «Дом» и устройства IoT.',
        defaultAction: { kind: 'inherit' }, fallbackOverride: null, disabledParentRuleIds: [],
        rules: [
          r('t-stream', 'Стриминг через VPN', [{ type: 'geosite', value: 'netflix' }, { type: 'geosite', value: 'disney' }], STREAM),
          r('t-media', 'Медиа-сайт через VPN', [{ type: 'suffix', value: 'media-site.example' }], NL_EE),
          r('t-smart', 'Облака умного дома через VPN', [{ type: 'suffix', value: 'tuya.com' }, { type: 'suffix', value: 'roborock.com' }], NL_EE),
          r('t-torrent', 'Торренты напрямую', [{ type: 'port', value: '6881-6889' }], DIRECT, { protos: ['tcp', 'udp'] }),
        ],
      },
      {
        id: 'pol-seg-home', name: 'Дом', kind: 'segment', parentId: 'pol-tpl-home',
        defaultAction: { kind: 'inherit' }, fallbackOverride: null, disabledParentRuleIds: [],
        rules: [
          r('h-discord-voice', 'Discord голос через VPN', [{ type: 'geosite', value: 'discord' }], NL_EE, { protos: ['udp'], families: ['v4'] }),
          r('h-steam', 'Steam загрузки напрямую', [{ type: 'suffix', value: 'steamcontent.com' }], DIRECT),
        ],
      },
      {
        id: 'pol-seg-guest', name: 'Гости', kind: 'segment', parentId: 'pol-global',
        defaultAction: { kind: 'keenetic' }, fallbackOverride: null, disabledParentRuleIds: ['g-ai'],
        rules: [r('gu-torrent', 'Торренты заблокированы', [{ type: 'port', value: '6881-6889' }], { kind: 'block' })],
      },
      {
        id: 'pol-seg-iot', name: 'IoT', kind: 'segment', parentId: 'pol-global',
        defaultAction: { kind: 'keenetic' }, fallbackOverride: null, disabledParentRuleIds: [],
        rules: [r('i-mi', 'Облако Xiaomi напрямую', [{ type: 'suffix', value: 'mi.com' }, { type: 'suffix', value: 'xiaomi.com' }], DIRECT)],
      },
      {
        id: 'pol-seg-office', name: 'Офис', kind: 'segment', parentId: 'pol-global',
        defaultAction: { kind: 'keenetic' }, fallbackOverride: null, disabledParentRuleIds: [], rules: [],
      },
      {
        id: 'pol-dev-pixel', name: 'Телефон Миши · личные правила', kind: 'device', parentId: null,
        defaultAction: { kind: 'inherit' }, fallbackOverride: null, disabledParentRuleIds: [],
        rules: [r('dp-work', 'Рабочий портал', [{ type: 'suffix', value: 'portal.work-example.ru' }], { kind: 'vpn', target: { type: 'profile', profileId: 'p-awg-office' } })],
      },
      {
        id: 'pol-dev-vacuum', name: 'Пылесос · личные правила', kind: 'device', parentId: null,
        defaultAction: { kind: 'inherit' }, fallbackOverride: null, disabledParentRuleIds: ['t-stream'],
        rules: [r('dv-robo', 'Облако Roborock напрямую', [{ type: 'suffix', value: 'roborock.com' }], DIRECT, { note: 'Переопределяет «Облака умного дома через VPN» для roborock.com' })],
      },
      {
        id: 'pol-grp-kids', name: 'Детские устройства', kind: 'device', parentId: null,
        defaultAction: { kind: 'inherit' }, fallbackOverride: null, disabledParentRuleIds: [],
        rules: [r('k-tiktok', 'TikTok заблокирован', [{ type: 'geosite', value: 'tiktok' }], { kind: 'block' })],
      },
    ],
    segmentPolicies: [
      { segmentId: 'Bridge0', mode: 'managed', policyId: 'pol-seg-home' },
      { segmentId: 'Bridge1', mode: 'managed', policyId: 'pol-seg-guest' },
      { segmentId: 'Bridge2', mode: 'managed', policyId: 'pol-seg-iot' },
      { segmentId: 'Vlan40', mode: 'excluded', policyId: 'pol-seg-office' },
    ],
    devicePolicies: [
      { deviceId: 'd-pixel', alias: 'Телефон Миши', mode: 'local-overrides', sourcePolicyId: 'pol-seg-home', policyId: 'pol-dev-pixel' },
      { deviceId: 'd-mbp', alias: 'Ноутбук', mode: 'inherit-actual' },
      { deviceId: 'd-pc', alias: 'Игровой ПК', mode: 'inherit-actual' },
      { deviceId: 'd-tv', alias: 'Телевизор', mode: 'fixed-exit', fixedExit: STREAM },
      { deviceId: 'd-vacuum', alias: 'Пылесос', mode: 'local-overrides', sourcePolicyId: 'pol-tpl-home', policyId: 'pol-dev-vacuum' },
      { deviceId: 'd-ipad', mode: 'inherit-actual' },
    ],
    deviceGroups: [{ id: 'grp-kids', name: 'Детские устройства', deviceIds: ['d-ipad', 'd-oldphone'], policyId: 'pol-grp-kids', priority: 1 }],
    sets: [
      {
        id: 'set-banks', name: 'Банки', kind: 'domains', source: { type: 'manual' },
        entries: ['sberbank.ru', 'online.sberbank.ru', 'tbank.ru', 'vtb.ru', 'alfabank.ru', 'gazprombank.ru', 'raiffeisen.ru', 'mos.ru'],
      },
      {
        id: 'set-blocked', name: 'Список блокировок (IPLIST)', kind: 'domains',
        entries: ['instagram.com', 'facebook.com', 'x.com', 'linkedin.com', 'medium.com', 'soundcloud.com', 'notion.so', '… ещё 4 812'],
        source: {
          type: 'url', url: 'https://iplist.example/lists/ru-blocked.txt', format: 'IPLIST (домены)',
        },
      },
      {
        id: 'set-cdn', name: 'CDN игровых сервисов', kind: 'cidrs',
        entries: ['162.254.192.0/21', '155.133.224.0/19', '185.25.180.0/22'],
        source: {
          type: 'url', url: 'https://lists.example/game-cdn.json', format: 'sing-box rule-set (JSON)',
        },
      },
    ],
    profiles: [
      prof('p-nl-ams', 'NL Amsterdam', 'vless', 'REALITY · TCP', 'nl', 'sub-vpnbox', 'NL-AMS-01 ⚡', 'xray', 'Проверенный действующий адаптер для REALITY', { favorite: true, primary: true }),
      prof('p-ee-tll', 'EE Tallinn', 'vless', 'REALITY · TCP', 'ee', 'sub-vpnbox', 'EE-TLL-02', 'xray', 'Проверенный действующий адаптер для REALITY', { favorite: true }),
      prof('p-nl-rtm', 'NL Rotterdam', 'vless', 'XHTTP · TLS', 'nl', 'sub-vpnbox', 'NL-RTM-XHTTP', 'xray', 'XHTTP поддерживается подтверждённым адаптером Xray'),
      prof('p-us-nyc', 'US New York', 'vless', 'REALITY · gRPC', 'us', 'sub-vpnbox', 'US-NYC-04', 'xray', 'Проверенный действующий адаптер'),
      prof('p-de-fra', 'DE Frankfurt', 'hysteria2', 'QUIC · salamander', 'de', null, '', 'sing-box',
        'Xray 25.9 не поддерживает obfs «salamander» для Hysteria2; sing-box 1.13 поддерживает', { tags: ['стриминг'] }),
      prof('p-fi-hel', 'FI Helsinki', 'trojan', 'TLS · WS', 'fi', null, '', 'xray', 'Совместим с действующим адаптером Xray'),
      {
        id: 'p-awg-office', name: 'Офис AWG', protocol: 'awg', transport: 'AWG 2.0 · UDP', server: 'vpn.work-example.ru:51820', country: 'ru',
        origin: { type: 'file', fileName: 'office-awg2.conf', importedAt: atSeed(60 * 24 * 20) }, tags: ['работа'],
        adapter: { mode: 'auto', engine: 'awg-routehub', reason: 'Файл AWG 2.0 из локального импорта; встроенный адаптер поддерживает это поколение' },
        enabled: true, favorite: false, lifecycle: 'active', note: 'Только для рабочего портала',
      },
      {
        id: 'p-awg-kn', name: 'Keenetic WG‑ASC', protocol: 'awg', transport: 'AWG 1.5 · UDP', server: 'Wireguard1 (KeeneticOS)', country: 'se',
        origin: { type: 'manual' }, tags: [],
        adapter: { mode: 'manual', engine: 'awg-keenetic', reason: 'Использует существующий интерфейс Wireguard1 с ASC' },
        enabled: false, favorite: false, lifecycle: 'active', note: 'Отключён: проверяется после обновления прошивки',
      },
    ],
    exitGroups: [
      {
        id: 'grp-nl-ee', name: 'Нидерланды / Эстония', memberIds: ['p-nl-ams', 'p-ee-tll'], mode: 'failover', pin: null,
        probe: { url: 'https://cp.cloudflare.com/generate_204', intervalSec: 60, samples: 5, minAdvantageMs: 30, switchPauseSec: 120, failThreshold: 3 },
        failAction: { kind: 'suspend' }, revertToPreferred: { enabled: true, delaySec: 300, successStreak: 5 }, autoInclude: null,
      },
      {
        id: 'grp-stream', name: 'Стриминг', memberIds: ['p-de-fra', 'p-fi-hel', 'p-nl-rtm', 'p-us-nyc'], mode: 'best', pin: null,
        probe: { url: 'https://www.netflix.com/favicon.ico', intervalSec: 120, samples: 7, minAdvantageMs: 40, switchPauseSec: 300, failThreshold: 3 },
        failAction: { kind: 'direct', uplinkId: 'isp-main' }, revertToPreferred: { enabled: false, delaySec: 0, successStreak: 0 },
        autoInclude: { subscriptionId: 'sub-vpnbox', filter: 'имя содержит «STREAM»', includeFuture: false },
      },
    ],
    subscriptions: [
      { id: 'sub-vpnbox', name: 'VPNBox', type: 'vless-list', url: 'https://sub.vpnbox.example/api/v1/••••••••3f9a', intervalHours: 12, enabled: true },
      { id: 'sub-lite', name: 'Резерв Lite', type: 'vless-list', url: 'https://lite-vpn.example/s/••••••••c0de', intervalHours: 24, enabled: true },
    ],
    dns: [
      {
        id: 'dns-main', name: 'Домашний DNS', segmentIds: ['Bridge0', 'Bridge1', 'Bridge2'], managed: true,
        primary: { protocol: 'doh', address: 'https://cloudflare-dns.com/dns-query', via: NL_EE },
        fallback: { protocol: 'doh', address: 'https://dns.quad9.net/dns-query', via: DIRECT },
        fallbackDirectAllowed: true, cache: true, blocklists: ['HaGeZi Pro', 'HaGeZi TIF'], exceptions: ['*.sberbank.ru', 'gosuslugi.ru'],
      },
      {
        id: 'dns-office', name: 'Офис (штатный Keenetic)', segmentIds: ['Vlan40'], managed: false,
        primary: { protocol: 'udp', address: 'Штатный резолвер KeeneticOS', via: { kind: 'keenetic' } },
        fallback: null, fallbackDirectAllowed: false, cache: false, blocklists: [], exceptions: [],
      },
    ],
    zapret: [
      { id: 'youtube', enabled: true, segmentIds: ['Bridge0'], strategyId: 'zs-yt-fake', failAction: { kind: 'inherit' } },
      { id: 'discord', enabled: true, segmentIds: [], strategyId: 'zs-dc-split', failAction: NL_EE },
    ],
    games: [
      {
        id: 'gp-cs2', name: 'Counter‑Strike 2', signatureSources: ['Valve SDR relay list', 'RouteHub signatures'], version: '2026.11.04', confidence: 'high',
        families: ['v4'], scenarios: ['match', 'voice', 'update', 'login'], exclusions: ['Steam загрузки (steamcontent.com)'], enabled: true,
        scope: { segmentIds: [], deviceIds: ['d-pc'] }, routeAction: DIRECT, priority: 'intelliqos',
      },
      {
        id: 'gp-valorant', name: 'Valorant', signatureSources: ['RouteHub signatures'], version: '2026.10.21', confidence: 'medium',
        families: ['v4'], scenarios: ['match', 'login', 'launcher'], exclusions: [], enabled: true,
        scope: { segmentIds: [], deviceIds: ['d-pc'] }, routeAction: DIRECT, priority: 'intelliqos',
      },
      {
        id: 'gp-psn', name: 'PlayStation Network', signatureSources: ['IntelliQoS категория «Игры»'], version: 'KeeneticOS', confidence: 'medium',
        families: ['v4'], scenarios: ['match', 'download', 'voice'], exclusions: [], enabled: false,
        scope: { segmentIds: [], deviceIds: ['d-ps5'] }, routeAction: { kind: 'inherit' }, priority: 'intelliqos',
      },
    ],
    checks: [
      { id: 'chk-bank', name: 'Банк из «Дом» напрямую', source: { type: 'segment', segmentId: 'Bridge0' }, target: 'online.sberbank.ru', family: 'v4', proto: 'tcp', port: 443, expect: 'direct', required: true },
      { id: 'chk-gos', name: 'Госуслуги с телефона напрямую', source: { type: 'device', deviceId: 'd-pixel' }, target: 'www.gosuslugi.ru', family: 'v4', proto: 'tcp', port: 443, expect: 'direct', required: true },
      { id: 'chk-ai', name: 'ChatGPT из «Дом» через VPN', source: { type: 'segment', segmentId: 'Bridge0' }, target: 'chatgpt.com', family: 'v4', proto: 'tcp', port: 443, expect: 'vpn', required: true },
      { id: 'chk-yt', name: 'YouTube из «Дом» через Zapret', source: { type: 'segment', segmentId: 'Bridge0' }, target: 'www.youtube.com', family: 'v4', proto: 'tcp', port: 443, expect: 'zapret', required: false },
      { id: 'chk-work', name: 'Рабочий портал с телефона через VPN', source: { type: 'device', deviceId: 'd-pixel' }, target: 'portal.work-example.ru', family: 'v4', proto: 'tcp', port: 443, expect: 'vpn', required: false },
    ],
    autostart: { vpn: true, zapret: true, dns: true, initialPolicy: 'suspend-until-vpn', waitForWanSec: 30 },
  }
}

function prof(
  id: string, name: string, protocol: Config['profiles'][number]['protocol'], transport: string, country: string,
  subscriptionId: string | null, upstreamName: string, engine: Config['profiles'][number]['adapter']['engine'], reason: string,
  extra: Partial<Config['profiles'][number]> = {},
): Config['profiles'][number] {
  return {
    id, name, protocol, transport, country, tags: [], server: `${country}-••••.example:443`,
    origin: subscriptionId
      ? { type: 'subscription', subscriptionId, upstreamName, upstreamKey: `uuid:${id.slice(2)}-7f3c` }
      : { type: 'manual' },
    adapter: { mode: 'auto', engine, reason }, enabled: true, favorite: false, lifecycle: 'active', ...extra,
  }
}

/* ───────────────────────────── runtime ──────────────────────────────── */

export function seedEngines(): EngineInfo[] {
  return [
    { id: 'xray', name: 'Xray', installed: '25.9.11', available: '25.11.2', source: 'GitHub XTLS/Xray-core · подпись SHA-256', ramMb: 38, diskMb: 31, status: 'running', usedBy: 5, capabilities: ['VLESS', 'REALITY', 'XHTTP', 'Trojan', 'gRPC', 'TPROXY'] },
    { id: 'sing-box', name: 'sing-box', installed: '1.13.2', available: '1.13.4', source: 'GitHub SagerNet/sing-box · подпись SHA-256', ramMb: 29, diskMb: 24, status: 'running', usedBy: 1, capabilities: ['Hysteria2', 'VLESS', 'Trojan', 'TUIC'] },
    { id: 'awg-keenetic', name: 'AmneziaWG KeeneticOS', installed: 'встроено (5.0.4)', available: null, source: 'KeeneticOS', ramMb: 0, diskMb: 0, status: 'stopped', usedBy: 0, capabilities: ['AWG 1.0', 'AWG 1.5', 'ASC'] },
    { id: 'awg-routehub', name: 'Встроенный адаптер AmneziaWG', installed: '0.9.3', available: '0.9.3', source: 'RouteHub', ramMb: 6, diskMb: 3, status: 'running', usedBy: 1, capabilities: ['AWG 2.0', 'AWG 3.1'] },
  ]
}

export function seedRuntime(): Runtime {
  const ok = (ms: number, j: number, at = 1): Runtime['profiles'][string] => ({
    state: 'ok', method: 'https', medianMs: ms, jitterMs: j, lossPct: 0, samples: 5, measuredAt: ago(at),
  })
  return {
    link: { state: 'online', latencyMs: 4, lastSyncAt: ago(0.05) },
    wan: { state: 'up', uplinkId: 'isp-main', publicIp: '95.••.••.17' },
    loadedRevision: 148,
    lastApply: { revision: 148, at: ago(60 * 26), result: 'ok' },
    networkChecks: { passed: 4, failed: 0, untested: 1, at: ago(12) },
    services: {
      core: { state: 'running', label: 'Xray 25.9.11 + sing-box 1.13.2', detail: 'Конфигурация r148 загружена' },
      zapret: { state: 'running', label: 'Zapret nfqws', detail: 'Очередь 200, пакеты обрабатываются' },
      dns: { state: 'running', label: 'DoH через «Нидерланды / Эстония»' },
      collector: { state: 'running', label: 'Сбор телеметрии', detail: 'Каждые 5 с, в памяти' },
    },
    profiles: {
      'p-nl-ams': ok(84, 6),
      'p-ee-tll': ok(97, 9),
      'p-nl-rtm': { state: 'degraded', method: 'https', medianMs: 212, jitterMs: 88, lossPct: 20, samples: 5, measuredAt: ago(2), note: '1 из 5 проб не прошла' },
      'p-us-nyc': ok(161, 14, 9),
      'p-de-fra': ok(71, 4),
      'p-fi-hel': { state: 'stale', method: 'https', medianMs: 102, jitterMs: 11, lossPct: 0, samples: 5, measuredAt: ago(60 * 7), note: 'Последний замер 7 ч назад' },
      'p-awg-office': ok(23, 2, 3),
      'p-awg-kn': { state: 'disabled', method: 'handshake' },
    },
    groups: {
      'grp-nl-ee': { selectedProfileId: 'p-nl-ams', reason: 'Первый доступный по порядку', since: ago(60 * 9), state: 'ok', fallback: null },
      'grp-stream': { selectedProfileId: 'p-de-fra', reason: 'Лучший результат: 71 мс, разброс 4 мс, потерь нет', since: ago(60 * 3), state: 'ok', fallback: null },
    },
    sets: {
      'set-blocked': { version: '2026-11-19.2', lastAttempt: ago(42), lastSuccess: ago(42), nextRun: inMin(318), status: 'ok' },
      'set-cdn': {
        version: '2026-11-12', lastAttempt: ago(95), lastSuccess: ago(60 * 24 * 7), nextRun: inMin(25), status: 'failed',
        error: 'HTTP 503 от источника.',
      },
    },
    dns: {
      'dns-main': {
        primary: { state: 'ok', method: 'https', medianMs: 31, samples: 3, measuredAt: ago(1) },
        fallback: { state: 'ok', method: 'https', medianMs: 18, samples: 3, measuredAt: ago(1) },
        active: 'primary',
      },
      'dns-office': { primary: { state: 'untested', method: 'https' }, fallback: null, active: 'none' },
    },
    zapret: {
      youtube: { engine: 'running', packetsSeen: true, payloadCheck: 'ok', effective: 'Zapret · стратегия «fake + split2»' },
      discord: { engine: 'running', packetsSeen: true, payloadCheck: 'ok', effective: 'Zapret · стратегия «disorder + fake TLS»' },
    },
    engines: seedEngines(),
    trial: null,
  }
}

/* ───────────────────────────── catalogues ───────────────────────────── */

export function seedStrategies(): ZapretStrategy[] {
  return [
    { id: 'zs-yt-fake', name: 'fake + split2', service: 'youtube', protos: ['tcp'], readiness: 'ready', kernelDependency: 'nfnetlink_queue', queueOwner: 'nfqws (очередь 200)' },
    { id: 'zs-yt-quic', name: 'fake QUIC + disorder', service: 'youtube', protos: ['tcp', 'udp'], readiness: 'experimental', kernelDependency: 'nfnetlink_queue, xt_connbytes', queueOwner: 'nfqws (очередь 200)' },
    { id: 'zs-yt-multisplit', name: 'multisplit SNI', service: 'youtube', protos: ['tcp'], readiness: 'ready', kernelDependency: 'nfnetlink_queue', queueOwner: 'nfqws (очередь 200)' },
    { id: 'zs-dc-split', name: 'disorder + fake TLS', service: 'discord', protos: ['tcp'], readiness: 'ready', kernelDependency: 'nfnetlink_queue', queueOwner: 'nfqws (очередь 201)' },
    { id: 'zs-dc-tcp-reserve', name: 'Резервный TCP', service: 'discord', protos: ['tcp'], readiness: 'ready', kernelDependency: 'Совместимо в макете', queueOwner: 'Демонстрационная очередь' },
    { id: 'zs-dc-voice', name: 'fake UDP (голос)', service: 'discord', protos: ['udp'], readiness: 'needs-kernel-module', kernelDependency: 'xt_u32 — модуль отсутствует в ядре KeeneticOS 5.0.4', queueOwner: 'nfqws (очередь 201)' },
  ]
}

export function seedGeo(): GeoSource[] {
  return [
    { id: 'geosite', kind: 'geosite', name: 'v2fly domain-list-community', version: '2026-11-18', sizeKb: 2240, tags: 1412, lastCheck: ago(60 * 5), status: 'ok', usedTags: ['ru-blocked', 'category-ads-all', 'netflix', 'disney', 'discord', 'tiktok'] },
    { id: 'geoip', kind: 'geoip', name: 'Loyalsoldier geoip', version: '2026-11-14', sizeKb: 5120, tags: 251, lastCheck: ago(60 * 5), status: 'stale', error: 'Новая версия не прошла проверку подписи — используется 2026-11-14', usedTags: [] },
  ]
}

export function seedSubscriptionStatus(): SubscriptionStatus[] {
  return [
    { subscriptionId: 'sub-vpnbox', lastSuccess: { at: ago(60 * 4), revision: 'snap-0042', profiles: 4 }, lastAttempt: { at: ago(60 * 4), ok: true }, nextRun: inMin(60 * 8) },
    { subscriptionId: 'sub-lite', lastSuccess: { at: ago(60 * 30), revision: 'snap-0007', profiles: 0 }, lastAttempt: { at: ago(60 * 6), ok: false, code: 'EMPTY_RESPONSE', reason: 'Поставщик вернул пустой список. Сохранён предыдущий снимок snap-0007.' }, nextRun: inMin(60 * 18) },
  ]
}

export function seedFlows(): ClassifiedFlow[] {
  return [
    { id: 'f-cs-match', deviceId: 'd-pc', app: 'Counter‑Strike 2', category: 'match', confidence: 'high', detectedAt: 'open', dst: '155.133.252.37:27031', proto: 'udp', route: 'Напрямую · Ростелеком', priority: 'IntelliQoS «Игры»', note: 'Сигнатура Valve SDR при открытии соединения → прямой маршрут для этого потока. Остальной трафик ПК по своей политике.' },
    { id: 'f-cs-update', deviceId: 'd-pc', app: 'Counter‑Strike 2', category: 'update', confidence: 'high', detectedAt: 'open', dst: 'cache4-fra1.steamcontent.com:443', proto: 'tcp', route: 'По политике: правило «Steam загрузки напрямую»', priority: 'Обычный', note: 'Обновление игры не входит в автоматику — идёт по штатной политике устройства.' },
    { id: 'f-val-late', deviceId: 'd-pc', app: 'Valorant', category: 'match', confidence: 'medium', detectedAt: 'late', dst: '43.229.65.10:7120', proto: 'udp', route: 'Без изменений (поток уже открыт)', priority: 'IntelliQoS «Игры»', note: 'Сигнал появился после открытия соединения: доступен только приоритет и диагностика. Новые соединения матча получат прямой маршрут.' },
    { id: 'f-val-blocked', deviceId: 'd-pc', app: 'Valorant', category: 'login', confidence: 'medium', detectedAt: 'open', dst: 'auth.riotgames.com:443', proto: 'tcp', route: 'VPN «Нидерланды / Эстония»', priority: 'Обычный', note: 'Явное VPN-правило «Заблокированные ресурсы» сохраняет приоритет над игровым сигналом.' },
    { id: 'f-ps5-unknown', deviceId: 'd-ps5', app: 'Неизвестно', category: 'unknown', confidence: 'none', detectedAt: 'open', dst: '52.40.••.••:3478', proto: 'udp', route: 'По политике сегмента «Дом»', priority: 'Обычный', note: 'Классификация недоступна для этого устройства: пресет PSN выключен, общий UDP сам по себе не даёт права на переключение.' },
  ]
}

export function seedUpdates(): UpdateInfo[] {
  return [
    {
      component: 'routehub', name: 'RouteHub', current: '2.4.0', target: '2.5.0-beta.2', channel: 'beta', state: 'available', signature: 'verified', autoUpdate: false,
      checks: [], history: [{ at: ago(60 * 24 * 12), from: '2.3.4', to: '2.4.0', result: 'ok' }],
    },
    {
      component: 'xray', name: 'Ядро Xray', current: '25.9.11', target: '25.11.2', channel: 'stable', state: 'available', signature: 'verified', autoUpdate: false,
      checks: [], history: [{ at: ago(60 * 24 * 40), from: '25.7.26', to: '25.9.11', result: 'ok' }, { at: ago(60 * 24 * 41), from: '25.7.26', to: '25.9.10', result: 'rolled-back' }],
    },
    {
      component: 'sing-box', name: 'Ядро sing-box', current: '1.13.2', target: '1.13.4', channel: 'stable', state: 'available', signature: 'verified', autoUpdate: false,
      checks: [], history: [],
    },
    {
      component: 'zapret', name: 'Zapret', current: '71.4', target: null, channel: 'stable', state: 'up-to-date', signature: 'verified', autoUpdate: true,
      checks: [], history: [{ at: ago(60 * 24 * 5), from: '71.3', to: '71.4', result: 'ok' }],
    },
    {
      component: 'geodata', name: 'GeoIP / GeoSite', current: '2026-11-18', target: '2026-11-19', channel: 'stable', state: 'available', signature: 'unverified', autoUpdate: true,
      checks: [], history: [{ at: ago(60 * 5), from: '2026-11-14', to: '2026-11-19', result: 'failed' }],
    },
  ]
}

export function seedRevisions(): Revision[] {
  return [
    { revision: 148, at: ago(60 * 26), by: 'Панель · 192.168.1.20', summary: 'Пылесос: локальные переопределения', result: 'ok', changes: 2 },
    { revision: 147, at: ago(60 * 50), by: 'Панель · 192.168.1.20', summary: 'Группа «Стриминг»: временный прямой выход при отказе', result: 'ok', changes: 1 },
    { revision: 146, at: ago(60 * 52), by: 'Панель · 192.168.1.20', summary: 'Пробное применение на Pixel‑8 (истекло)', result: 'trial-expired', changes: 1 },
    { revision: 145, at: ago(60 * 24 * 3), by: 'Импорт · cdn.txt', summary: 'Импорт: 1 правило CIDR в «Общие правила»', result: 'ok', changes: 1 },
    { revision: 144, at: ago(60 * 24 * 4), by: 'Обновление 2.4.0', summary: 'Миграция порядка правил из 2.3.4', result: 'ok', changes: 12 },
    { revision: 143, at: ago(60 * 24 * 4.1), by: 'Панель · 192.168.1.20', summary: 'DNS: резервный DoH напрямую', result: 'rolled-back', changes: 1 },
  ]
}

export function seedEvents(): JournalEvent[] {
  return [
    { id: 'e1', at: ago(9), type: 'profile', severity: 'warn', object: { kind: 'profile', id: 'p-nl-rtm', name: 'NL Rotterdam' }, title: 'Профиль работает с ухудшением', detail: '1 из 5 HTTPS-проб не прошла, медиана 212 мс.' },
    { id: 'e2', at: ago(42), type: 'subscription', severity: 'ok', object: { kind: 'set', id: 'set-blocked', name: 'Список блокировок' }, title: 'Набор обновлён до 2026-11-19.2', detail: '+38 записей, −4. Обязательные проверки пройдены.' },
    { id: 'e3', at: ago(95), type: 'subscription', severity: 'error', object: { kind: 'set', id: 'set-cdn', name: 'CDN игровых сервисов' }, title: 'Не удалось обновить набор', detail: 'HTTP 503. Используется последняя пригодная версия от 12 ноября.' },
    { id: 'e4', at: ago(60 * 3), type: 'failover', severity: 'info', object: { kind: 'group', id: 'grp-stream', name: 'Стриминг' }, title: 'Выбран DE Frankfurt', facts: [['Было', 'FI Helsinki'], ['Стало', 'DE Frankfurt'], ['Причина', 'Замер FI устарел; DE — лучший из подтверждённых (71 мс)'], ['Правил затронуто', '2']] },
    { id: 'e5', at: ago(60 * 4), type: 'subscription', severity: 'ok', object: { kind: 'subscription', id: 'sub-vpnbox', name: 'VPNBox' }, title: 'Подписка обновлена · snap-0042', detail: '4 профиля, изменений нет.' },
    { id: 'e6', at: ago(60 * 6), type: 'subscription', severity: 'warn', object: { kind: 'subscription', id: 'sub-lite', name: 'Резерв Lite' }, title: 'Пустой ответ подписки', detail: 'Сохранён предыдущий снимок snap-0007.' },
    { id: 'e7', at: ago(60 * 26), type: 'apply', severity: 'ok', object: { kind: 'revision', name: 'r148' }, title: 'Применена ревизия r148', detail: 'Проверка конфигурации, доступ к панели и контрольный трафик — успешно.' },
    { id: 'e8', at: ago(60 * 52), type: 'trial', severity: 'warn', object: { kind: 'device', id: 'd-pixel', name: 'Pixel‑8' }, title: 'Пробное применение истекло — восстановлена r145', detail: 'Подтверждение не получено за 120 с. Сервер вернул прежнюю конфигурацию.' },
    { id: 'e9', at: ago(60 * 24 * 4.1), type: 'rollback', severity: 'error', object: { kind: 'revision', name: 'r143' }, title: 'Откат r143: DNS недоступен после применения', detail: 'Контрольное разрешение имён не прошло. Восстановлена r142, откат проверен.' },
    { id: 'e10', at: ago(60 * 5), type: 'update', severity: 'error', object: { kind: 'component', name: 'GeoIP' }, title: 'GeoIP 2026-11-19 не прошёл проверку подписи', detail: 'Используется 2026-11-14.' },
  ]
}
