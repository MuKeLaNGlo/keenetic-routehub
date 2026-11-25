import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/api'
import type { Action, Family, Match, Policy, Rule, RuleImportOptions, RuleImportPreview, RuleImportRow } from '@/api/contract'
import { useDraft } from '@/state/draft'
import { useGeo } from '@/state/resource'
import { closeQuery } from '@/state/router'
import { Modal } from '@/components/rh/sheet'
import { Notice } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'
import { SimpleSelect, Mono, WriteButton } from '@/components/rh/controls'
import { ActionPicker } from '@/components/rh/action'
import { ImportFiles } from '@/components/rh/import-files'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { bytes, count } from '@/lib/format'
import { MATCH_TYPE_LABEL } from '@/lib/labels'
import { newId } from '@/lib/entities'
import { RulePagination, rulePage } from './rule-pagination'

const ROW_STATE: Record<RuleImportRow['status'], { tone: 'ok' | 'muted' | 'bad' | 'info'; label: string }> = {
  add: { tone: 'ok', label: 'добавить' },
  duplicate: { tone: 'muted', label: 'дубликат' },
  skip: { tone: 'bad', label: 'пропущено' },
  change: { tone: 'info', label: 'изменение' },
}

const formats = [
  ['auto', 'Определить автоматически'], ['text', 'Текст / TXT / LST'], ['comma', 'Comma / CSV'], ['json', 'JSON'],
  ['dlc', 'v2fly Domain List Community'], ['geoip', 'v2ray GeoIP (.dat)'], ['geosite', 'v2ray GeoSite (.dat)'],
  ['singbox', 'sing-box JSON'], ['srs', 'sing-box SRS'], ['mikrotik', 'MikroTik (.rsc)'], ['switchy', 'SwitchyOmega'],
  ['nfset', 'Dnsmasq nftset'], ['ipset', 'Dnsmasq ipset'], ['clashx', 'ClashX / YAML'], ['kvas', 'Keenetic KVAS'],
  ['bat', 'Keenetic Routes (.bat)'], ['wildcard', 'Keenetic DNS'], ['amnezia', 'Amnezia JSON'], ['pac', 'PAC'], ['custom', 'Шаблон iplist'],
].map(([value, label]) => ({ value, label }))

const matchTypes = [
  ['auto', 'Определить автоматически'], ['domain', 'Домен'], ['ip', 'IP-адрес'], ['cidr', 'Подсеть CIDR'], ['geo', 'Код страны GeoIP'],
].map(([value, label]) => ({ value, label }))

const domainTypes = [
  ['auto', 'Как в файле'], ['exact', 'Точное совпадение'], ['suffix', 'Домен и поддомены'], ['wildcard', 'С подстановочным знаком'],
  ['keyword', 'Часть доменного имени'], ['regex', 'Регулярное выражение'],
].map(([value, label]) => ({ value, label }))

const maxFileSize = 2 * 1024 * 1024

