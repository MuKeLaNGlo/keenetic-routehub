import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { FlaskRound, RotateCcw, UserPlus, ArrowRight, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { mock } from '@/api'
import type { ScenarioFlags } from '@/api/mock/scenarios'
import { DetailSheet } from '@/components/rh/sheet'
import { Segmented } from '@/components/rh/controls'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { navigate, closeQuery, setQuery, useRoute } from '@/state/router'
import { draftStore } from '@/state/draft'
import { refetch } from '@/state/resource'
import { cn } from '@/lib/utils'

/**
 * Mock-only control room: flips the simulated router into the states the spec
 * asks to demonstrate. Overlays are applied on read, so nothing here corrupts
 * the persisted state; "Сбросить" reseeds everything.
 */

type DemoRouter = NonNullable<typeof mock>

function useFlags(router: DemoRouter): ScenarioFlags {
  const [f, setF] = useState(router.getFlags())
  useEffect(() => router.subscribe(() => setF(router.getFlags())), [router])
  return f
}

type Bool = { [K in keyof ScenarioFlags]: ScenarioFlags[K] extends boolean ? K : never }[keyof ScenarioFlags]

const GROUPS = { connection: 'Связь и доступ', vpn: 'VPN и подписки', services: 'DNS и Zapret', system: 'Обслуживание и телеметрия' }
type Group = keyof typeof GROUPS

const TOGGLES: { group: Group; key: Bool; label: string; hint: string }[] = [
  { group: 'connection', key: 'readOnly', label: 'Ключ только для чтения', hint: 'Сессия видит всё, но не может сохранять' },
  { group: 'vpn', key: 'nlDown', label: 'NL Amsterdam недоступен', hint: 'Группа NL/EE переключается на Таллин' },
  { group: 'vpn', key: 'nlEeDown', label: 'Вся группа NL/EE недоступна', hint: 'При отказе соединения приостанавливаются' },
  { group: 'vpn', key: 'streamDown', label: 'Группа «Стриминг» недоступна', hint: 'Разрешён временный прямой резерв' },
  { group: 'services', key: 'dnsPrimaryFail', label: 'Основной DNS не отвечает', hint: 'Переход на резерв, если он доступен' },
  { group: 'services', key: 'zapretYtPartial', label: 'YouTube: видео не грузится', hint: 'Главная доступна, видео и комментарии нет' },
  { group: 'services', key: 'zapretQueueFail', label: 'Очередь Zapret не обслуживается', hint: 'Сервисы переходят на обычную политику' },
  { group: 'vpn', key: 'subscriptionFails', label: 'Подписка не загружается', hint: 'Остаётся рабочий снимок' },
  { group: 'system', key: 'applyFails', label: 'Применение падает на ядре', hint: 'Роутер восстанавливает прежнюю ревизию' },
  { group: 'connection', key: 'iotMovedToGuest', label: 'Пылесос переехал в «Гости»', hint: 'Меняется сегмент устройства' },
]

const CHECKS: { n: number; title: string; how: string; to: string; flags?: Partial<ScenarioFlags> }[] = [
  { n: 1, title: 'Сегменты и SSID', how: 'Дом, Гости, IoT раздельно; две SSID на одном мосту — политика по SSID недоступна и объяснена.', to: '/networks' },
  { n: 2, title: 'Наследование шаблона', how: 'Пылесос (IoT) наследует «Домашний шаблон», переопределяет и отключает правило. Включите переезд в «Гости» и сравните в «Проверке».', to: '/devices?d=d-vacuum' },
  { n: 3, title: 'Импорт правил и конфликт ревизий', how: 'Правила → Импорт. Дубликат, неподдерживаемая строка. Затем «Другая вкладка сохраняет» и примените черновик. Сравните домен и IP на общем CDN в «Проверке».', to: '/rules?import=1' },
  { n: 4, title: 'Импорт профилей', how: 'VLESS, Hysteria2, Trojan, два AWG: автоопределение, неоднозначный AWG, недоступное ядро, транспорт другого движка.', to: '/exits?tab=profiles&import=1' },
  { n: 5, title: 'Подписки', how: 'Обновите VPNBox: один профиль исчез, один переименован, псевдонимы сохранены. Отдельно — сбой загрузки.', to: '/exits?tab=subscriptions' },
  { n: 6, title: 'Отказ и резерв групп', how: 'Переключение NL → EE, полный отказ (приостановка), прямой резерв у «Стриминга». Смотрите в «Проверке».', to: '/exits?tab=groups', flags: { nlDown: true } },
  { n: 7, title: 'Zapret', how: 'Проверка YouTube и Discord; частичный сбой YouTube; выключение Zapret для YouTube возвращает обычную политику.', to: '/zapret', flags: { zapretYtPartial: true } },
  { n: 8, title: 'DNS', how: 'Норма, сбой основного, резерв, локальное имя. Офис — DNS не управляется модулем.', to: '/dns', flags: { dnsPrimaryFail: true } },
  { n: 9, title: 'Телеметрия и журнал', how: 'Период графика, неполная история, событие резервного выхода, экспорт с маскировкой.', to: '/journal' },
  { n: 10, title: 'Обновление ядра', how: 'Проверка совместимости; отказ по месту/версии; успешное обновление; возврат после неуспешной проверки.', to: '/system?tab=updates' },
  { n: 11, title: 'Ограничения возможностей', how: 'Только чтение, IPv4 TCP, IPv4 UDP частично, IPv6 не испытан — в операциях и проверках.', to: '/trace', flags: { readOnly: true } },
  { n: 12, title: 'Пробное применение', how: 'Измените правило одного устройства → План (одна проверка предупреждает) → Опробовать. Подтвердите или дождитесь истечения.', to: '/devices?d=d-pixel' },
  { n: 13, title: 'Черновик и история', how: 'Создайте черновик, переходите между разделами, Назад/Вперёд, закройте диалог кликом снаружи — черновик на месте, ревизия та же.', to: '/rules' },
]

export function ScenarioLab() {
  return mock ? <ScenarioLabContent router={mock} /> : null
}

function ScenarioLabContent({ router }: { router: DemoRouter }) {
  const route = useRoute()
  const open = route.query.get('lab') === '1'
  const f = useFlags(router)
  const set = (p: Partial<ScenarioFlags>) => router.setFlags(p)

  return (
    <DetailSheet open={open} onClose={() => closeQuery('lab')} title="Лаборатория сценариев" description="Только в макете: переводит имитацию роутера в нужные состояния." width="lg">
      <Tabs defaultValue="scenarios" className="min-w-0 gap-3">
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Лаборатория сценариев" className="h-9 max-w-full p-0">
            <TabsTrigger value="scenarios" className="px-2.5 after:bottom-[-3px]">Сценарии</TabsTrigger>
            <TabsTrigger value="state" className="px-2.5 after:bottom-[-3px]">Состояние роутера</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="scenarios">
          <ol className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            {CHECKS.map((c) => (
              <li key={c.n} className="flex gap-3 bg-card px-3.5 py-3">
                <span className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{c.n}</span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-[13.5px] font-medium">{c.title}</div>
                  <div className="text-[12.5px] leading-relaxed text-muted-foreground">{c.how}</div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 self-center"
                  onClick={() => {
                    if (c.flags) set(c.flags)
                    navigate(c.to)
                  }}
                >
                  Открыть <ArrowRight />
                </Button>
              </li>
            ))}
          </ol>
        </TabsContent>

        <TabsContent value="state" className="space-y-4">
          <div className="divide-y overflow-hidden rounded-xl border border-border bg-card">
            {(Object.entries(GROUPS) as [Group, string][]).map(([group, title]) => {
              const toggles = TOGGLES.filter((toggle) => toggle.group === group)
              const active = toggles.filter(({ key }) => f[key]).length
                + (group === 'connection' && f.link !== 'online' ? 1 : 0)
                + (group === 'system' ? Number(f.telemetry !== 'ok') + Number(f.updateOutcome !== 'ok') : 0)
              return (
                <details key={group} name="scenario-setting-groups" className="group">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-[13.5px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1">{title}</span>
                    {!!active && <span className="text-xs text-warn">Активно {active}</span>}
                    <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180" />
                  </summary>
                  <div className="divide-y border-t border-border bg-muted/25">
                    {toggles.map((toggle) => (
                      <label key={toggle.key} className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px]">{toggle.label}</div>
                          <div className="text-xs text-muted-foreground">{toggle.hint}</div>
                        </div>
                        <Switch checked={f[toggle.key]} onCheckedChange={(value) => set({ [toggle.key]: value })} />
                      </label>
                    ))}
                    {group === 'connection' && (
                      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1 text-[13px]">Связь с роутером</div>
                        <Segmented size="sm" aria-label="Связь с роутером" value={f.link} onChange={(link) => set({ link })} options={[{ value: 'online', label: 'Норма' }, { value: 'slow', label: 'Медленно' }, { value: 'offline', label: 'Нет' }]} />
                      </div>
                    )}
                    {group === 'system' && (
                      <>
                        <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                          <div className="min-w-0 flex-1 text-[13px]">Телеметрия</div>
                          <Segmented
                            size="sm"
                            aria-label="Телеметрия"
                            className="max-w-full flex-wrap"
                            value={f.telemetry}
                            onChange={(telemetry) => set({ telemetry })}
                            options={[
                              { value: 'ok', label: 'Норма' },
                              { value: 'fresh', label: 'Новая' },
                              { value: 'gap', label: 'Пропуск' },
                              { value: 'stale', label: 'Устарела' },
                              { value: 'error', label: 'Ошибка' },
                            ]}
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                          <div className="min-w-0 flex-1 text-[13px]">Исход обновления</div>
                          <Segmented
                            size="sm"
                            aria-label="Исход обновления"
                            className="max-w-full flex-wrap"
                            value={f.updateOutcome}
                            onChange={(updateOutcome) => set({ updateOutcome })}
                            options={[
                              { value: 'ok', label: 'Успех' },
                              { value: 'no-space', label: 'Нет места' },
                              { value: 'incompatible', label: 'Версия' },
                              { value: 'verify-fail', label: 'Возврат' },
                            ]}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </details>
              )
            })}
          </div>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold">Действия</h3>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  router.simulateOtherWriter()
                  toast('Другая вкладка сохранила новую ревизию', { description: 'Вкладка 2 · 192.168.1.34: псевдоним NL и правило Steam' })
                }}
              >
                <UserPlus /> Другая вкладка сохраняет
              </Button>
              <Button
                variant="outline"
                className="text-bad"
                onClick={() => {
                  router.reset()
                  draftStore.discard()
                  ;['caps', 'topology', 'config', 'runtime', 'events', 'tasks', 'revisions', 'subs', 'updates'].forEach((k) => void refetch(k))
                  toast.success('Имитация роутера сброшена к исходным данным')
                }}
              >
                <RotateCcw /> Сбросить всё
              </Button>
            </div>
          </section>
        </TabsContent>
      </Tabs>
    </DetailSheet>
  )
}

type ScenarioLabButtonProps = { inline?: boolean; onOpen?: () => void }

export function ScenarioLabButton(props: ScenarioLabButtonProps) {
  return mock ? <ScenarioLabDemoButton router={mock} {...props} /> : null
}

function ScenarioLabDemoButton({ router, inline, onOpen }: ScenarioLabButtonProps & { router: DemoRouter }) {
  const f = useFlags(router)
  const active = Object.entries(f).filter(([k, v]) => (typeof v === 'boolean' ? v : k === 'link' ? v !== 'online' : k === 'telemetry' ? v !== 'ok' : k === 'updateOutcome' ? v !== 'ok' : false)).length
  const go = () => {
    onOpen?.()
    setQuery({ lab: '1' })
  }
  if (inline)
    return (
      <Button variant="outline" className="w-full" onClick={go}>
        <FlaskRound /> Лаборатория сценариев {active > 0 && `· ${active}`}
      </Button>
    )
  return (
    <motion.button
      onClick={go}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        'pressable material-strong shadow-float fixed right-5 bottom-5 z-30 hidden h-9 items-center gap-2 rounded-full px-3.5 text-[12.5px] font-medium ring-1 ring-border md:inline-flex',
        active > 0 && 'ring-warn/50',
      )}
      title="Только в макете"
    >
      <FlaskRound className="size-4" />
      Сценарии
      {active > 0 && <span className="tabular rounded-full bg-warn/20 px-1.5 text-warn">{active}</span>}
    </motion.button>
  )
}
