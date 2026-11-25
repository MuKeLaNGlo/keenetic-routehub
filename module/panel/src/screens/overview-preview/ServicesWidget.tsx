import type { ReactNode } from 'react'
import { Boxes, ChevronRight, Cpu, Globe, Waves, Wifi, type LucideIcon } from 'lucide-react'
import type { Runtime } from '@/api/contract'
import { Mono } from '@/components/rh/controls'
import { SERVICE, StatusDot, type Tone } from '@/components/rh/status'
import { cn } from '@/lib/utils'
import { href } from '@/state/router'

const services = [
  { id: 'core', label: 'Ядра VPN', icon: Cpu, to: href('/exits-preview', { tab: 'engines' }) },
  { id: 'zapret', label: 'Zapret', icon: Waves, to: href('/zapret-preview') },
  { id: 'dns', label: 'DNS', icon: Boxes, to: href('/dns-preview') },
  { id: 'collector', label: 'Сбор телеметрии', icon: Wifi, to: href('/journal-preview', { tab: 'telemetry' }) },
] as const

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring'

interface ServiceRow {
  id: string
  label: string
  icon: LucideIcon
  status: { tone: Tone; label: string }
  detail?: ReactNode
  to?: string
}

export function ServicesWidget({ runtime, unavailable }: { runtime?: Runtime; unavailable: boolean }) {
  const data = unavailable ? undefined : runtime
  const unknown = { tone: 'muted', label: unavailable ? 'Нет данных' : 'Загрузка…' } as const
  const rows: ServiceRow[] = [
    {
      id: 'wan',
      label: 'Интернет (WAN)',
      icon: Globe,
      detail: data?.wan.publicIp && <Mono className="text-[12px]">{data.wan.publicIp}</Mono>,
      status: data ? {
        tone: data.wan.state === 'up' ? 'ok' : data.wan.state === 'down' ? 'bad' : 'muted',
        label: data.wan.state === 'up' ? 'Работает' : data.wan.state === 'down' ? 'Нет связи' : 'Нет замера',
      } : unknown,
    },
    ...services.map(({ id, label, icon, to }) => {
      const service = data?.services[id]
      return { id, label: service?.label ?? label, icon, to, status: service ? SERVICE[service.state] : unknown, detail: service?.detail }
    }),
  ]
  const rowClass = 'flex min-h-12 h-full items-center gap-2.5 px-3 py-1.5'

  return (
    <section aria-labelledby="preview-services">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 id="preview-services" className="text-[15px] font-semibold">Службы</h2>
        <a
          href={href('/system-preview', { tab: 'updates' })}
          className={cn('inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground', focus)}
        >
          Версии
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </a>
      </div>
      <ul className="overview-preview__services" aria-busy={!data && !unavailable}>
        {rows.map(({ id, label, icon: Icon, status, detail, to }) => {
          const content = (
            <>
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block text-[13px] leading-tight font-medium">{label}</span>
                {detail && <span className="mt-0.5 block text-[12px] leading-tight text-muted-foreground">{detail}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] leading-tight text-muted-foreground">
                <StatusDot tone={status.tone} className="scale-75" />
                {status.label}
              </span>
            </>
          )
          return (
            <li key={id} className="overview-preview__service">
              {to ? <a href={to} className={cn(rowClass, 'hover:bg-surface-2', focus)}>{content}</a> : <div className={rowClass}>{content}</div>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
