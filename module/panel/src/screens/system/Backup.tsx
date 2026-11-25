import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, FileJson, FileUp, Lock, ShieldAlert, Upload, X } from 'lucide-react'
import { api, type Config } from '@/api'
import { saveConfigChange } from '@/state/live-config'
import { useCanWrite, useServerConfig, useTopology } from '@/state/resource'
import { Notice, Panel, Section } from '@/components/rh/layout'
import { StatusBadge, type Tone } from '@/components/rh/status'
import { SimpleSelect, WriteButton } from '@/components/rh/controls'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { DetailSheet, Modal } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { bytes, count } from '@/lib/format'
import { COLLECTION_LABEL, fieldLabels } from '@/lib/configDiff'
import { applyCopyToConfig, copyFileName, downloadJson, exportCopy, inspectCopy, parseCopy, type CopyInspection, type ParsedCopy } from './backupFile'

const OP: Record<CopyInspection['changes'][number]['op'], { tone: Tone; label: string }> = {
  add: { tone: 'ok', label: 'добавится' },
  change: { tone: 'info', label: 'изменится' },
  remove: { tone: 'bad', label: 'удалится' },
}

interface Candidate {
  fileName: string
  copy: ParsedCopy
  inspection: CopyInspection
  baseRevision: number
}

export function Backup({ compact = false }: { compact?: boolean }) {
  const { data: server, refetch } = useServerConfig()
  const canWrite = useCanWrite()
  const fileRef = useRef<HTMLInputElement>(null)
  const fileRequest = useRef(0)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [exported, setExported] = useState<{ bytes: number; masked: number } | null>(null)

  if (!server) return <div className="h-40 animate-pulse rounded-xl bg-card ring-1 ring-border" />
  const stale = !!candidate && candidate.baseRevision !== server.revision

  const exportNow = () => {
    const e = exportCopy(server)
    downloadJson(copyFileName(), e.text)
    setExported({ bytes: e.bytes, masked: e.masked })
    toast.success('Копия сохранена', { description: `Секреты замаскированы: ${count(e.masked, ['поле', 'поля', 'полей'])}` })
  }

  const previewCopy = (fileName: string, copy: ParsedCopy) => {
    setRestoreError(null)
    setCandidate({ fileName, copy, inspection: inspectCopy(copy.config, server, copy.meta, copy.maskedFields), baseRevision: server.revision })
  }

  const readFile = async (file: File | undefined) => {
    if (!file || restoring) return
    const request = ++fileRequest.current
    setReading(true)
    setFileError(null)
    setRestoreError(null)
    setCandidate(null)
    try {
      const text = await file.text()
      if (request !== fileRequest.current) return
      const parsed: ParsedCopy | { error: string } = parseCopy(text)
      if ('error' in parsed) {
        setFileError(parsed.error)
        return
      }
      previewCopy(file.name, parsed)
    } catch (e) {
      if (request === fileRequest.current) setFileError((e as Error).message)
    } finally {
      if (request === fileRequest.current) setReading(false)
    }
  }

  const restore = async () => {
    if (!candidate || !canWrite || restoring || stale || candidate.inspection.problems.length || !candidate.inspection.changes.length) return
    setRestoring(true)
    setRestoreError(null)
    try {
      await saveConfigChange((config) => {
        if (config.revision !== candidate.baseRevision) throw new Error('Настройки изменились. Обновите предпросмотр копии.')
        applyCopyToConfig(config, candidate.copy.config)
      })
      setCandidate(null)
      toast.success('Настройки восстановлены из копии')
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : 'Повторите восстановление.')
      void refetch()
    } finally {
      setRestoring(false)
    }
  }

  const discard = () => { if (!restoring) setCandidate(null) }
  const preview = candidate && (
    <CopyPreview
      candidate={candidate}
      compact={compact}
      restoring={restoring}
      error={restoreError}
      stale={stale}
      onRefresh={() => previewCopy(candidate.fileName, candidate.copy)}
      onDiscard={discard}
      onRestore={() => void restore()}
    />
  )

  if (compact) {
    return (
      <div className="space-y-3.5">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            void readFile(file)
          }}
        />
        <div className="grid items-stretch gap-3 @min-[620px]:grid-cols-2">
          <Panel className="flex flex-col items-start gap-2.5 p-3.5">
            <h2 className="text-sm font-semibold">Скачать копию</h2>
            <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
              Копия сохранённой конфигурации r{server.revision}. Адреса профилей и секреты маскируются.
            </p>
            <Button className="min-h-9" onClick={exportNow}><Download aria-hidden="true" /> Скачать JSON</Button>
            {exported && (
              <p className="text-[12px] text-muted-foreground" role="status">
                {bytes(exported.bytes)} · замаскировано {count(exported.masked, ['поле', 'поля', 'полей'])}.
              </p>
            )}
          </Panel>
          <Panel className="flex flex-col items-start gap-2.5 p-3.5">
            <h2 className="text-sm font-semibold">Восстановить из файла</h2>
            <p className="flex-1 text-[12.5px] text-muted-foreground">Панель проверит JSON и покажет, какие настройки заменит копия.</p>
            <Button variant="outline" className="min-h-9" disabled={reading || restoring} onClick={() => fileRef.current?.click()}>
              <FileUp aria-hidden="true" /> {reading ? 'Читаем файл…' : 'Выбрать файл…'}
            </Button>
            {!canWrite && <ReadOnlyHint />}
          </Panel>
        </div>
        {api.exportBackup && <RouterBackup config={server} exportBackup={api.exportBackup.bind(api)} canWrite={canWrite} />}
        {fileError && <Notice tone="bad" title="Файл не принят">{fileError}</Notice>}
        <DetailSheet open={!!preview} title="Предпросмотр копии" width="lg" onClose={discard}>
          {preview}
        </DetailSheet>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Section
        title="Экспорт копии"
        description="Полная конфигурация: политики, правила, профили, группы, DNS, Zapret, игровые пресеты и автозапуск. Секреты и адреса профилей попадают в файл замаскированными."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={exportNow}>
              <Download /> Скачать копию (JSON)
            </Button>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Lock className="size-3" /> секреты маскируются
            </span>
            <ReadOnlyHint className="sm:ml-auto" />
          </div>
          {exported && (
            <p className="text-[12px] text-muted-foreground">
              Последний файл: {bytes(exported.bytes)} · замаскировано {count(exported.masked, ['поле', 'поля', 'полей'])}.
            </p>
          )}
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Выборочные копии (только правила или только профили) — та же операция с подмножеством разделов; здесь выгружается полный конфиг. Полная копия с секретами — отдельная защищённая операция на роутере.
          </p>
        </div>
      </Section>

      {api.exportBackup && <RouterBackup config={server} exportBackup={api.exportBackup.bind(api)} canWrite={canWrite} />}

      <Section
        title="Восстановление из файла"
        description="Проверьте изменения в предпросмотре. Кнопка «Восстановить» сразу применит настройки из копии."
      >
        <div className="space-y-4">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void readFile(file)
            }}
            aria-label="Файл копии конфигурации"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={reading || restoring} onClick={() => fileRef.current?.click()}>
              <FileUp /> Выбрать файл…
            </Button>
            <span className="text-[12px] text-muted-foreground">JSON, созданный этой панелью</span>
          </div>

          {fileError && (
            <Notice tone="bad" title="Файл не принят">
              {fileError}. Ничего не изменено.
            </Notice>
          )}

          {preview}
        </div>
      </Section>
    </div>
  )
}

