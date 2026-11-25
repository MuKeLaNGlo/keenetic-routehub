import { LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { Notice, Page, Panel } from '@/components/rh/layout'
import { PanelFeature } from '@/components/rh/feature'
import { PreviewHeader } from '@/components/rh/preview-header'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChangePassword } from '@/screens/auth/ChangePassword'
import { AutostartTab } from '@/screens/system/Autostart'
import { Backup } from '@/screens/system/Backup'
import { Revisions } from '@/screens/system/Revisions'
import { Updates } from '@/screens/system/Updates'
import { changePassword, signOut } from '@/state/auth'
import { useServerConfig } from '@/state/resource'
import { navigate, setQuery, useRoute } from '@/state/router'

const views = [
  ['revisions', 'Ревизии'],
  ['updates', 'Обновления'],
  ['autostart', 'Автозапуск'],
  ['backup', 'Копии'],
  ['access', 'Доступ'],
] as const

export default function SystemPreview() {
  const { query } = useRoute()
  const config = useServerConfig()
  const tab = views.find(([id]) => id === query.get('tab'))?.[0] ?? (query.has('component') ? 'updates' : 'revisions')

  return (
    <Page className="@container pb-24 md:pb-14">
      <PreviewHeader title="Обслуживание" />
      <Tabs
        value={tab}
        onValueChange={(value) => setQuery({ tab: value === 'revisions' ? null : value, rev: null, component: null }, { replace: true })}
        className="min-w-0 gap-3.5"
      >
        <div className="overflow-x-auto border-b border-border [scrollbar-width:none]">
          <TabsList variant="line" aria-label="Раздел обслуживания" className="h-10 w-max gap-0 p-0">
            {views.map(([id, label]) => (
              <TabsTrigger key={id} value={id} className="shrink-0 px-2 text-[12px] after:bottom-0 @min-[400px]:px-3 @min-[400px]:text-[13px]">{label}</TabsTrigger>
            ))}
          </TabsList>
        </div>
        {config.error && (tab === 'autostart' || tab === 'backup') && (
          <Notice
            tone="warn"
            title={config.data ? 'Показана последняя полученная конфигурация' : 'Не удалось загрузить конфигурацию'}
            action={<Button variant="outline" size="sm" onClick={() => void config.refetch()}>Обновить</Button>}
          >
            {config.error}
          </Notice>
        )}
        <TabsContent value="revisions"><PanelFeature name="revisions"><Revisions compact /></PanelFeature></TabsContent>
        <TabsContent value="updates"><PanelFeature name="updates"><Updates compact /></PanelFeature></TabsContent>
        <TabsContent value="autostart">{(config.data || !config.error) && <AutostartTab compact />}</TabsContent>
        <TabsContent value="backup">{(config.data || !config.error) && <Backup compact />}</TabsContent>
        <TabsContent value="access" className="space-y-3">
          <ChangePassword changePassword={changePassword} />
          <Panel className="flex w-full max-w-[34rem] flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
            <div className="min-w-0 space-y-1">
              <h2 className="text-[15px] font-semibold">Сессия</h2>
              <p className="text-sm text-muted-foreground">Вход сохраняется при обновлении этой вкладки.</p>
            </div>
            <Button variant="outline" onClick={() => {
              void signOut()
                .then(() => navigate('/login', { replace: true }))
                .catch((error: Error) => toast.error(error.message))
            }}><LogOut aria-hidden="true" /> Выйти</Button>
          </Panel>
        </TabsContent>
      </Tabs>
    </Page>
  )
}
