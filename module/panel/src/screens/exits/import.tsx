import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Ban, CheckCircle2, Download, HelpCircle, Link2, RefreshCw, Trash2 } from 'lucide-react'
import type { EngineId, EngineInfo, ProbeResult, Profile, ProfileImportCandidate, VpnProtocol } from '@/api/contract'
import { api } from '@/api'
import { useDraft } from '@/state/draft'
import { useRuntime } from '@/state/resource'
import { href } from '@/state/router'
import { Notice } from '@/components/rh/layout'
import { ProbeBadge, StatusBadge, type Tone } from '@/components/rh/status'
import { Mono, Segmented, SimpleSelect, WriteButton } from '@/components/rh/controls'
import { ImportFiles } from '@/components/rh/import-files'
import { Modal } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ENGINE_LABEL, PROTOCOL_LABEL } from '@/lib/labels'
import { newId } from '@/lib/entities'
import { toast } from 'sonner'
import { engineForGeneration, engineName } from './shared'
import { ConnectionFields, readConnection } from './connection-fields'
import { isDemo } from '@/api/mode'

type Generation = NonNullable<ProfileImportCandidate['awgGenerations']>[number]

const IMPORT_STATUS: Record<ProfileImportCandidate['status'], { tone: Tone; label: string; icon: ReactNode; dashed?: boolean }> = {
  ok: { tone: 'ok', label: 'Готов к добавлению', icon: <CheckCircle2 /> },
  'needs-confirmation': { tone: 'warn', label: 'Нужно подтверждение', icon: <HelpCircle /> },
  unsupported: { tone: 'muted', label: 'Не поддерживается', icon: <Ban />, dashed: true },
  'engine-missing': { tone: 'bad', label: 'Ядро не установлено', icon: <Download /> },
  'needs-other-engine': { tone: 'info', label: 'Нужен другой движок', icon: <RefreshCw /> },
}

/** Демонстрационный набор: всё, что перечислено в §14.4. */
const SAMPLE = `vless://4f2c8a1e-••••@nl-ams.example:443?security=reality&sni=www.microsoft.com&fp=chrome&pbk=••••&sid=1a2b&type=tcp#NL-AMS-01
hysteria2://••••@de-fra.example:443?obfs=salamander&obfs-password=••••#DE-FRA-HY2
trojan://••••@fi-hel.example:443?security=tls&type=ws&path=%2Fws#FI-HEL-Trojan
ss://YWVzLTI1Ni1nY206••••@jp-tyo.example:8388#JP-TYO-SS
[Interface]
# Name = AWG · офис
PrivateKey = ••••
Address = 10.8.0.2/32
DNS = 10.8.0.1
Jc = 4
Jmin = 50
Jmax = 1000
S1 = 86
S2 = 574
H1 = 1
H2 = 2
H3 = 3
H4 = 4
Endpoint = vpn.example:51820

[Interface]
# Name = AWG · новый сервер
PrivateKey = ••••
Address = 10.9.0.2/32
I1 = <b 0x0200
I2 = <b 0x0300
Endpoint = vpn.example:51820`

