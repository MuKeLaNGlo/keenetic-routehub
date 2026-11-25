import { lazy, Suspense, useLayoutEffect } from 'react'
import { Panel } from '@/components/rh/layout'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { SignIn } from '@/screens/auth/SignIn'
import { initializePassword, signIn, usePanelAuth } from '@/state/auth'
import { href, navigate, useRoute } from '@/state/router'

const Shell = lazy(async () => ({ default: (await import('@/app/Shell')).Shell }))
const loginPath = '/login'
const overviewPath = '/overview-preview'

function returnPath(target: string | null): string {
  if (!target?.startsWith('/') || target.startsWith('//')) return overviewPath
  const page = target.split('?')[0].replace(/\/+$/, '')
  return page === loginPath ? overviewPath : target
}

function AuthGate() {
  const auth = usePanelAuth()
  const route = useRoute()
  const atLogin = route.path === loginPath
  const signedIn = auth.status === 'signed-in'

  useLayoutEffect(() => {
    if (signedIn && atLogin) {
      navigate(returnPath(route.query.get('next')), { replace: true })
    } else if (!signedIn && auth.status !== 'loading' && !atLogin) {
      const query = route.query.toString()
      navigate(href(loginPath, { next: `${route.path}${query ? `?${query}` : ''}` }), { replace: true })
    }
  }, [signedIn, auth.status, atLogin, route])

  if (auth.status === 'loading') return <main className="grid min-h-dvh place-items-center text-sm text-muted-foreground" role="status">Проверяем сессию…</main>

  if (auth.status === 'unavailable') {
    return (
      <main className="grid min-h-dvh place-items-center p-4" aria-labelledby="auth-unavailable">
        <Panel className="w-full max-w-[26rem] space-y-3 rounded-2xl p-5 sm:p-7">
          <h1 id="auth-unavailable" className="text-lg font-semibold">Вход недоступен</h1>
          <p role="alert" className="text-sm text-muted-foreground">{auth.error}</p>
          <Button variant="outline" onClick={() => window.location.reload()}>Повторить</Button>
        </Panel>
      </main>
    )
  }

  if (!signedIn) return <SignIn isSetup={auth.status === 'setup'} authenticate={auth.status === 'setup' ? initializePassword : signIn} />
  if (atLogin) return null

  return (
    <Suspense fallback={<main className="grid min-h-dvh place-items-center text-sm text-muted-foreground" role="status">Открываем панель…</main>}>
      <Shell />
    </Suspense>
  )
}

export default function App() {
  return (
    <TooltipProvider delay={350}>
      <AuthGate />
      <Toaster position="top-center" closeButton richColors={false} />
    </TooltipProvider>
  )
}
