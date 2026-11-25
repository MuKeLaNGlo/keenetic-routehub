import { useMemo } from 'react'
import type { Config, GeoSource, NamedSet, Policy } from '@/api/contract'
import { ChevronRight, Plus } from 'lucide-react'
import { useCanWrite, useGeo, useRuntime } from '@/state/resource'
import { href, setQuery } from '@/state/router'
import { Gate, KV, Notice, Section } from '@/components/rh/layout'
import { StatusBadge, type Tone } from '@/components/rh/status'
import { Mono, TimeAgo, WriteButton } from '@/components/rh/controls'
import { bytes, count, dateTime } from '@/lib/format'
import { isSetPreviewMarker } from '@/lib/rule-entries'
import { RuleDisclosure } from './disclosure'

const SOURCE_STATE: Record<'ok' | 'failed' | 'stale', { tone: Tone; label: string; dashed?: boolean }> = {
  ok: { tone: 'ok', label: 'обновлён' },
  failed: { tone: 'bad', label: 'сбой обновления' },
  stale: { tone: 'warn', label: 'устарел', dashed: true },
}

/** Host only: the path part of a list URL is never printed in full. */
function maskedUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}/••••`
  } catch {
    return '••••'
  }
}

export const setUsers = (policies: Policy[], setId: string): Policy[] =>
  policies.filter((p) => p.rules.some((r) => r.matches.some((m) => m.type === 'set' && m.value === setId)))

export const NEW_SET = '@new'

export function SetsTab({ config, compact = false, rulesPath = '/rules' }: { config: Config; compact?: boolean; rulesPath?: string }) {
  const canWrite = useCanWrite()
  return (
    <Section
      title={compact ? undefined : 'Наборы доменов и подсетей'}
      description={compact ? undefined : 'Используйте один список доменов или подсетей в нескольких правилах.'}
      actions={canWrite && <WriteButton size="sm" onClick={() => setQuery({ set: NEW_SET, entry: null })}><Plus aria-hidden="true" /> Создать набор</WriteButton>}
    >
      <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
        {config.sets.map((s) => (
          <SetRow key={s.id} set={s} config={config} compact={compact} rulesPath={rulesPath} />
        ))}
        {config.sets.length === 0 && <div className="bg-card px-3 py-4 text-[13px] text-muted-foreground">Наборов нет</div>}
      </div>
    </Section>
  )
}

function SetRow({ set: s, config, compact, rulesPath }: { set: NamedSet; config: Config; compact: boolean; rulesPath: string }) {
  if (compact) {
    const entries = s.entries.filter((entry) => !isSetPreviewMarker(entry)).length
    return (
      <a href={href(rulesPath, { tab: 'sets', set: s.id })} className="flex min-h-13 items-center gap-3 bg-card px-3.5 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium [overflow-wrap:anywhere]">{s.name}</span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <SetBadges set={s} />
            <span className="text-xs text-muted-foreground tabular-nums">{count(entries, ['запись', 'записи', 'записей'])}</span>
          </div>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </a>
    )
  }

  return (
    <div className="bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium">{s.name}</span>
        <SetBadges set={s} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {s.entries.slice(0, 12).map((e, i) => (
          <span key={`${e}-${i}`} className="rounded bg-muted px-1.5 py-0.5">
            <Mono className="text-[11.5px]">{e}</Mono>
          </span>
        ))}
        {s.entries.length > 12 && <span className="text-[11.5px] text-muted-foreground">+{s.entries.length - 12}</span>}
        {s.source.type === 'manual' && <span className="ml-1 text-[11.5px] text-muted-foreground">· {count(s.entries.length, ['строка', 'строки', 'строк'])}</span>}
      </div>
      <SetSourceDetails set={s} config={config} rulesPath={rulesPath} />
    </div>
  )
}

export function SetBadges({ set: s }: { set: NamedSet }) {
  const src = s.source
  const { data: rt } = useRuntime()
  const st = src.type === 'url' ? rt?.sets[s.id] : undefined
  return (
    <>
      <StatusBadge tone="muted">{s.kind === 'domains' ? 'домены' : 'подсети'}</StatusBadge>
      {src.type === 'manual' ? (
        <StatusBadge tone="muted" dashed>
          ручной список
        </StatusBadge>
      ) : st ? (
        <StatusBadge tone={SOURCE_STATE[st.status].tone} dashed={SOURCE_STATE[st.status].dashed}>
          {SOURCE_STATE[st.status].label}
        </StatusBadge>
      ) : (
        <StatusBadge tone="muted" dashed>
          {rt ? 'ещё не загружался' : 'нет данных'}
        </StatusBadge>
      )}
    </>
  )
}

export function SetSourceDetails({ set: s, config, rulesPath, compact = false }: { set: NamedSet; config: Config; rulesPath: string; compact?: boolean }) {
  const src = s.source
  const { data: rt } = useRuntime()
  const st = src.type === 'url' ? rt?.sets[s.id] : undefined
  const users = useMemo(() => setUsers(config.policies, s.id), [config.policies, s.id])
  return (
    <>
      {src.type === 'url' ? (
        <KV
          cols={2}
          className="mt-3"
          items={[
            [
              'Источник',
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Mono className="[overflow-wrap:anywhere]">{maskedUrl(src.url)}</Mono>
                <span className="text-[11.5px] text-muted-foreground">{src.format}</span>
              </span>,
            ],
            ['Версия', st ? <Mono>{st.version}</Mono> : '—'],
            ['Последняя попытка', st ? <TimeAgo at={st.lastAttempt} /> : '—'],
            ['Последнее успешное', st ? <TimeAgo at={st.lastSuccess} /> : '—'],
            ['Следующий запуск', st ? <TimeAgo at={st.nextRun} /> : '—'],
            [
              'Используется',
              users.length ? (
                <span className="inline-flex flex-wrap gap-1.5">
                  {users.map((p) => (
                    <a key={p.id} href={href(rulesPath, { policy: p.id })} className="text-foreground underline-offset-2 hover:underline">
                      {p.name}
                    </a>
                  ))}
                </span>
              ) : (
                'ни в одном правиле'
              ),
            ],
          ]}
        />
      ) : (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {!compact && 'Записи редактируются в наборе.'}
          {users.length > 0 && (
            compact ? <span className="[overflow-wrap:anywhere]">Области: {users.map((p) => p.name).join(', ')}</span> : ` Используется: ${users.map((p) => p.name).join(', ')}.`
          )}
        </p>
      )}

      {st && st.status !== 'ok' && (
        <Notice tone={st.status === 'failed' ? 'bad' : 'warn'} title={st.status === 'failed' ? 'Обновление не удалось' : 'Источник устарел'} className="mt-3">
          {st.error ? `${st.error.replace(/\.+$/, '')}. ` : ''}Продолжает действовать прежняя версия {st.version} от {dateTime(st.lastSuccess)} — правила работают по ней, пока источник не ответит.
        </Notice>
      )}
    </>
  )
}

const geoUsers = (config: Config, kind: 'geosite' | 'geoip', tag: string): Policy[] =>
  config.policies.filter((p) => p.rules.some((r) => r.matches.some((m) => m.type === kind && m.value === tag)))

export function GeoTab({ config, compact = false, rulesPath = '/rules' }: { config: Config; compact?: boolean; rulesPath?: string }) {
  const geo = useGeo()
  return (
    <Section
      title={compact ? undefined : 'Геоданные'}
      description={compact ? undefined : 'GeoSite и GeoIP приходят одним пакетом. Метка, исчезнувшая из новой версии, ломает правила, которые на неё ссылаются — это видно до применения.'}
    >
      <Gate res={geo}>
        {(list) => (
          <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
            {list.map((g) => (
              <GeoRow key={g.id} source={g} config={config} compact={compact} rulesPath={rulesPath} />
            ))}
            {compact && list.length === 0 && <div className="bg-card px-3 py-4 text-[13px] text-muted-foreground">Геоданных пока нет</div>}
          </div>
        )}
      </Gate>
    </Section>
  )
}

function GeoRow({ source: g, config, compact, rulesPath }: { source: GeoSource; config: Config; compact: boolean; rulesPath: string }) {
  const kind = g.kind === 'geosite' ? 'geosite' : 'geoip'
  const type = <StatusBadge tone="muted">{kind === 'geosite' ? 'GeoSite' : 'GeoIP'}</StatusBadge>
  const state = g.status === 'ok' ? (
    <StatusBadge tone="ok">проверен</StatusBadge>
  ) : g.status === 'stale' ? (
    <StatusBadge tone="warn" dashed>устарел</StatusBadge>
  ) : (
    <StatusBadge tone="bad">ошибка</StatusBadge>
  )

  const details = (
    <>
      <KV
        cols={2}
        className="mt-2"
        items={[
          ['Версия', <Mono>{g.version}</Mono>],
          ['Объём', bytes(g.sizeKb * 1024)],
          ['Меток в наборе', String(g.tags)],
          ['Последняя проверка', <TimeAgo at={g.lastCheck} />],
        ]}
      />

      {g.usedTags.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11.5px] text-muted-foreground">Используемые метки:</span>
          {g.usedTags.map((tag) => {
            const users = geoUsers(config, kind, tag)
            return users.length ? (
              <a key={tag} href={href(rulesPath, { policy: users[0].id })} className="pressable inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-[12px] hover:bg-accent" title={users.map((p) => p.name).join(', ')}>
                {tag}
                <span className="text-[10.5px] text-muted-foreground">{users.length}</span>
              </a>
            ) : (
              <StatusBadge key={tag} tone="muted" dashed>
                {tag} · не используется
              </StatusBadge>
            )
          })}
        </div>
      )}

      {g.status !== 'ok' && g.error && (
        <Notice tone={g.status === 'failed' ? 'bad' : 'warn'} title="Набор не обновлён" className="mt-3">
          {g.error}. Действуют метки версии {g.version}; правила на исчезнувшие метки перестанут совпадать — проверьте их в правилах области.
        </Notice>
      )}
    </>
  )

  if (compact)
    return (
      <RuleDisclosure title={g.name} meta={<>{type}{state}<Mono className="text-xs text-muted-foreground">{g.version}</Mono></>}>
        {details}
      </RuleDisclosure>
    )

  return (
    <div className="bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {type}
        <span className="text-[14px] font-medium">{g.name}</span>
        {state}
      </div>
      {details}
    </div>
  )
}
