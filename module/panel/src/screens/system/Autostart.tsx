import { useState, type ReactNode } from 'react'
import { Info, ShieldAlert } from 'lucide-react'
import { api, type Autostart, type BootCheck, type Profile } from '@/api'
import { useDraft } from '@/state/draft'
import { useCanWrite } from '@/state/resource'
import { Notice, Panel, Section } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { SimpleSelect, WriteButton } from '@/components/rh/controls'
import { SavingSwitch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const POLICIES: {
  value: Autostart['initialPolicy']
  label: string
  summary: string
  consequence: string
  risk: 'low' | 'medium' | 'high'
}[] = [
  {
    value: 'suspend-until-vpn',
    label: 'Приостановить до готовности VPN',
    summary: 'Новые соединения по правилам с VPN-выходом ждут туннель; прямые правила работают сразу.',
    consequence: 'Ничего не уходит открыто. Сайты и сервисы из VPN-правил не откроются, пока туннель не поднимется.',
    risk: 'low',
  },
  {
    value: 'last-applied',
    label: 'Как в последней применённой ревизии',
    summary: 'Сразу после загрузки действует политика последней ревизии, в том числе VPN-правила.',
    consequence: 'Пока VPN не готов, соединения по VPN-правилам не установятся: они ждут туннель. Остальной трафик идёт по своим правилам.',
    risk: 'medium',
  },
  {
    value: 'direct-until-vpn',
    label: 'Напрямую, пока VPN не готов',
    summary: 'До готовности VPN весь трафик идёт прямым выходом, без туннеля.',
    consequence: 'В первые секунды после загрузки трафик VPN-правил уходит открыто и виден провайдеру. Связность гарантирована, приватность — нет.',
    risk: 'high',
  },
]

const RISK: Record<'low' | 'medium' | 'high', { tone: 'ok' | 'warn' | 'bad'; label: string }> = {
  low: { tone: 'ok', label: 'риск утечки минимален' },
  medium: { tone: 'warn', label: 'VPN-правила ждут туннель' },
  high: { tone: 'bad', label: 'трафик временно открыт' },
}

const bootServices = [
  ['vpn', 'VPN', 'Ядро и основной профиль. Пока не готовы, действует исходная политика ниже.'],
  ['dns', 'DNS', 'Управляемые политики DNS и резервный резолвер. Запускается раньше VPN.'],
  ['zapret', 'Zapret', 'Обход блокировок для YouTube и Discord. Запускается после готовности VPN.'],
] as const

type SetAutostart = (label: string, mutate: (autostart: Autostart) => void) => Promise<boolean>

export function AutostartTab({ compact = false }: { compact?: boolean }) {
  const { config, edit } = useDraft()
  const can = useCanWrite()
  if (!config) return <div className="h-40 animate-pulse rounded-xl bg-card ring-1 ring-border" />

  const a = config.autostart
  const set = (label: string, mutate: (x: Autostart) => void) => edit(`Автозапуск: ${label}`, (c) => mutate(c.autostart))
  if (a.profileId !== undefined && api.checkBoot) {
    return <RouterAutostart autostart={a} profiles={config.profiles} can={can} set={set} check={api.checkBoot.bind(api)} />
  }
  const setPolicy = (v: string) => {
    const p = POLICIES.find((x) => x.value === v)
    if (!p || p.value === a.initialPolicy) return
    set(`исходная политика «${p.label}»`, (x) => {
      x.initialPolicy = p.value
    })
  }
  const services = (
    <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
      {bootServices.map(([field, label, hint]) => (
        <Row key={field} title={label} hint={compact ? undefined : hint}>
          <SavingSwitch
            checked={a[field]}
            disabled={!can}
            aria-label={`Запускать ${label} при загрузке`}
            onSave={(enabled) => set(enabled ? `${label} включается при загрузке` : `${label} не включается при загрузке`, (x) => { x[field] = enabled })}
          />
        </Row>
      ))}
      {compact && <WanRow autostart={a} can={can} set={set} />}
    </div>
  )
  const policies = (
    <RadioGroup value={a.initialPolicy} onValueChange={(v) => setPolicy(String(v))} className="gap-1.5" aria-label="Исходная политика до готовности VPN">
      {POLICIES.map((p) => {
        const active = p.value === a.initialPolicy
        const risk = RISK[p.risk]
        return (
          <div
            key={p.value}
            onClick={() => can && setPolicy(p.value)}
            className={cn(
              'rounded-xl px-3.5 py-3 ring-1 ring-inset transition-colors',
              active ? 'bg-muted/50 ring-border' : 'ring-transparent hover:bg-muted/30',
              can ? 'cursor-pointer' : 'cursor-default',
            )}
          >
            <div className="flex items-start gap-3">
              <RadioGroupItem value={p.value} disabled={!can} className="mt-0.5" aria-label={p.label} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium">{p.label}</span>
                  {(!compact || active || p.risk === 'high') && (
                    <StatusBadge tone={risk.tone} icon={p.risk === 'low' ? undefined : <ShieldAlert />}>
                      {risk.label}
                    </StatusBadge>
                  )}
                </div>
                {!compact && <p className="text-[12.5px] leading-relaxed text-muted-foreground">{p.summary}</p>}
                {(!compact || active) && <p className="text-[12.5px] leading-relaxed text-foreground/80">{compact && p.risk === 'low' ? p.summary : p.consequence}</p>}
              </div>
            </div>
          </div>
        )
      })}
    </RadioGroup>
  )

  if (compact) {
    return (
      <div className="space-y-3.5">
        {!can && <ReadOnlyHint />}
        <div className="grid items-start gap-3.5 @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Section title="Службы при загрузке" className="mb-0 md:mb-0">{services}</Section>
          <Section title="Политика до готовности VPN" className="mb-0 md:mb-0">{policies}</Section>
        </div>
        <details className="rounded-xl border border-border bg-card px-3.5">
          <summary className="min-h-10 cursor-pointer rounded py-2.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">Порядок запуска</summary>
          <div className="pb-3.5"><StartupDetails autostart={a} /></div>
        </details>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {!can && <ReadOnlyHint />}

      <Section title="Службы при загрузке" description="Что RouteHub поднимает сам после включения роутера.">
        {services}
      </Section>

      <Section title="Исходная политика до готовности VPN" description="Что применяется к новым соединениям, пока туннель не поднялся. Выбор определяет, что происходит при незапущенном VPN.">
        {policies}
      </Section>

      <Section title="Ожидание WAN" description="Сколько ждать появления интернет-канала перед запуском зависимых служб.">
        <Panel className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <WaitForWan value={a.waitForWanSec} disabled={!can} onCommit={(n) => set(`ожидание WAN ${n} с`, (x) => (x.waitForWanSec = n))} />
            <span className="text-[12.5px] text-muted-foreground">секунд, от 0 до 300</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Если WAN не появился за это время, службы всё равно запускаются — иначе после короткого сбоя провайдера роутер остался бы без маршрутизации. 0 — запускать сразу.
          </p>
        </Panel>
      </Section>

      <Section
        title="Что произойдёт при загрузке"
        description="Порядок выводится из текущих настроек; на роутере он не проверялся."
        actions={
          <StatusBadge tone="muted" dashed>
            расчёт по конфигурации
          </StatusBadge>
        }
      >
        <Panel className="p-4">
          <StartupDetails autostart={a} />
        </Panel>
      </Section>
    </div>
  )
}

const bootCheckLabels: Record<string, string> = { vpn: 'VPN', youtube: 'YouTube', discord: 'Discord' }

function RouterAutostart({ autostart: a, profiles, can, set, check }: {
  autostart: Autostart
  profiles: Profile[]
  can: boolean
  set: SetAutostart
  check: NonNullable<typeof api.checkBoot>
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ key: string; checks?: BootCheck[]; error?: string }>()
  const key = JSON.stringify(a)
  const current = result?.key === key ? result : undefined

  const test = async () => {
    if (busy || !can) return
    setBusy(true)
    setResult(undefined)
    try {
      setResult({ key, checks: await check() })
    } catch (error) {
      setResult({ key, error: error instanceof Error ? error.message : 'Повторите проверку.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3.5">
      <ReadOnlyHint />
      <div className="grid items-start gap-3.5 @min-[620px]:grid-cols-2">
        <Section title="Службы при загрузке" className="mb-0 md:mb-0">
          <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            <Row title="VPN" hint="Используется для правил с основным профилем.">
              <SavingSwitch checked={a.vpn} disabled={!can || busy} aria-label="Запускать VPN при загрузке" onSave={(value) => set('VPN', (current) => { current.vpn = value })} />
            </Row>
            <div className="bg-card px-3.5 py-3">
              <span className="mb-1.5 block text-[13.5px] font-medium">Профиль при запуске</span>
              <SimpleSelect
                aria-label="Профиль для автозапуска"
                className="w-full"
                disabled={!can || !a.vpn || busy}
                value={a.profileId ?? ''}
                options={[{ value: '', label: 'Последний использованный профиль' }, ...profiles.map((p) => ({ value: p.id, label: p.alias || p.name }))]}
                onChange={(profileId) => void set('профиль для запуска', (current) => { current.profileId = profileId })}
              />
            </div>
            {([['zapretYouTube', 'YouTube'], ['zapretDiscord', 'Discord']] as const).map(([field, service]) => (
              <Row key={field} title={`Zapret для ${service}`}>
                <SavingSwitch
                  checked={a[field] === true}
                  disabled={!can || busy}
                  aria-label={`Запускать Zapret для ${service} при загрузке`}
                  onSave={(value) => set(`Zapret для ${service}`, (current) => {
                    current[field] = value
                    current.zapret = !!(current.zapretYouTube || current.zapretDiscord)
                  })}
                />
              </Row>
            ))}
          </div>
        </Section>
        <Section title="Проверка автозапуска" className="mb-0 md:mb-0">
          <Panel className="space-y-3 p-3.5">
            <p className="text-[12.5px] text-muted-foreground">Проверяет сохранённые параметры профиля и готовность настроенных стратегий Zapret.</p>
            <WriteButton variant="outline" disabled={!can || busy} onClick={() => void test()}>{busy ? 'Проверяем…' : 'Проверить настройки'}</WriteButton>
            {current?.error && <Notice tone="bad" title="Проверка не выполнена">{current.error}</Notice>}
            {current?.checks && <ul className="space-y-1" aria-live="polite">{current.checks.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-1.5 text-[12.5px]">
                <StatusBadge tone={item.status === 'ready' ? 'ok' : item.status === 'disabled' ? 'muted' : 'warn'}>{bootCheckLabels[item.id] || item.id}</StatusBadge>
                <span className="min-w-0 flex-1">{item.message}</span>
              </li>
            ))}</ul>}
          </Panel>
        </Section>
      </div>
    </div>
  )
}

function StartupDetails({ autostart: a }: { autostart: Autostart }) {
  return (
    <>
      <ol className="space-y-2">
        <Step n={1} title="WAN" text={a.waitForWanSec > 0 ? `ждём появления канала до ${a.waitForWanSec} с` : 'не ждём, запускаемся сразу'} />
        <Step
          n={2}
          title="DNS"
          text={a.dns ? 'поднимается при загрузке, раньше VPN' : 'автоматически не запускается — имена будут резолвиться системным DNS Keenetic'}
        />
        <Step n={3} title="VPN" text={a.vpn ? 'ядро и основной профиль поднимаются при загрузке' : 'автоматически не поднимается — туннель нужно включить вручную'} />
        <Step n={4} title="Zapret" text={a.zapret ? 'стартует после готовности VPN' : 'автоматически не запускается'} />
      </ol>

      <div className="mt-4 space-y-2.5 border-t pt-3.5 text-[12.5px] leading-relaxed">
        {a.dns && a.vpn && (
          <p className="flex gap-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">DNS запускается раньше VPN.</span> Имена резолвятся до готовности туннеля; резолверы, доступные только через VPN, ответят ошибкой, пока он не поднялся.
            </span>
          </p>
        )}
        <p className="flex gap-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>
            <span className="font-medium">Если VPN не поднялся:</span> {POLICIES.find((p) => p.value === a.initialPolicy)?.consequence}
          </span>
        </p>
        <p className="text-muted-foreground">
          Порядок и зависимости здесь рассчитаны по конфигурации. Фактический запуск после перезагрузки в макете не выполняется.
        </p>
      </div>
    </>
  )
}

function WanRow({ autostart, can, set }: { autostart: Autostart; can: boolean; set: SetAutostart }) {
  return (
    <Row title="Ожидание WAN" hint="0–300 с. При 0 службы запускаются сразу.">
      <WaitForWan value={autostart.waitForWanSec} disabled={!can} onCommit={(seconds) => set(`ожидание WAN ${seconds} с`, (candidate) => {
        candidate.waitForWanSec = seconds
      })} />
    </Row>
  )
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 bg-card px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{title}</div>
        {hint && <div className="text-[12px] leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{n}</span>
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-[12.5px] text-muted-foreground"> — {text}</span>
      </div>
    </li>
  )
}

function WaitForWan({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (n: number) => Promise<boolean> }) {
  const [entry, setEntry] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const text = entry ?? String(value)

  const commit = async () => {
    if (entry === null || saving || disabled) return
    const n = Number.parseInt(entry, 10)
    const clamped = Number.isFinite(n) ? Math.min(300, Math.max(0, n)) : value
    if (clamped === value) {
      setEntry(null)
      return
    }
    setSaving(true)
    try {
      if (await onCommit(clamped)) setEntry(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Input
      value={text}
      onChange={(e) => setEntry(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      inputMode="numeric"
      disabled={disabled || saving}
      aria-busy={saving}
      className="w-20"
      aria-label="Ожидание WAN перед запуском, секунд"
    />
  )
}
