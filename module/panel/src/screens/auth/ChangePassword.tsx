import { useId, useRef, useState, type FormEvent } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { Panel } from '@/components/rh/layout'
import { Button } from '@/components/ui/button'
import { MIN_PASSWORD_LENGTH } from '@/state/auth'
import { PasswordField } from './PasswordField'

interface ChangePasswordProps {
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

export function ChangePassword({ changePassword }: ChangePasswordProps) {
  const headingId = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const [issue, setIssue] = useState<{ field: 'current' | 'next' | 'confirmation' | 'form'; message: string }>()
  const submitting = useRef(false)

  function edit(setValue: (value: string) => void, value: string) {
    setValue(value)
    setIssue(undefined)
    setSaved(false)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    setSaved(false)

    if (!current) {
      setIssue({ field: 'current', message: 'Введите текущий пароль.' })
      return
    }
    if (next.length < MIN_PASSWORD_LENGTH || !next.trim()) {
      setIssue({ field: 'next', message: next.length < MIN_PASSWORD_LENGTH
        ? `Введите не менее ${MIN_PASSWORD_LENGTH} символов.`
        : 'Добавьте хотя бы один символ помимо пробелов.' })
      return
    }
    if (next === current) {
      setIssue({ field: 'next', message: 'Введите пароль, отличный от текущего.' })
      return
    }
    if (next !== confirmation) {
      setIssue({ field: 'confirmation', message: 'Пароли не совпадают.' })
      return
    }

    submitting.current = true
    setPending(true)
    setIssue(undefined)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirmation('')
      setSaved(true)
    } catch (error) {
      setIssue({ field: 'form', message: error instanceof Error ? error.message : 'Не удалось сменить пароль. Попробуйте ещё раз.' })
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <Panel className="w-full max-w-[34rem] space-y-4 p-4 sm:p-5">
      <h2 className="text-[15px] font-semibold" id={headingId}>Пароль для входа</h2>
      <form className="max-w-[24rem] space-y-4" aria-labelledby={headingId} aria-busy={pending} noValidate onSubmit={(event) => void submit(event)}>
        <PasswordField
          name="current-password"
          label="Текущий пароль"
          autoComplete="current-password"
          value={current}
          onChange={(value) => edit(setCurrent, value)}
          disabled={pending}
          error={issue?.field === 'current' ? issue.message : undefined}
          visibility={['Показать текущий пароль', 'Скрыть текущий пароль']}
        />
        <PasswordField
          name="new-password"
          label="Новый пароль"
          autoComplete="new-password"
          value={next}
          onChange={(value) => edit(setNext, value)}
          disabled={pending}
          error={issue?.field === 'next' ? issue.message : undefined}
          hint={`Не менее ${MIN_PASSWORD_LENGTH} символов.`}
          visibility={['Показать новый пароль', 'Скрыть новый пароль']}
        />
        <PasswordField
          name="confirm-password"
          label="Повторите новый пароль"
          autoComplete="new-password"
          value={confirmation}
          onChange={(value) => edit(setConfirmation, value)}
          disabled={pending}
          error={issue?.field === 'confirmation' ? issue.message : undefined}
        />
        {issue?.field === 'form' && (
          <p role="alert" className="rounded-lg bg-bad/8 px-3 py-2 text-sm text-bad [overflow-wrap:anywhere]">{issue.message}</p>
        )}
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="submit" disabled={pending} className="h-10">
            {pending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}
            {pending ? 'Сохраняем…' : 'Сменить пароль'}
          </Button>
          <span role="status" className="inline-flex items-center gap-1.5 text-xs text-ok">
            {saved && <><Check className="size-4" aria-hidden="true" />Пароль обновлён</>}
          </span>
        </div>
      </form>
    </Panel>
  )
}
