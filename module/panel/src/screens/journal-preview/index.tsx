import { useEffect } from 'react'
import { api } from '@/api'
import { Page, Panel } from '@/components/rh/layout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SupportExport } from '@/screens/journal/SupportExport'
import { setQuery, useRoute } from '@/state/router'
import { refetch, useResource } from '@/state/resource'
import { bytes } from '@/lib/format'
import { EventList } from './EventList'
import { TelemetryPanel } from './TelemetryPanel'
import './journal-preview.css'

const logStorageKey = 'service-log-storage'
const logStates = {
  active: 'Ротация включена',
  paused: 'Запись приостановлена из-за недостатка места',
  error: 'Не удалось записать или прочитать журнал',
  disabled: 'Запись в файл отключена',
}

function LogStorage() {
  const { data, error } = useResource(logStorageKey, () => api.getServiceLogStorage!(), [])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refetch(logStorageKey)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  if (!data && !error) return null
  return (
    <Panel className="mb-4 rounded-xl px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Журнал службы RouteHub</h2>
        <span className="text-[12px] text-muted-foreground">
          {data ? logStates[data.state] : 'Состояние журнала недоступно'}
        </span>
      </div>
      {!!data?.maxFiles && (
        <p className="mt-1 text-[12px] text-muted-foreground">
          Занято {bytes(data.bytes)} из {bytes(data.maxFileBytes * data.maxFiles)} · файлов {data.files} из {data.maxFiles}
          {' · '}резерв свободного места {bytes(data.reserveBytes)}
        </p>
      )}
    </Panel>
  )
}

export default function JournalPreview() {
  const route = useRoute()
  const tab = route.query.get('tab') === 'events' || route.query.has('e') ? 'events' : 'telemetry'

  return (
    <Page className="journal-preview pb-24 md:pb-14">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5">
        <h1 className="journal-preview__title">Журнал</h1>
        <div className="flex flex-wrap items-center gap-2">
          <SupportExport compact />
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => setQuery({ tab: value === 'events' ? 'events' : null, e: null })}
        className="gap-4"
      >
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Раздел журнала" className="h-9 p-0">
            <TabsTrigger className="px-3 after:bottom-[-3px]" value="telemetry">Телеметрия</TabsTrigger>
            <TabsTrigger className="px-3 after:bottom-[-3px]" value="events">События</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="events" keepMounted>
          {tab === 'events' && api.getServiceLogStorage && <LogStorage />}
          <EventList active={tab === 'events'} />
        </TabsContent>
        <TabsContent value="telemetry">
          <TelemetryPanel />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
