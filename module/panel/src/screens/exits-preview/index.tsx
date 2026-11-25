import { Upload } from 'lucide-react'
import { WriteButton } from '@/components/rh/controls'
import { Notice, Page, SkeletonBlock } from '@/components/rh/layout'
import { PanelFeature } from '@/components/rh/feature'
import { PreviewHeader } from '@/components/rh/preview-header'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import EnginesTab from '@/screens/exits/engines'
import GroupsTab from '@/screens/exits/groups'
import ProfilesTab from '@/screens/exits/profiles'
import SubscriptionsTab from '@/screens/exits/subscriptions'
import { useDraft } from '@/state/draft'
import { useServerConfig } from '@/state/resource'
import { setQuery, useRoute } from '@/state/router'

const views = [
  ['profiles', 'Профили'],
  ['groups', 'Группы'],
  ['subscriptions', 'Подписки'],
  ['engines', 'Ядра'],
] as const

export default function ExitsPreview() {
  const route = useRoute()
  const query = route.query
  const tab = views.find(([id]) => id === query.get('tab'))?.[0] ?? (query.has('g') ? 'groups' : 'profiles')
  const { config } = useDraft()
  const server = useServerConfig()

  return (
    <Page className="@container pb-24 md:pb-14">
      <PreviewHeader
        title="Выходы VPN"
        actions={tab === 'profiles' && (
          <WriteButton variant="outline" className="min-h-9 bg-card px-3 text-xs" onClick={() => setQuery({ import: '1' })}>
            <Upload aria-hidden="true" /> Импорт профиля
          </WriteButton>
        )}
      />
      <Tabs
        value={tab}
        onValueChange={(value) => setQuery({ tab: value === 'profiles' ? null : value, p: null, g: null, import: null, sub: null }, { replace: true })}
        className="min-w-0 gap-3"
      >
        <div className="border-b border-border">
          <TabsList variant="line" aria-label="Раздел выходов VPN" className="h-9 max-w-full p-0">
            {views.map(([id, label]) => <TabsTrigger key={id} value={id} className="px-2 text-[12.5px] after:bottom-[-3px] sm:px-3">{label}</TabsTrigger>)}
          </TabsList>
        </div>
        {server.error && (
          <Notice
            tone="warn"
            title={config ? 'Данные могли устареть' : 'Не удалось загрузить каталог'}
            action={<Button variant="outline" size="sm" onClick={() => void server.refetch()}>Обновить</Button>}
          />
        )}
        {!config ? (
          !server.error && <SkeletonBlock rows={5} />
        ) : (
          <>
            <TabsContent value="profiles"><ProfilesTab compact /></TabsContent>
            <TabsContent value="groups"><PanelFeature name="exitGroups"><GroupsTab compact /></PanelFeature></TabsContent>
            <TabsContent value="subscriptions"><PanelFeature name="subscriptions"><SubscriptionsTab compact /></PanelFeature></TabsContent>
            <TabsContent value="engines"><EnginesTab compact /></TabsContent>
          </>
        )}
      </Tabs>
    </Page>
  )
}