function RouterBackup({ config, exportBackup, canWrite }: {
  config: Config
  exportBackup: NonNullable<typeof api.exportBackup>
  canWrite: boolean
}) {
  const topology = useTopology()
  const [device, setDevice] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const choices = config.devicePolicies.flatMap((policy) => {
    const device = topology.data?.devices.find(({ id }) => id === policy.deviceId)
    const mac = device?.mac || policy.deviceId
    return /^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(mac)
      ? [{ value: mac, label: policy.alias || device?.hostname || mac }]
      : []
  })
  const activeDevice = choices.some((choice) => choice.value === device) ? device : ''

  const download = async (scope: 'rules' | 'configuration') => {
    if (busy || !canWrite) return
    setBusy(true)
    try {
      const contents = await exportBackup(scope, scope === 'rules' && activeDevice ? activeDevice : undefined)
      downloadJson(scope === 'configuration' ? 'routehub-config.json' : 'routehub-rules.json', await contents.text())
      setConfirm(false)
      toast.success('Файл скачан')
    } catch (error) {
      toast.error('Не удалось скачать файл', { description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="space-y-3 p-3.5">
      <h2 className="text-sm font-semibold">Экспорт с роутера</h2>
      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          className="w-full min-w-36 sm:w-auto"
          aria-label="Область экспорта правил"
          value={activeDevice}
          options={[{ value: '', label: 'Общие правила' }, ...choices]}
          onChange={setDevice}
          disabled={busy}
        />
        <WriteButton variant="outline" disabled={!canWrite || busy} onClick={() => void download('rules')}><Download /> Скачать правила</WriteButton>
        <WriteButton variant="outline" disabled={!canWrite || busy} onClick={() => setConfirm(true)}><Lock /> Скачать конфигурацию с ключами</WriteButton>
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        dismissible={!busy}
        title="Полная копия конфигурации"
        description="JSON содержит параметры подключения, пароли и приватные ключи VPN. Храните файл в защищённом месте."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Отмена</Button>
            <WriteButton disabled={!canWrite || busy} onClick={() => void download('configuration')}><Download /> {busy ? 'Готовим…' : 'Скачать JSON'}</WriteButton>
          </div>
        }
      >{null}</Modal>
    </Panel>
  )
}

function CopyPreview({ candidate, onDiscard, onRestore, onRefresh, compact, restoring, stale, error }: {
  candidate: Candidate
  onDiscard: () => void
  onRestore: () => void
  onRefresh: () => void
  compact: boolean
  restoring: boolean
  stale: boolean
  error: string | null
}) {
  const { copy, inspection, fileName } = candidate
  const blocked = inspection.problems.length > 0
  const shown = inspection.changes.slice(0, 60)
  const changeCount = count(inspection.changes.length, ['изменение', 'изменения', 'изменений'])
  const sameConfig = inspection.changes.length === 0

  return (
    <Panel tone={blocked ? 'bad' : undefined} className={compact ? 'space-y-3 bg-transparent ring-0' : 'space-y-4 p-4'}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <FileJson className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium">{fileName}</div>
            <div className="text-[12px] text-muted-foreground">
              Копия r{copy.config.revision}
              {copy.meta.exportedAt ? ` · ${new Date(copy.meta.exportedAt).toLocaleString('ru-RU')}` : ''}
              {copy.meta.formatVersion ? ` · формат ${copy.meta.formatVersion}` : ''}
            </div>
          </div>
        </div>
        {!compact && <Button variant="ghost" size="sm" disabled={restoring} onClick={onDiscard}>
          <X /> Закрыть
        </Button>}
      </div>

      {inspection.problems.length > 0 && (
        <Notice tone="bad" title="Копию нельзя восстановить">
          <ul className="list-disc space-y-1 pl-4">
            {inspection.problems.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {inspection.problems.length > 8 && <p className="mt-1">И ещё {inspection.problems.length - 8}.</p>}
        </Notice>
      )}

      {inspection.warnings.map((w) => (
        <Notice key={w} tone="warn" icon={<ShieldAlert />}>
          {w}
        </Notice>
      ))}

      {stale && !restoring && (
        <Notice tone="warn" title="Настройки изменились" action={<Button variant="outline" size="sm" onClick={onRefresh}>Обновить предпросмотр</Button>}>
          Проверьте разницу с текущими настройками перед восстановлением.
        </Notice>
      )}

      <CopyChanges compact={compact} summary={changeCount} collapsed={!sameConfig}>
        {!compact && <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-medium">Что изменится относительно текущей конфигурации</span>
          <span className="text-[11.5px] text-muted-foreground">{changeCount}</span>
        </div>}
        {sameConfig ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-[12.5px] text-muted-foreground">
            Копия совпадает с сохранённой конфигурацией.
          </p>
        ) : (
          <div className="divide-y overflow-hidden rounded-lg ring-1 ring-border">
            {shown.map((ch) => {
              const op = OP[ch.op]
              return (
                <div key={`${ch.collection}/${ch.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-card px-3 py-2 text-[12.5px]">
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="text-muted-foreground">{COLLECTION_LABEL[ch.collection]}</span>
                    <span className="mx-1.5 text-border">·</span>
                    <span className="font-medium">{ch.label}</span>
                    {ch.fields && ch.fields.length > 0 && (
                      <span className="ml-2 text-[11.5px] text-muted-foreground">
                        {fieldLabels(ch.fields).slice(0, 4).join(', ')}
                        {fieldLabels(ch.fields).length > 4 ? '…' : ''}
                      </span>
                    )}
                  </div>
                  <StatusBadge tone={op.tone}>{op.label}</StatusBadge>
                </div>
              )
            })}
          </div>
        )}
        {inspection.changes.length > shown.length && <p className="text-[11.5px] text-muted-foreground">Показаны первые {shown.length}.</p>}
      </CopyChanges>

      {error && <Notice tone="bad" title="Не удалось восстановить копию">{error}</Notice>}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <WriteButton
          disabled={blocked || sameConfig || stale || restoring}
          reason={blocked ? 'Сначала исправьте проблемы в файле' : undefined}
          onClick={onRestore}
        >
          <Upload /> {restoring ? 'Восстанавливаем…' : 'Восстановить'}
        </WriteButton>
      </div>
    </Panel>
  )
}

function CopyChanges({ compact, collapsed, summary, children }: { compact: boolean; collapsed: boolean; summary: string; children: React.ReactNode }) {
  if (!compact || !collapsed) return <div className="space-y-2">{children}</div>
  return (
    <details className="rounded-xl border border-border bg-card px-3">
      <summary className="min-h-10 cursor-pointer rounded py-2.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">{summary}</summary>
      <div className="space-y-2 pb-3">{children}</div>
    </details>
  )
}
