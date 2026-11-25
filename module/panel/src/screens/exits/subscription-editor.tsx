import { useId, useState, type FormEvent } from 'react'
import type { Subscription, SubscriptionInput } from '@/api/contract'
import { Modal } from '@/components/rh/sheet'
import { WriteButton } from '@/components/rh/controls'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function SubscriptionEditor({ subscription, close, save, remove }: {
  subscription?: Subscription
  close: () => void
  save: (input: SubscriptionInput) => Promise<void>
  remove?: () => Promise<void>
}) {
  const formId = useId()
  const [name, setName] = useState(subscription?.name ?? '')
  const [url, setUrl] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [clearDeviceId, setClearDeviceId] = useState(false)
  const [userAgent, setUserAgent] = useState(subscription?.userAgent ?? '')
  const [interval, setInterval] = useState(String(subscription?.intervalHours ?? 24))
  const [enabled, setEnabled] = useState(subscription?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Операцию не удалось выполнить.')
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || confirmDelete) return
    const label = name.trim()
    const source = url.trim()
    const identity = deviceId.trim()
    const intervalHours = Number(interval)
    if (!label) {
      setError('Введите название подписки.')
      return
    }
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
      setError('Укажите интервал от 1 до 168 часов.')
      return
    }
    if (source || !subscription) {
      try {
        const parsed = new URL(source)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port) throw new Error()
      } catch {
        setError('Укажите HTTPS-ссылку подписки.')
        return
      }
    }
    if (identity && !/^[A-Za-z0-9=-]{10,64}$/.test(identity)) {
      setError('В ID устройства должно быть от 10 до 64 латинских букв, цифр, дефисов или знаков =.')
      return
    }
    if (userAgent.length > 128 || /[^ -~]/.test(userAgent)) {
      setError('User-Agent должен содержать не более 128 печатных символов ASCII.')
      return
    }
    const requestUserAgent = userAgent.trim()
    void perform(() => save({ id: subscription?.id, name: label, url: source || undefined,
      deviceId: clearDeviceId ? '' : identity || undefined,
      userAgent: requestUserAgent !== (subscription?.userAgent ?? '') ? requestUserAgent : undefined,
      intervalHours, enabled }))
  }

  const title = confirmDelete ? 'Удалить подписку?' : subscription ? 'Настройки подписки' : 'Добавить подписку'
  const footer = (
    <div className="flex flex-wrap justify-end gap-2">
      {remove && !confirmDelete && (
        <WriteButton variant="outline" className="mr-auto text-bad" disabled={busy} onClick={() => { setError(''); setConfirmDelete(true) }}>
          Удалить подписку
        </WriteButton>
      )}
      <Button variant="outline" disabled={busy} onClick={confirmDelete ? () => { setError(''); setConfirmDelete(false) } : close}>
        Отмена
      </Button>
      {confirmDelete && remove ? (
        <WriteButton variant="destructive" disabled={busy} onClick={() => void perform(remove)}>
          {busy ? 'Удаляем…' : 'Подтвердить удаление'}
        </WriteButton>
      ) : (
        <WriteButton form={formId} type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить подписку'}
        </WriteButton>
      )}
    </div>
  )

  return (
    <Modal open title={title} onClose={close} dismissible={!busy} footer={footer}>
      {confirmDelete ? (
        <p className="text-sm text-muted-foreground">
          Профили подписки «{subscription?.name}» останутся в каталоге. Их автоматическое обновление прекратится.
        </p>
      ) : (
        <form id={formId} autoComplete="off" className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>Название</Label>
            <Input id={`${formId}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required disabled={busy} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-url`}>{subscription ? 'Новая HTTPS-ссылка' : 'HTTPS-ссылка подписки'}</Label>
            <Input
              id={`${formId}-url`} type="password" inputMode="url" autoComplete="new-password" spellCheck={false}
              value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" maxLength={1536} required={!subscription} disabled={busy}
              aria-describedby={subscription ? `${formId}-url-hint` : undefined}
            />
            {subscription && <p id={`${formId}-url-hint`} className="text-xs text-muted-foreground">
              Оставьте поле пустым, чтобы сохранить текущую ссылку. При смене домена сохранённые ID устройства и User-Agent сбрасываются.
            </p>}
          </div>
          <details className="space-y-2 text-sm">
            <summary className="cursor-pointer text-muted-foreground">{subscription?.hasDeviceId ? 'ID устройства сохранён' : 'ID устройства'}</summary>
            <Label htmlFor={`${formId}-device-id`}>{subscription?.hasDeviceId ? 'Новый ID устройства' : 'ID устройства для подписки'}</Label>
            <Input id={`${formId}-device-id`} type="password" autoComplete="new-password" spellCheck={false}
              value={deviceId} onChange={(e) => setDeviceId(e.target.value)} maxLength={64} disabled={busy || clearDeviceId} />
            {subscription?.hasDeviceId && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <input type="checkbox" checked={clearDeviceId} onChange={(e) => setClearDeviceId(e.target.checked)} disabled={busy} />
                Удалить сохранённый ID
              </label>
            )}
          </details>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-user-agent`}>User-Agent запроса</Label>
            <Input id={`${formId}-user-agent`} autoCapitalize="none" autoComplete="off" spellCheck={false}
              value={userAgent} onChange={(e) => setUserAgent(e.target.value)} maxLength={128} disabled={busy}
              aria-describedby={`${formId}-user-agent-hint`} />
            <p id={`${formId}-user-agent-hint`} className="text-xs text-muted-foreground">
              Укажите значение, только если его требует поставщик подписки. Если оставить поле пустым, используется RouteHub.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-interval`}>Интервал обновления, ч</Label>
            <Input id={`${formId}-interval`} type="number" min={1} max={168} step={1}
              value={interval} onChange={(e) => setInterval(e.target.value)} required disabled={busy} className="max-w-32" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${formId}-enabled`}>Автообновление</Label>
            <Switch id={`${formId}-enabled`} checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
          </div>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-bad" role="alert">{error}</p>}
    </Modal>
  )
}