export default function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { edit } = useDraft()
  const { data: rt } = useRuntime()
  const [text, setText] = useState('')
  const [file, setFile] = useState<File>()
  const [awgVersion, setAwgVersion] = useState('')
  const [interfaceName, setInterfaceName] = useState('')
  const [candidates, setCandidates] = useState<ProfileImportCandidate[] | null>(null)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [generations, setGenerations] = useState<Record<string, Generation>>({})
  const [phase, setPhase] = useState<'preview' | 'saving' | null>(null)
  const [probing, setProbing] = useState<string>()
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const requestId = useRef(0)
  const saving = phase === 'saving'

  useEffect(() => {
    requestId.current += 1
    if (open) return
    setText('')
    setFile(undefined)
    setAwgVersion('')
    setInterfaceName('')
    setCandidates(null)
    setSelected({})
    setGenerations({})
    setPhase(null)
    setProbing(undefined)
    setProbes({})
  }, [open])

  const changeText = (value: string) => {
    setText(value)
    setCandidates(null)
  }

  const runPreview = async (manual?: ReturnType<typeof readConnection>) => {
    if ((!manual && !file && !text.trim()) || phase || probing) return
    if (!manual && file && file.size > 512 * 1024) {
      toast.error('Размер файла профиля превышает 512 КиБ')
      return
    }
    const request = ++requestId.current
    setPhase('preview')
    setCandidates(null)
    setProbes({})
    try {
      const list = await api.previewProfileImport(manual?.text ?? (file ? '' : text), {
        file: manual ? undefined : file,
        fileName: manual ? undefined : file?.name,
        awgVersion: manual?.interface ? undefined : awgVersion || undefined,
        interface: manual ? manual.interface : interfaceName.trim() || undefined,
      })
      if (request !== requestId.current) return
      setCandidates(list)
      setSelected(Object.fromEntries(list.filter((c) => c.status === 'ok').map((c) => [c.key, true])))
      setGenerations({})
    } catch (e) {
      if (request === requestId.current) toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === requestId.current) setPhase(null)
    }
  }

  const engineOf = (c: ProfileImportCandidate): EngineId | null =>
    c.adapter ?? (generations[c.key] ? engineForGeneration(generations[c.key], rt?.engines) : null)

  const canAdd = (c: ProfileImportCandidate) => c.status !== 'unsupported' && c.status !== 'engine-missing' && engineOf(c) !== null
  const readyToAdd = (candidates ?? []).filter((c) => selected[c.key] && canAdd(c))
  const needsGeneration = (candidates ?? []).filter((c) => c.status === 'needs-confirmation' && !generations[c.key])
  const missingEngines = (candidates ?? []).filter((c) => c.status === 'engine-missing')

  async function probeCandidate(key: string) {
    if (!api.probeImportedProfile || phase || probing) return
    const request = requestId.current
    setProbing(key)
    try {
      const result = await api.probeImportedProfile(key)
      if (request === requestId.current) setProbes((previous) => ({ ...previous, [key]: result }))
    } catch (error) {
      if (request === requestId.current) toast.error(error instanceof Error ? error.message : 'Проверка профиля не удалась')
    } finally {
      if (request === requestId.current) setProbing(undefined)
    }
  }

  const confirm = async (connect = false) => {
    if (!readyToAdd.length || phase || probing) return
    const request = ++requestId.current
    setPhase('saving')
    let importedId: string | undefined
    const saved = await edit(`Импорт профилей: ${readyToAdd.length}`, (c) => {
      for (const cand of readyToAdd) {
        const built = buildProfile(cand, generations[cand.key], rt?.engines, file?.name)
        if (built) {
          api.stageImportedProfile?.(cand.key, built.id)
          c.profiles.push(built)
          importedId = built.id
        }
      }
    })
    if (request !== requestId.current) return
    if (saved) {
      if (connect && importedId && api.setVpnEnabled) {
        try {
          await api.setVpnEnabled(true, importedId)
          toast.success('Профиль сохранён и подключён')
        } catch (issue) {
          toast.error('Профиль сохранён, VPN не подключён', { description: issue instanceof Error ? issue.message : undefined })
        }
      } else {
        toast.success('Профили добавлены в каталог')
      }
      onClose()
    }
    setPhase(null)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title="Импорт профиля"
      description="Ссылка, текст или конфигурация. Протокол и адаптер определяются автоматически там, где это однозначно; неоднозначный AmneziaWG требует вашего выбора."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] text-muted-foreground">
            {candidates
              ? readyToAdd.length
                ? `Будет добавлено: ${readyToAdd.length}`
                : needsGeneration.length
                  ? 'Выберите поколение AWG для продолжения'
                  : 'Нет профилей, готовых к добавлению'
              : 'Секреты не покидают роутер: в предпросмотре видны только маскированные адреса'}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={saving} onClick={onClose}>
              Отмена
            </Button>
            <WriteButton variant={api.setVpnEnabled && readyToAdd.length === 1 ? 'outline' : 'default'} disabled={!readyToAdd.length || !!phase || !!probing}
              reason={!readyToAdd.length ? 'Сначала проверьте текст и выберите совместимые профили' : undefined} onClick={() => void confirm()}>
              {saving ? 'Добавляем…' : `Добавить в каталог${readyToAdd.length ? ` (${readyToAdd.length})` : ''}`}
            </WriteButton>
            {api.setVpnEnabled && readyToAdd.length === 1 && (
              <WriteButton disabled={!!phase || !!probing} onClick={() => void confirm(true)}>Сохранить и подключить</WriteButton>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {!isDemo && open && (
          <details className="rounded-lg border px-3 py-2 text-[13px]">
            <summary className="cursor-pointer py-1 font-medium">Ввести параметры вручную</summary>
            <form className="space-y-2 pt-2" onSubmit={(event) => {
              event.preventDefault()
              try {
                const manual = readConnection(event.currentTarget, 'import')
                setFile(undefined)
                void runPreview(manual)
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Проверьте параметры подключения.')
              }
            }}>
              <ConnectionFields prefix="import" disabled={!!phase} />
              <Button type="submit" variant="outline" size="sm" disabled={!!phase}>Проверить параметры</Button>
            </form>
          </details>
        )}
        <ImportFiles
          label="Выбрать файл профиля"
          accept=".json,.conf,.txt,.uri,.url,.wg,.awg,.yaml,.yml"
          files={file ? [file] : []}
          disabled={!!phase}
          onChange={(files) => { setFile(files[0]); setCandidates(null) }}
        />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="import-text" className="text-[13px] font-medium">
              Ссылки или текст конфигурации
            </label>
            <Button variant="ghost" size="sm" disabled={!!phase || !!file} onClick={() => changeText(SAMPLE)}>
              <Link2 /> Пример
            </Button>
          </div>
          <Textarea
            id="import-text"
            rows={7}
            value={text}
            disabled={!!phase || !!file}
            onChange={(e) => changeText(e.target.value)}
            placeholder={'vless://…\nhysteria2://…\ntrojan://…\n[Interface]\n…'}
            className="font-mono text-[12.5px]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void runPreview()} disabled={(!file && !text.trim()) || !!phase}>
              <RefreshCw className={phase === 'preview' ? 'motion-safe:animate-spin' : undefined} /> {phase === 'preview' ? 'Разбираем…' : 'Проверить'}
            </Button>
            {text && (
              <Button variant="ghost" size="sm" disabled={!!phase || !!file} onClick={() => changeText('')}>
                <Trash2 /> Очистить
              </Button>
            )}
            <span className="text-[12px] text-muted-foreground">VLESS, Hysteria2, Trojan и AmneziaWG. JSON, YAML, CONF, TXT и URI до 512 КиБ.</span>
          </div>
        </div>
        <details className="rounded-lg border px-3">
          <summary className="cursor-pointer py-2 text-[13px] font-medium">Параметры AmneziaWG</summary>
          <div className="grid gap-2.5 pb-3 sm:grid-cols-2">
            <SimpleSelect
              className="w-full"
              aria-label="Поколение AmneziaWG"
              value={awgVersion || 'auto'}
              disabled={!!phase}
              options={[{ value: 'auto', label: 'Определить поколение' }, { value: '2.0', label: 'AWG 2.0' }, { value: '3.1', label: 'AWG 3.1' }]}
              onChange={(version) => { setAwgVersion(version === 'auto' ? '' : version); setCandidates(null) }}
            />
            <Input
              aria-label="Интерфейс WireGuard ASC"
              placeholder="Интерфейс ASC (необязательно)"
              maxLength={15}
              disabled={!!phase}
              value={interfaceName}
              onChange={(event) => { setInterfaceName(event.target.value); setCandidates(null) }}
            />
          </div>
        </details>

        {missingEngines.length > 0 && (
          <Notice
            tone="warn"
            title="Для части профилей не установлено ядро"
            action={
              <a href={href('/exits', { tab: 'engines' })} className="text-[12.5px] whitespace-nowrap text-foreground underline-offset-2 hover:underline">
                Открыть «Ядра»
              </a>
            }
          >
            {missingEngines.map((c) => c.name).join(', ')}: {missingEngines[0]?.reason} Профиль не будет добавлен, пока компонент не установлен.
          </Notice>
        )}

        {candidates && (
          <div className="space-y-2">
            <div className="text-[13px] font-medium">Предпросмотр · {candidates.length ? `${candidates.length} в разборе` : 'пусто'}</div>
            {candidates.length === 0 ? (
              <Notice tone="warn" title="Ничего не распознано">
                Проверьте, что ссылки начинаются с <Mono>vless://</Mono>, <Mono>hysteria2://</Mono> или <Mono>trojan://</Mono>, а конфигурация AWG содержит раздел <Mono>[Interface]</Mono>.
              </Notice>
            ) : (
              <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
                {candidates.map((c) => {
                  const meta = IMPORT_STATUS[c.status]
                  const addable = canAdd(c)
                  const engine = engineOf(c)
                  return (
                    <div key={c.key} className="space-y-2 bg-card px-3.5 py-3">
                      <div className="flex items-start gap-2.5">
                        <Checkbox
                          className="mt-0.5 shrink-0"
                          checked={!!selected[c.key] && addable}
                          disabled={!addable || saving}
                          onCheckedChange={(v) => setSelected((prev) => ({ ...prev, [c.key]: v === true }))}
                          aria-label={`Добавить ${c.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="truncate text-[13.5px] font-medium">{c.name}</span>
                            <StatusBadge tone={meta.tone} icon={meta.icon} dashed={meta.dashed}>
                              {meta.label}
                            </StatusBadge>
                            <span className="text-[11.5px] text-muted-foreground">
                              {c.protocol === 'unknown' ? 'Не распознан' : PROTOCOL_LABEL[c.protocol]} · {c.transport}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                            <span>
                              Адрес: <Mono>{c.server}</Mono>
                            </span>
                            <span>
                              Движок: {engine ? engineName(engine) : c.adapter ? engineName(c.adapter) : 'не выбран'}
                            </span>
                          </div>
                          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{c.reason}</p>
                          {api.probeImportedProfile && c.protocol === 'vless' && c.status === 'ok' && (
                            <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
                              <WriteButton variant="outline" size="sm" disabled={!!phase || !!probing}
                                aria-label={`Проверить задержку ${c.name}`} onClick={() => void probeCandidate(c.key)}>
                                {probing === c.key ? 'Измеряем…' : 'Проверить до добавления'}
                              </WriteButton>
                              {probes[c.key] && <ProbeBadge probe={probes[c.key]} />}
                              {probes[c.key]?.note && <span className="text-xs text-muted-foreground">{probes[c.key].note}</span>}
                            </div>
                          )}
                          {c.requires.length > 0 && (
                            <p className="mt-1 text-[11.5px] text-muted-foreground">Требуется: {c.requires.join(' · ')}</p>
                          )}
                          {c.alternatives.length > 0 && (
                            <p className="mt-1 text-[11.5px] text-muted-foreground">Совместимые движки: {c.alternatives.map((a) => engineName(a)).join(', ')}</p>
                          )}
                        </div>
                      </div>

                      {c.status === 'needs-confirmation' && c.awgGenerations && (
                        <div className="ml-7 space-y-1.5 rounded-lg bg-warn/8 px-3 py-2 ring-1 ring-inset ring-warn/20">
                          <div className="flex items-center gap-1.5 text-[12px] font-medium text-warn">
                            <AlertTriangle className="size-3.5" /> Выберите поколение AmneziaWG
                          </div>
                          <Segmented
                            size="sm"
                            value={generations[c.key] ?? ''}
                            onChange={(g) => {
                              const gen = g as Generation
                              setGenerations((prev) => ({ ...prev, [c.key]: gen }))
                              const eng = engineForGeneration(gen, rt?.engines)
                              setSelected((prev) => ({ ...prev, [c.key]: !!eng }))
                            }}
                            options={c.awgGenerations.map((g) => ({
                              value: g as string,
                              label: `AWG ${g}`,
                              disabled: saving,
                              hint: engineForGeneration(g, rt?.engines) ? 'Есть установленное ядро' : 'Ни одно установленное ядро не поддерживает это поколение',
                            }))}
                          />
                          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                            {generations[c.key]
                              ? engineForGeneration(generations[c.key], rt?.engines)
                                ? `Будет использован ${engineName(engineForGeneration(generations[c.key], rt?.engines)!)}.`
                                : 'Для этого поколения нет установленного ядра — выберите другое или установите компонент.'
                              : 'Параметры Jc/S1/S2/H1–H4 подходят и к 1.0, и к 1.5. Автоматически угадывать поколение нельзя: от него зависит формат ключей и обфускация.'}
                          </p>
                        </div>
                      )}

                      {c.status === 'engine-missing' && (
                        <p className="ml-7 text-[11.5px] text-muted-foreground">Сначала установите компонент — иначе профиль не сможет подключиться. Хранение профиля в каталоге процесс не запускает.</p>
                      )}
                      {c.status === 'needs-other-engine' && (
                        <p className="ml-7 text-[11.5px] leading-relaxed text-muted-foreground">
                          Движок по умолчанию не поддерживает этот параметр транспорта, поэтому профиль исполнит {c.adapter ? engineName(c.adapter) : 'другой движок'} — это подтверждено
                          каталогом ядер.
                          {c.alternatives.length > 0 && ` Другие совместимые движки: ${c.alternatives.map((a) => engineName(a)).join(', ')}.`}
                        </p>
                      )}
                      {c.status === 'unsupported' && <p className="ml-7 text-[11.5px] text-muted-foreground">Профиль не будет добавлен.</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Новый профиль из кандидата предпросмотра. */
function buildProfile(c: ProfileImportCandidate, generation: Generation | undefined, engines: EngineInfo[] | undefined, fileName?: string): Profile | null {
  if (c.protocol === 'unknown') return null
  const engine = c.adapter ?? (generation ? engineForGeneration(generation, engines) : null)
  if (!engine) return null
  const protocol: VpnProtocol = c.protocol
  return {
    id: newId('p'),
    name: c.name,
    tags: [],
    protocol,
    transport: generation ? `AWG ${generation} · UDP` : c.transport,
    server: c.server,
    country: /^[A-Za-z]{2}[-_ ]/.test(c.name) ? c.name.slice(0, 2).toLowerCase() : '',
    origin: { type: 'file', fileName: fileName ?? 'вставленный текст', importedAt: new Date().toISOString() },
    adapter: {
      mode: 'auto',
      engine,
      reason: generation
        ? `Поколение ${generation} выбрано вручную при импорте: ${ENGINE_LABEL[engine]} поддерживает его.`
        : c.reason,
    },
    enabled: true,
    favorite: false,
    lifecycle: 'active',
  }
}
