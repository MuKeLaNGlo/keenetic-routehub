import { useState } from 'react'
import type { Action, Profile } from '@/api/contract'
import { ActionPicker } from '@/components/rh/action'
import { WriteButton } from '@/components/rh/controls'
import { Notice } from '@/components/rh/layout'
import { Modal } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { useDraft } from '@/state/draft'
import { useRuntime } from '@/state/resource'
import { profileLabel } from './shared'

function refers(action: Action, profileId: string) {
  return action.kind === 'vpn' && action.target.type === 'profile' && action.target.profileId === profileId
}

export function ProfileRemove({ profile, onRemoved }: { profile: Profile; onRemoved: () => void }) {
  const { config, edit } = useDraft()
  const { data: runtime } = useRuntime()
  const [open, setOpen] = useState(false)
  const [replacement, setReplacement] = useState<Action>({ kind: 'block' })
  const [pending, setPending] = useState(false)
  if (!config) return null
  const stillSelected = config.autostart.profileId === profile.id ||
    (config.primaryProfileId === profile.id && runtime?.vpn?.enabled !== false)
  const references = config.policies.reduce((count, policy) =>
    count + Number(refers(policy.defaultAction, profile.id)) + policy.rules.filter(({ action }) => refers(action, profile.id)).length, 0)
    + config.devicePolicies.filter(({ fixedExit }) => fixedExit && refers(fixedExit, profile.id)).length
  const sameProfile = refers(replacement, profile.id) ||
    (replacement.kind === 'vpn' && replacement.target.type === 'primary' && config.primaryProfileId === profile.id)

  async function remove() {
    if (pending || stillSelected || (references > 0 && sameProfile)) return
    setPending(true)
    const saved = await edit(`Удалён профиль «${profileLabel(profile)}»`, (draft) => {
      for (const policy of draft.policies) {
        if (refers(policy.defaultAction, profile.id)) policy.defaultAction = replacement
        for (const rule of policy.rules) if (refers(rule.action, profile.id)) rule.action = replacement
      }
      for (const device of draft.devicePolicies) {
        if (device.fixedExit && refers(device.fixedExit, profile.id)) device.fixedExit = replacement
      }
      draft.profiles = draft.profiles.filter(({ id }) => id !== profile.id)
    })
    setPending(false)
    if (saved) { setOpen(false); onRemoved() }
  }

  return (
    <>
      <WriteButton variant="ghost" size="sm" className="text-bad" onClick={() => setOpen(true)}>Удалить профиль</WriteButton>
      <Modal open={open} onClose={() => setOpen(false)} dismissible={!pending} title="Удалить профиль?"
        description={`«${profileLabel(profile)}» будет удалён из каталога при сохранении.`}>
        <div className="space-y-3">
          {stillSelected && (
            <Notice tone="warn" title="Профиль используется VPN или автозапуском">
              Выберите другой профиль в настройках VPN и автозапуска, если профиль назначен там.
            </Notice>
          )}
          {references > 0 && (
            <div className="space-y-2">
              <p className="text-sm">Выберите действие для связанных настроек ({references}).</p>
              <ActionPicker value={replacement} onChange={setReplacement} allow={['vpn', 'direct', 'block']} disabled={pending} />
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Отмена</Button>
            <WriteButton disabled={pending || stillSelected || (references > 0 && sameProfile)} onClick={() => void remove()}>
              {pending ? 'Удаляем…' : 'Удалить'}
            </WriteButton>
          </div>
        </div>
      </Modal>
    </>
  )
}
