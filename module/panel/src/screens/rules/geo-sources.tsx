import { useEffect, useState, type FormEvent } from 'react'
import { Pencil, Plus, RefreshCw } from 'lucide-react'
import { json } from '@/api/http'
import type { LegacyGeoSource, LegacyPlan, LegacyPlanUpdate } from '@/api/legacy'
import { Modal } from '@/components/rh/sheet'
import { WriteButton } from '@/components/rh/controls'
import { Notice, Panel } from '@/components/rh/layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { newId } from '@/lib/entities'
import { refetch, useCanWrite, useServerConfig } from '@/state/resource'

const periods = [6, 12, 24, 48, 168]
const newSource = (): LegacyGeoSource => ({
  id: newId('geo'), name: '', repository: '', asset: '', frequency: 24, auto: false,
})

export function GeoSources() {
  const canWrite = useCanWrite()
  const { data: config } = useServerConfig()
  const [sources, setSources] = useState<LegacyGeoSource[]>()
  const [selected, setSelected] = useState<LegacyGeoSource | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [formError, setFormError] = useState<string>()
  const revision = config?.revision

  useEffect(() => {
    if (revision === undefined) return
    let current = true
    void json<LegacyPlan>('/api/plan')
      .then((plan) => {
        if (current) {
          setSources(plan.geoSources ?? [])
          setError(undefined)
        }
      })
      .catch((issue: Error) => { if (current) setError(issue.message) })
    return () => { current = false }
  }, [revision])

  async function refresh() {
    const plan = await json<LegacyPlan>('/api/plan')
    setSources(plan.geoSources ?? [])
    await Promise.all([refetch('config'), refetch('runtime'), refetch('geo'), refetch('revisions')])
  }

  function open(source: LegacyGeoSource) {
    setFormError(undefined)
    setSelected(source)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || working || !canWrite) return
    const data = new FormData(event.currentTarget)
    const command = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')
    const next: LegacyGeoSource = {
      id: selected.id,
      name: String(data.get('name') ?? '').trim(),
      repository: String(data.get('repository') ?? '').trim(),
      asset: String(data.get('asset') ?? '').trim(),
      frequency: Number(data.get('frequency')),
      auto: data.has('auto'),
    }
    setWorking(true)
    setFormError(undefined)
    try {
      const active = await json<LegacyPlan>('/api/plan')
      const before = active.geoSources ?? []
      const current = before.find((item) => item.id === selected.id)
      if (JSON.stringify(current) !== JSON.stringify(sources?.find((item) => item.id === selected.id))) {
        throw new Error('Источник изменился. Откройте настройки заново.')
      }
      const geoSources = command === 'remove'
        ? before.filter(({ id }) => id !== selected.id)
        : current ? before.map((item) => item.id === selected.id ? next : item) : [...before, next]
      const payload: LegacyPlanUpdate = {
        revision: active.revision,
        profiles: active.profiles.map(({ id, protocol, label, location }) => ({ id, protocol, label, location })),
        rules: active.rules ?? [],
        devices: active.devices ?? [],
        defaultTarget: active.defaultTarget ?? 'direct',
        geoSources,
      }
      const updated = await json<LegacyPlan>('/api/plan', 'PUT', payload)
      setSources(updated.geoSources ?? [])
      setSelected(null)
      await Promise.all([refetch('config'), refetch('runtime'), refetch('geo'), refetch('revisions')])
    } catch (issue) {
      setFormError(issue instanceof Error ? issue.message : 'Не удалось сохранить источник.')
    } finally {
      setWorking(false)
    }
  }

  async function update(id: string) {
    if (working || !canWrite) return
    setWorking(true)
    setError(undefined)
    try {
      await json('/api/geoip/update', 'POST', { id })
      await refresh()
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Не удалось обновить геоданные.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Panel className="mb-3 space-y-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Источники GeoIP и GeoSite</h2>
        <WriteButton size="sm" variant="outline" disabled={working || !sources} onClick={() => open(newSource())}>
          <Plus aria-hidden="true" /> Добавить источник
        </WriteButton>
      </div>
      {error && <Notice tone="warn" title="Не удалось загрузить или обновить источник">{error}</Notice>}
      {sources && sources.length > 0 && <ul className="divide-y">
        {sources.map((source) => (
          <li key={source.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium [overflow-wrap:anywhere]">{source.name}</div>
              <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{source.asset} · {source.auto ? `каждые ${source.frequency} ч` : 'вручную'}</div>
            </div>
            <div className="flex flex-wrap gap-1">
              <WriteButton size="sm" variant="ghost" disabled={working} onClick={() => open(source)}><Pencil aria-hidden="true" /> Изменить</WriteButton>
              <WriteButton size="sm" variant="ghost" disabled={working} onClick={() => void update(source.id)}><RefreshCw aria-hidden="true" /> Обновить</WriteButton>
            </div>
          </li>
        ))}
      </ul>}
      <Modal open={!!selected} onClose={() => setSelected(null)} dismissible={!working}
        title={selected?.name ? 'Настройки источника' : 'Добавить источник геоданных'}>
        {selected && <form key={selected.id} autoComplete="off" onSubmit={(event) => void save(event)} className="space-y-3">
          <label className="block space-y-1 text-xs font-medium">
            <span>Название источника</span><Input name="name" defaultValue={selected.name} required maxLength={100} disabled={working} />
          </label>
          <label className="block space-y-1 text-xs font-medium">
            <span>Репозиторий GitHub</span><Input type="url" name="repository" defaultValue={selected.repository} placeholder="https://github.com/owner/repo" required disabled={working} />
          </label>
          <label className="block space-y-1 text-xs font-medium">
            <span>Файл релиза</span><Input name="asset" defaultValue={selected.asset} placeholder="geoip.dat" required maxLength={120} disabled={working} />
          </label>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input type="checkbox" name="auto" defaultChecked={selected.auto} disabled={working} /> Обновлять автоматически
          </label>
          <label className="block space-y-1 text-xs font-medium">
            <span>Интервал обновления</span>
            <select name="frequency" defaultValue={selected.frequency} disabled={working} className="block h-9 rounded-md border bg-background px-2 text-sm">
              {periods.map((hours) => <option key={hours} value={hours}>Каждые {hours} ч</option>)}
            </select>
          </label>
          {formError && <p role="alert" className="text-xs text-bad">{formError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {sources?.some(({ id }) => id === selected.id) && <WriteButton type="submit" value="remove" formNoValidate
              variant="outline" disabled={working} className="mr-auto text-bad">Удалить источник</WriteButton>}
            <Button type="button" variant="outline" onClick={() => setSelected(null)} disabled={working}>Отмена</Button>
            <WriteButton type="submit" disabled={working}>Сохранить</WriteButton>
          </div>
        </form>}
      </Modal>
    </Panel>
  )
}