export function ImportModal({ open, defaultPolicyId }: { open: boolean; defaultPolicyId: string }) {
  const { config, edit } = useDraft()
  const geo = useGeo()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [options, setOptions] = useState<RuleImportOptions>({})
  const [targetId, setTargetId] = useState(defaultPolicyId)
  const [preview, setPreview] = useState<{ data: RuleImportPreview; text: string; targetId: string; revision: number } | null>(null)
  const [previewPage, setPreviewPage] = useState(0)
  const [phase, setPhase] = useState<'preview' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const saving = phase === 'saving'

  // Reset when (re)opened, like every other URL-bound dialog here.
  useEffect(() => {
    requestId.current += 1
    if (!open) return
    setText('')
    setFiles([])
    setOptions({})
    setTargetId(defaultPolicyId)
    setPreview(null)
    setPreviewPage(0)
    setPhase(null)
    setError(null)
  }, [open, defaultPolicyId])

  const currentPreview = preview && preview.text === text && preview.targetId === targetId ? preview : null
  const stale = !!currentPreview && currentPreview.revision !== config?.revision
  const result = stale ? null : currentPreview?.data
  const { counts, addable } = useMemo(() => {
    const counts = { add: 0, change: 0, duplicate: 0, skip: 0 }
    const addable: RuleImportRow[] = []
    for (const row of result?.rows ?? []) {
      counts[row.status] += 1
      if (row.status === 'add' || row.status === 'change') addable.push(row)
    }
    return { counts, addable }
  }, [result])
  const page = rulePage(result?.rows.length ?? 0, previewPage)
  const visibleRows = result?.rows.slice(page.start, page.end) ?? []
  if (!config) return null
  const target = config.policies.find((p) => p.id === targetId)
  const hasInput = files.length > 0 || !!text.trim()
  const changeOptions = (update: Partial<RuleImportOptions>) => {
    setOptions((previous) => ({ ...previous, ...update }))
    setPreview(null)
    setError(null)
  }

  const runPreview = async () => {
    if (!target || !hasInput || phase) return
    if (files.some((file) => file.size > maxFileSize) || new Blob([text]).size > maxFileSize) {
      setError('Максимальный размер одного файла или вставленного списка — 2 МиБ')
      return
    }
    const request = ++requestId.current
    setPhase('preview')
    setError(null)
    setPreview(null)
    try {
      const data = await api.previewRuleImport(text, target.id, config, { ...options, files })
      if (request !== requestId.current) return
      setPreview({ data, text, targetId: target.id, revision: config.revision })
      setPreviewPage(0)
    } catch (e) {
      if (request !== requestId.current) return
      setError((e as Error).message)
      toast.error('Не удалось проверить импорт')
    } finally {
      if (request === requestId.current) setPhase(null)
    }
  }

  const confirm = async () => {
    if (!target || !addable.length || phase) return
    const request = ++requestId.current
    const n = addable.length
    setPhase('saving')
    const saved = await edit(`Импорт: ${n} правил в «${target.name}»`, (c) => {
      const policy = c.policies.find((p) => p.id === target.id)
      if (!policy) throw new Error('Выбранная область правил недоступна.')
      const usedIds = new Set(c.policies.flatMap((p) => p.rules.map((rule) => rule.id)))
      const imported = addable.map((row) => {
        let id = newId('r')
        while (usedIds.has(id)) id = newId('r')
        usedIds.add(id)
        return row.parsedRule ? { ...row.parsedRule, id } : importedRule(row, policy, id, options.action)
      })
      // Imported rules have priority over existing rules in the same policy.
      policy.rules = [...imported, ...policy.rules]
    })
    if (request !== requestId.current) return
    setPhase(null)
    if (saved) {
      closeQuery('import')
      toast.success(`Добавлено ${count(n, ['правило', 'правила', 'правил'])}`)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => closeQuery('import')}
      dismissible={!saving}
      size="lg"
      title="Импорт правил"
      description="Загрузите файлы или вставьте список доменов, IP и подсетей. Проверьте результат перед добавлением."
      footer={
        <div className="space-y-2">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-muted-foreground">
              {result ? `К добавлению: ${addable.length} из ${page.total} строк` : 'Проверьте список перед добавлением.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={saving} onClick={() => closeQuery('import')}>
                Отмена
              </Button>
              <WriteButton onClick={() => void confirm()} disabled={!addable.length || !!phase}>
                {saving ? 'Добавляем…' : addable.length ? `Добавить правила · ${addable.length}` : 'Добавить правила'}
              </WriteButton>
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <ImportFiles
          label="Выбрать файлы правил"
          files={files}
          multiple
          disabled={!!phase}
          onChange={(next) => { setFiles(next); setPreview(null); setError(null) }}
        />
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium">Список</div>
          <Textarea
            value={text}
            disabled={!!phase}
            onChange={(e) => { setError(null); setText(e.target.value) }}
            rows={8}
            spellCheck={false}
            className="font-mono text-[12.5px]"
            placeholder={'gosuslugi.ru\n151.101.0.0/16\nDOMAIN-SUFFIX,example.com'}
            aria-label="Строки для импорта"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <div className="text-[13px] font-medium">Куда добавить</div>
            <SimpleSelect
              className="w-full"
              value={targetId}
              disabled={!!phase}
              options={config.policies.map((p) => ({
                value: p.id,
                label: p.name,
                group: p.kind === 'global' ? 'Общие правила' : p.kind === 'template' ? 'Шаблоны' : p.kind === 'segment' ? 'Сети' : 'Устройства',
              }))}
              onChange={(id) => { setError(null); setTargetId(id) }}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!!phase} onClick={() => { setError(null); setText(sampleFor(target)) }}>
              <Wand2 /> Пример
            </Button>
            <Button size="sm" onClick={() => void runPreview()} disabled={!hasInput || !!phase || !target}>
              {phase === 'preview' ? 'Проверяем…' : 'Проверить'}
            </Button>
          </div>
        </div>

        {target && (
          <details className="rounded-lg border px-3">
            <summary className="cursor-pointer py-2 text-[13px] font-medium">Формат и маршрут</summary>
            <div className="space-y-3 pb-3">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs font-medium">
                  <span>Формат файла</span>
                  <SimpleSelect className="w-full" aria-label="Формат файла" disabled={!!phase} value={options.format ?? 'auto'} options={formats} onChange={(format) => changeOptions({ format, template: undefined })} />
                </label>
                <label className="space-y-1.5 text-xs font-medium">
                  <span>Тип назначения</span>
                  <SimpleSelect className="w-full" aria-label="Тип назначения" disabled={!!phase} value={options.type ?? 'auto'} options={matchTypes} onChange={(type) => changeOptions({ type, geoSource: undefined, domainMatch: undefined })} />
                </label>
                {options.type === 'geo' ? (
                  <label className="space-y-1.5 text-xs font-medium">
                    <span>База GeoIP</span>
                    <SimpleSelect
                      className="w-full"
                      aria-label="База GeoIP"
                      disabled={!!phase}
                      value={options.geoSource ?? ''}
                      options={[{ value: '', label: 'Выбрать базу', disabled: true }, ...(geo.data ?? []).filter(({ kind }) => kind === 'geoip').map(({ id, name }) => ({ value: id, label: name }))]}
                      onChange={(geoSource) => changeOptions({ geoSource })}
                    />
                  </label>
                ) : (options.type !== 'ip' && options.type !== 'cidr') && (
                  <label className="space-y-1.5 text-xs font-medium">
                    <span>Совпадение домена</span>
                    <SimpleSelect className="w-full" aria-label="Совпадение домена" disabled={!!phase} value={options.domainMatch ?? 'auto'} options={domainTypes} onChange={(domainMatch) => changeOptions({ domainMatch })} />
                  </label>
                )}
              </div>
              {options.format === 'custom' && (
                <label className="block space-y-1.5 text-xs font-medium">
                  <span>Шаблон iplist</span>
                  <Textarea rows={2} maxLength={1000} disabled={!!phase} value={options.template ?? ''} onChange={(event) => changeOptions({ template: event.target.value })} />
                </label>
              )}
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Маршрут для записей без явного назначения</span>
                <ActionPicker value={options.action ?? target.defaultAction} onChange={(action) => changeOptions({ action })} disabled={!!phase} allow={['direct', 'vpn', 'zapret', 'block']} />
              </div>
            </div>
          </details>
        )}

        {error && (
          <Notice tone="bad" title="Предпросмотр не удался">
            {error}. Ничего не изменено — исправьте список и проверьте снова.
          </Notice>
        )}

        {stale && <Notice tone="warn" title="Настройки изменились">Проверьте список ещё раз.</Notice>}

        {result && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <StatusBadge tone="muted">{result.format}</StatusBadge>
              <span className="text-muted-foreground">
                строк: {page.total} · пределы: {result.limits.maxLines} строк / {bytes(result.limits.maxBytes)}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <StatusBadge tone="ok">добавить {counts.add}</StatusBadge>
              {counts.change > 0 && <StatusBadge tone="info">изменить {counts.change}</StatusBadge>}
              <StatusBadge tone="muted">дубликаты {counts.duplicate}</StatusBadge>
              <StatusBadge tone="bad">пропущено {counts.skip}</StatusBadge>
            </div>

            <RulePagination label="Страницы предпросмотра импорта" page={page} onPage={setPreviewPage} />
            <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
              {visibleRows.map((row) => (
                <div key={row.line} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-2 bg-card px-3 py-2">
                  <span className="tabular text-[11.5px] text-muted-foreground">{row.line}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px]" title={row.raw.trim()}>
                      <Mono className="text-[12.5px]">{row.raw.trim()}</Mono>
                    </div>
                    <div className="text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
                      {row.match ? `${MATCH_TYPE_LABEL[row.match.type]} · ${row.match.value}` : (row.reason ?? 'не распознано')}
                      {row.match && row.reason ? ` · ${row.reason}` : ''}
                    </div>
                  </div>
                  <StatusBadge tone={ROW_STATE[row.status].tone} dashed={row.status === 'duplicate'}>
                    {ROW_STATE[row.status].label}
                  </StatusBadge>
                </div>
              ))}
              {page.total === 0 && <div className="bg-card px-3 py-4 text-[13px] text-muted-foreground">В списке нет строк для импорта.</div>}
            </div>

            {target && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Новые правила встанут в начало списка «{target.name}». Записи без маршрута получат действие из настроек импорта или действие области по умолчанию.
              </p>
            )}
          </div>
        )}

        {!result && !error && !stale && (
          <div className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Поддерживаются списки IPLIST, Keenetic DNS и Routes, TXT, CSV, JSON, Clash, v2fly и бинарные SRS и DAT. Каждый файл может занимать до 2 МиБ.
            </span>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** One imported row → one rule with a single match. */
function importedRule(row: RuleImportRow, policy: Policy, id: string, action?: Action): Rule {
  const match = row.match as Match
  const families: Family[] = match.type === 'cidr' || match.type === 'ip' ? (match.value.includes(':') ? ['v6'] : ['v4']) : ['v4', 'v6']
  return {
    id,
    name: match.value,
    matches: [match],
    families,
    protos: ['tcp', 'udp'],
    action: structuredClone(action ?? policy.defaultAction),
    enabled: true,
    source: { type: 'import', label: 'Импорт списка', at: new Date().toISOString() },
  }
}

/**
 * Sample that always demonstrates the four outcomes for the chosen scope:
 * new domains, a new CIDR, a rule that already exists there, and a line the
 * compiler cannot take.
 */
function sampleFor(policy: Policy | undefined): string {
  const existing = policy?.rules
    .flatMap((r) => r.matches)
    .find((m) => m.type === 'domain' || m.type === 'suffix' || m.type === 'ip' || m.type === 'cidr')?.value
  return [
    '# Пример: домены, подсеть, дубликат и неподдерживаемая строка',
    'cdn-ads.example',
    'metrics.example.net',
    '10.50.0.0/16',
    existing ?? 'gosuslugi.ru',
    'regexp:^banner\\..*$',
  ].join('\n')
}
