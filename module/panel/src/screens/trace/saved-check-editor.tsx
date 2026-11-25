import { useState } from 'react'
import type { SavedCheck } from '@/api/contract'
import { Mono, SimpleSelect, WriteButton } from '@/components/rh/controls'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export const savedCheckActions: Record<SavedCheck['expect'], string> = {
  direct: 'Напрямую', vpn: 'VPN', keenetic: 'KeeneticOS', zapret: 'Zapret', block: 'Блокировка', inherit: 'Наследование',
}

const actionOptions = Object.entries(savedCheckActions)
  .filter(([value]) => value !== 'inherit')
  .map(([value, label]) => ({ value, label }))

export function SavedCheckEditor({ check, source, onSave, onClose }: {
  check: SavedCheck
  source: string
  onSave: (check: SavedCheck) => Promise<boolean>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(check)
  const [open, setOpen] = useState(true)
  const [saving, setSaving] = useState(false)
  const field = 'grid gap-1.5 text-[12.5px] font-medium'

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => { if (!saving) setOpen(value) }}
      onOpenChangeComplete={(value) => { if (!value) onClose() }}
    >
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Проверка маршрута</DialogTitle>
          <DialogDescription>{source} → <Mono>{check.target}:{check.port}</Mono> · {check.proto.toUpperCase()}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={async (event) => {
          event.preventDefault()
          if (!draft.name.trim() || saving) return
          setSaving(true)
          try {
            if (await onSave({ ...draft, name: draft.name.trim() })) setOpen(false)
          } finally {
            setSaving(false)
          }
        }}>
          <label className={field}>
            Название
            <Input autoFocus value={draft.name} required maxLength={100} disabled={saving}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <div className={field}>
            <label htmlFor="saved-check-action">Ожидаемый выход</label>
            <SimpleSelect id="saved-check-action" className="w-full" value={draft.expect} options={actionOptions}
              onChange={(expect) => setDraft({ ...draft, expect: expect as SavedCheck['expect'] })} disabled={saving} />
          </div>
          <label className="flex items-start gap-2.5 py-1 text-[12.5px]">
            <Checkbox className="mt-0.5" checked={draft.required} disabled={saving}
              onCheckedChange={(required) => setDraft({ ...draft, required })} />
            <span>
              <span className="block font-medium">Обязательная проверка</span>
              <span className="block text-muted-foreground">Несовпадение остановит применение настроек.</span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>Отмена</Button>
            <WriteButton type="submit" disabled={!draft.name.trim() || saving}>{saving ? 'Сохранение…' : 'Сохранить'}</WriteButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
