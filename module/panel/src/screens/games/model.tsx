import { Clock, Layers, Route, ShieldCheck } from 'lucide-react'
import type { Capabilities } from '@/api/contract'
import { useCaps } from '@/state/resource'
import { Panel } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { CapabilityNote } from '@/components/rh/coverage'

const RULES = [
  {
    icon: <Route />,
    title: 'Классификатор выделяет соединение',
    text: 'Матч и голос определяются по сигнатурам назначений и протоколов — в момент открытия соединения, а не по устройству целиком.',
  },
  {
    icon: <Layers />,
    title: 'Остальной трафик остаётся на своей политике',
    text: 'Маршрут применяется к конкретному игровому потоку. Обновления, лаунчер, браузер и всё прочее идут по правилам устройства и сети.',
  },
  {
    icon: <ShieldCheck />,
    title: 'Явное правило важнее сигнала',
    text: 'Блокировка или обязательный VPN в политике устройства побеждают даже уверенную классификацию — игровой сигнал уступает.',
  },
  {
    icon: <Clock />,
    title: 'Поздний сигнал меняет только приоритет',
    text: 'Если сигнал появился после открытия, путь уже открытого потока не меняется: доступны приоритет, статистика и диагностика, а новые соединения матча получат маршрут.',
  },
]

const EXACT_RULES = [
  { icon: <Route />, title: 'Точное назначение', text: 'Пресет сопоставляет внешний IPv4, порт, протокол и устройство. Потоки в списке отмечаются по текущему сохранённому пресету.' },
  { icon: <Layers />, title: 'Прямой маршрут для новых TCP-соединений', text: 'Требуются закреплённый IPv4 и режим «Унаследовать и дополнить» в политике устройства.' },
  { icon: <ShieldCheck />, title: 'Явные правила имеют приоритет', text: 'Настроенные правила VPN, блокировки и другие явные назначения сохраняют приоритет над игровым совпадением.' },
  { icon: <Clock />, title: 'Наблюдение UDP', text: 'Совпадение UDP видно в замере. Маршрутизация UDP и сетевой приоритет пресетом на этой установке не меняются.' },
]

/** The model in four sentences — read before any preset below. */
export function ModelPanel({ exact = false }: { exact?: boolean }) {
  return (
    <Panel>
      <ol className="divide-y divide-border">
        {(exact ? EXACT_RULES : RULES).map((r, i) => (
          <li key={r.title} className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70 [&>svg]:size-3.5">{r.icon}</span>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">
                {!exact && <span className="tabular mr-1.5 text-muted-foreground">{i + 1}.</span>}
                {r.title}
              </div>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{r.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

const CAPS: { key: keyof Capabilities['gameRouting']; title: string; text: string }[] = [
  {
    key: 'routeAtOpen',
    title: 'Маршрут при открытии соединения',
    text: 'Если сигнатура известна к моменту открытия, поток получает игровой маршрут. Новые соединения учитывают изменение сразу.',
  },
  {
    key: 'lateSignalPriority',
    title: 'Приоритет при позднем сигнале',
    text: 'Для уже открытых потоков — приоритет, статистика и диагностика. Маршрут такого потока не меняется.',
  },
  {
    key: 'intelliQos',
    title: 'Приоритет IntelliQoS по категории',
    text: 'Штатная категория «Игры» приоритизирует трафик в своей области действия — это не то же самое, что строгий приоритет отдельного потока.',
  },
  {
    key: 'strictPriority',
    title: 'Строгий приоритет отдельных потоков',
    text: 'Требует отдельно проверенной интеграции с IntelliQoS: без неё приоритет остаётся категорийным.',
  },
]

/** Each routing capability the install reports, including the ones it cannot do. */
export function CapabilityGrid() {
  const { data: caps } = useCaps()
  if (!caps) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {CAPS.map((c) => {
        const availability = caps.gameRouting[c.key]
        return (
          <div key={c.key} className="space-y-2 rounded-xl bg-card px-4 py-3 ring-1 ring-border">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-medium">{c.title}</span>
              {availability.available ? <StatusBadge tone="info">Доступно</StatusBadge> : null}
            </div>
            <p className="text-[12px] leading-relaxed text-muted-foreground">{c.text}</p>
            <CapabilityNote availability={availability}>Недоступно на этой установке</CapabilityNote>
          </div>
        )
      })}
    </div>
  )
}
