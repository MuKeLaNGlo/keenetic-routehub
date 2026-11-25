import { useState } from 'react'
import { ChevronRight, ListTree, Route, Wifi } from 'lucide-react'
import type { Segment } from '@/api/contract'
import { ActionChip, ActionPicker } from '@/components/rh/action'
import { Mono, Segmented, SimpleSelect, WriteButton } from '@/components/rh/controls'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { EmptyState, KV } from '@/components/rh/layout'
import { DetailSheet } from '@/components/rh/sheet'
import { StatusDot, type Tone } from '@/components/rh/status'
import { buttonVariants } from '@/components/ui/button'
import { SavingSwitch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { deviceIp, deviceName } from '@/lib/entities'
import { count } from '@/lib/format'
import { cn } from '@/lib/utils'
import { InlineSetting } from '@/screens/inline-setting'
import { type SegmentEditor, useSegmentEditor } from '@/screens/networks/use-segment-editor'
import { useTopology } from '@/state/resource'
import { closeQuery, href } from '@/state/router'

const states: Record<Segment['state'], { label: string; tone: Tone }> = {
  up: { label: 'Сеть поднята', tone: 'ok' },
  down: { label: 'Сеть опущена', tone: 'bad' },
  removed: { label: 'Сеть удалена', tone: 'muted' },
}

const quickLink = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-9')
const focus = 'focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2'
const actionValue = 'h-auto min-h-6 max-w-full py-0.5 [&>span]:whitespace-normal [&>span]:[overflow-wrap:anywhere]'

export function SegmentPreviewSheet({ segmentId }: { segmentId: string | null }) {
  const { data } = useTopology()
  const segment = data?.segments.find((item) => item.id === segmentId)

  return (
    <DetailSheet
      open={!!segmentId}
      fixedMobileHeight
      onClose={() => closeQuery('s')}
      title={segment?.name ?? 'Сегмент не найден'}
      description={segment && (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <StatusDot tone={states[segment.state].tone} /> {states[segment.state].label}
        </span>
      )}
    >
      {segment ? <SegmentViews key={segment.id} segment={segment} /> : (
        <EmptyState title="Сегмента нет в списке Keenetic" />
      )}
    </DetailSheet>
  )
}

function SegmentViews({ segment }: { segment: Segment }) {
  const editor = useSegmentEditor(segment)
  if (!editor) return null

  return (
    <Tabs defaultValue="routes" className="min-w-0 gap-3">
      <div className="border-b border-border">
        <TabsList variant="line" aria-label="Разделы сегмента" className="h-9 max-w-full p-0">
          <TabsTrigger value="routes" className="px-2 text-xs after:bottom-[-3px] sm:px-3">Маршрут</TabsTrigger>
          <TabsTrigger value="devices" className="px-2 text-xs after:bottom-[-3px] sm:px-3">
            Устройства <span className="tabular text-muted-foreground">{editor.devices.length}</span>
          </TabsTrigger>
          <TabsTrigger value="details" className="px-2 text-xs after:bottom-[-3px] sm:px-3">Параметры</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="routes"><RoutingSummary segment={segment} editor={editor} /></TabsContent>
      <TabsContent value="devices"><SegmentDevices segment={segment} editor={editor} /></TabsContent>
      <TabsContent value="details"><SegmentParameters segment={segment} editor={editor} /></TabsContent>
    </Tabs>
  )
}

function RoutingSummary({ segment, editor }: { segment: Segment; editor: SegmentEditor }) {
  const { sp, policy, excluded, take, repair, setMode } = editor
  const removed = segment.state === 'removed'
  const routable = !removed && segment.routable.available
  const managed = !!sp && !!policy && !excluded && routable
  const note = !routable
    ? segment.routable.reason
    : excluded
      ? 'Сегмент исключён из RouteHub.'
      : !sp
        ? 'Политика RouteHub ещё не назначена.'
        : !policy
          ? 'Назначенная политика отсутствует в конфигурации.'
          : undefined

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[14px] font-semibold">{removed ? 'Сегмент недоступен' : managed ? 'Управляет RouteHub' : 'Управляет Keenetic'}</h3>
        </div>
        {managed && policy && (
          <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Политика «{policy.name}» · {count(policy.rules.length, ['правило', 'правила', 'правил'])}
          </p>
        )}
        {note && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{note}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {policy && (
            <a href={href('/rules-preview', { policy: policy.id })} className={quickLink}>
              <ListTree aria-hidden="true" /> Правила сети
            </a>
          )}
          <a href={href('/trace-preview', { src: `segment:${segment.id}` })} className={quickLink}>
            <Route aria-hidden="true" /> Проверить маршрут
          </a>
        </div>
      </div>

      {routable && !sp && <WriteButton variant="outline" size="sm" onClick={take}>Включить RouteHub</WriteButton>}
      {routable && sp && !policy && <WriteButton variant="outline" size="sm" onClick={repair}>Восстановить политику</WriteButton>}
      {routable && excluded && policy && <WriteButton variant="outline" size="sm" onClick={() => setMode('managed')}>Включить RouteHub</WriteButton>}
      {sp && !removed && <RoutingSettings segment={segment} editor={editor} />}
    </div>
  )
}

function RoutingSettings({ segment, editor }: { segment: Segment; editor: SegmentEditor }) {
  const [editing, setEditing] = useState<'mode' | 'parent' | 'default' | 'fallback' | null>(null)
  const {
    policy, can, excluded, chain, parentCandidates, cycleError, setMode,
    setParent, setDefaultAction, setFallbackAction, toggleFallback,
  } = editor
  const parentName = policy?.parentId
    ? chain.chain.slice(1).map(({ name }) => name).join(' → ') || 'Родительская политика не найдена'
    : 'Только правила этой сети'

  return (
    <div className="min-w-0 rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5">
        <h3 className="text-sm font-semibold">Настройки маршрутизации</h3>
        <ReadOnlyHint />
      </div>
      <div className="grid min-w-0 gap-5 p-3.5">
        <InlineSetting
          title="Управление трафиком"
          value={excluded ? 'Keenetic' : segment.routable.available ? 'RouteHub' : 'RouteHub недоступен в этой сети'}
          editable={can}
          open={editing === 'mode'}
          onToggle={() => setEditing(editing === 'mode' ? null : 'mode')}
        >
          <Segmented
            size="sm"
            aria-label="Кто управляет трафиком"
            className="justify-self-start"
            value={excluded ? 'excluded' : 'managed'}
            onChange={setMode}
            options={[
              { value: 'managed', label: 'RouteHub', disabled: !can || !segment.routable.available },
              { value: 'excluded', label: 'Keenetic', disabled: !can },
            ]}
          />
        </InlineSetting>

        {policy && (
          <>
            <InlineSetting
              title="Наследование правил"
              value={parentName}
              note={(chain.cycle || cycleError) && <p className="text-bad" role="alert">{cycleError ?? 'Цепочка политик замкнута. Выберите другого родителя.'}</p>}
              editable={can}
              open={editing === 'parent'}
              onToggle={() => setEditing(editing === 'parent' ? null : 'parent')}
            >
              <SimpleSelect
                className="h-9 w-full min-w-0"
                aria-label="Наследование правил"
                value={policy.parentId ?? 'none'}
                options={[
                  { value: 'none', label: 'Только правила этой сети' },
                  ...parentCandidates.map((entry) => ({
                    value: entry.id, label: entry.name, group: entry.kind === 'global' ? 'Общие правила' : 'Шаблоны',
                  })),
                ]}
                disabled={!can}
                onChange={(value) => setParent(value === 'none' ? null : value)}
              />
            </InlineSetting>

            <InlineSetting
              title="Действие по умолчанию"
              value={<ActionChip action={policy.defaultAction} className={actionValue} />}
              editable={can}
              open={editing === 'default'}
              onToggle={() => setEditing(editing === 'default' ? null : 'default')}
            >
              <p className="text-xs text-muted-foreground">Если ни одно правило не совпало</p>
              <ActionPicker aria-label="Действие по умолчанию" value={policy.defaultAction} allow={['vpn', 'direct', 'keenetic', 'block', 'inherit']} disabled={!can} onChange={setDefaultAction} />
            </InlineSetting>

            <InlineSetting
              title="Запасной маршрут"
              value={policy.fallbackOverride ? <ActionChip action={policy.fallbackOverride} className={actionValue} /> : 'Резерв группы выходов'}
              editable={can}
              open={editing === 'fallback'}
              onToggle={() => setEditing(editing === 'fallback' ? null : 'fallback')}
            >
              <label className="flex items-center justify-between gap-3 text-[13px]">
                Задать отдельно для этой сети
                <SavingSwitch checked={!!policy.fallbackOverride} disabled={!can} aria-label="Задать запасной маршрут для сети" onSave={toggleFallback} />
              </label>
              {policy.fallbackOverride && (
                <ActionPicker aria-label="Запасной маршрут сети" value={policy.fallbackOverride} allow={['vpn', 'direct', 'keenetic', 'block']} disabled={!can} onChange={setFallbackAction} />
              )}
            </InlineSetting>
          </>
        )}
      </div>
    </div>
  )
}

function SegmentDevices({ segment, editor }: { segment: Segment; editor: SegmentEditor }) {
  const { devices, config } = editor
  if (!devices.length) return <EmptyState title="В этой сети пока нет устройств" />

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-label="Устройства сети">
        {devices.map((device) => (
          <li key={device.id}>
            <a href={href('/devices-preview', { seg: segment.id, d: device.id })} className={cn('flex min-h-11 items-center gap-2 px-3.5 py-2 hover:bg-surface-2', focus)}>
              <span className="min-w-0 flex-1 text-[13px] font-medium [overflow-wrap:anywhere]">{deviceName(device, config)}</span>
              <Mono className="text-xs text-muted-foreground">{deviceIp(device)}</Mono>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      <a href={href('/devices-preview', { seg: segment.id })} className={quickLink}>Все устройства сети</a>
    </div>
  )
}

function SegmentParameters({ segment, editor }: { segment: Segment; editor: SegmentEditor }) {
  const { caps, ssids } = editor
  const shared = ssids.length > 1 && (caps?.perSsidPolicy.available === false || ssids.some((ssid) => !ssid.distinguishable.available))

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
        <KV items={[
          ['Интерфейс', <Mono>{segment.iface}</Mono>],
          ['Тип', segment.kind === 'bridge' ? 'Мост' : 'L3-интерфейс'],
          ['VLAN', segment.vlan ?? '—'],
          ['IPv4', <Mono className="[overflow-wrap:anywhere]">{segment.v4.join(', ') || '—'}</Mono>],
          ['IPv6', <Mono className="[overflow-wrap:anywhere]">{segment.v6.join(', ') || '—'}</Mono>],
          ['Изоляция Keenetic', segment.isolation],
        ]} />
      </div>

      {ssids.length > 0 && (
        <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
          <h3 className="mb-1 flex items-center gap-2 text-[13px] font-medium"><Wifi className="size-4" aria-hidden="true" /> Wi‑Fi</h3>
          <KV items={ssids.map((ssid) => [ssid.name, ssid.band])} />
          {shared && <p className="mt-2 text-xs text-muted-foreground">У этих SSID общий мост и общая политика маршрутизации.</p>}
        </div>
      )}
    </div>
  )
}
