import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { api } from '@/api'
import type { Profile } from '@/api/contract'
import { ImportFiles } from '@/components/rh/import-files'
import { WriteButton } from '@/components/rh/controls'
import { Textarea } from '@/components/ui/textarea'
import { publishServerConfig } from '@/state/resource'
import { ConnectionFields, readConnection } from './connection-fields'

export function ProfileConnection({ profile }: { profile: Profile }) {
  const [file, setFile] = useState<File>()
  const [text, setText] = useState('')
  const [manual, setManual] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const replace = api.replaceProfileConnection?.bind(api)
  if (!replace) return null

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!replace || working) return
    const form = event.currentTarget
    setWorking(true)
    setError(undefined)
    try {
      if (file && file.size > 512 * 1024) throw new Error('Размер файла не должен превышать 512 КиБ.')
      const data = manual ? readConnection(form, 'replace') : { text: file ? '' : text }
      const [candidate, ...extra] = await api.previewProfileImport(data.text, {
        file: manual ? undefined : file,
        interface: data.interface,
      })
      if (!candidate || extra.length || candidate.status !== 'ok' || candidate.protocol !== profile.protocol) {
        throw new Error('Вставьте одну конфигурацию того же протокола.')
      }
      publishServerConfig(await replace(profile.id, candidate.key))
      form.reset()
      setText('')
      setFile(undefined)
      setManual(false)
      toast.success('Параметры подключения обновлены')
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Не удалось заменить конфигурацию.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <form onSubmit={(event) => void update(event)} className="space-y-3">
      <p className="text-xs text-muted-foreground">Новая конфигурация заменит параметры профиля. Правила маршрутизации сохранят ссылки на этот профиль.</p>
      <label className="flex items-center gap-2 text-xs font-medium">
        <input type="checkbox" checked={manual} disabled={working} onChange={(event) => { setManual(event.target.checked); setError(undefined) }} />
        Ввести параметры вручную
      </label>
      {manual ? <ConnectionFields protocol={profile.protocol} prefix="replace" disabled={working} /> : <>
        <ImportFiles label="Выбрать файл конфигурации" accept=".json,.conf,.txt,.uri,.url,.wg,.awg,.yaml,.yml"
          files={file ? [file] : []} disabled={working} onChange={(files) => setFile(files[0])} />
        {!file && <Textarea aria-label="Новая конфигурация подключения" placeholder="Вставьте ссылку или конфигурацию"
          value={text} rows={3} disabled={working} onChange={(event) => setText(event.target.value)} spellCheck={false} />}
      </>}
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
      <WriteButton type="submit" size="sm" disabled={working || (!manual && !file && !text.trim())}>
        {working ? 'Проверяем и сохраняем…' : 'Заменить конфигурацию'}
      </WriteButton>
    </form>
  )
}
