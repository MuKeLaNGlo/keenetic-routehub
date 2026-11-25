import { useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, Route } from 'lucide-react'
import { Panel } from '@/components/rh/layout'
import { Button } from '@/components/ui/button'
import { MIN_PASSWORD_LENGTH } from '@/state/auth'
import { PasswordField } from './PasswordField'

interface SignInProps {
  isSetup: boolean
  authenticate: (password: string) => Promise<void>
}

export function SignIn(props: SignInProps) {
  return <SignInForm key={props.isSetup ? 'setup' : 'sign-in'} {...props} />
}

function SignInForm({ isSetup, authenticate }: SignInProps) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [issue, setIssue] = useState<{ field: 'password' | 'confirmation' | 'form'; message: string }>()
  const submitting = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return

    if (!password) {
      setIssue({ field: 'password', message: 'Введите пароль.' })
      return
    }
    if (isSetup && (password.length < MIN_PASSWORD_LENGTH || !password.trim())) {
      setIssue({ field: 'password', message: password.length < MIN_PASSWORD_LENGTH
        ? `Введите не менее ${MIN_PASSWORD_LENGTH} символов.`
        : 'Добавьте хотя бы один символ помимо пробелов.' })
      return
    }
    if (isSetup && password !== confirmation) {
      setIssue({ field: 'confirmation', message: 'Пароли не совпадают.' })
      return
    }

    submitting.current = true
    setPending(true)
    setIssue(undefined)
    try {
      await authenticate(password)
    } catch (error) {
      setIssue({ field: 'form', message: error instanceof Error ? error.message : 'Не удалось войти в панель. Попробуйте ещё раз.' })
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <main className="grid min-h-dvh items-center justify-items-center bg-background px-4 py-8 sm:px-6" aria-labelledby="routehub-auth-title">
      <Panel className="w-full max-w-[26rem] space-y-6 rounded-2xl p-5 shadow-sm sm:p-7">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-[10px] bg-foreground text-background">
            <Route className="size-5" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold tracking-tight">RouteHub</span>
        </div>

        <header className="space-y-1.5">
          <h1 id="routehub-auth-title" className="text-[25px] leading-tight font-semibold tracking-tight">
            {isSetup ? 'Настройка доступа' : 'Вход в панель'}
          </h1>
          {isSetup && <p className="text-sm text-muted-foreground">Задайте пароль для входа в RouteHub.</p>}
        </header>

        <form className="space-y-4" noValidate onSubmit={(event) => void submit(event)} aria-busy={pending}>
          <PasswordField
            name="password"
            label={isSetup ? 'Новый пароль' : 'Пароль'}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(value) => { setPassword(value); setIssue(undefined) }}
            disabled={pending}
            error={issue?.field === 'password' ? issue.message : undefined}
            hint={isSetup ? `Не менее ${MIN_PASSWORD_LENGTH} символов.` : undefined}
            visibility={['Показать пароль', 'Скрыть пароль']}
          />
          {isSetup && (
            <PasswordField
              name="confirm-password"
              label="Повторите пароль"
              autoComplete="new-password"
              value={confirmation}
              onChange={(value) => { setConfirmation(value); setIssue(undefined) }}
              disabled={pending}
              error={issue?.field === 'confirmation' ? issue.message : undefined}
            />
          )}
          {issue?.field === 'form' && (
            <p role="alert" className="rounded-lg bg-bad/8 px-3 py-2 text-sm text-bad [overflow-wrap:anywhere]">{issue.message}</p>
          )}
          <Button type="submit" disabled={pending} className="h-10 w-full">
            {pending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}
            {pending ? (isSetup ? 'Сохраняем…' : 'Проверяем…') : (isSetup ? 'Создать пароль и войти' : 'Войти')}
          </Button>
        </form>
      </Panel>
    </main>
  )
}
