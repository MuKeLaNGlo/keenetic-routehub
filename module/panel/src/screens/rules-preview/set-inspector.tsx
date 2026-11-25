import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { Config, NamedSet } from '@/api/contract'
import { EntryPagination } from '@/components/rh/entry-pagination'
import { DetailSheet } from '@/components/rh/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SimpleSelect } from '@/components/rh/controls'
import { newId } from '@/lib/entities'
import { EDITOR_ENTRY_PAGE_SIZE, ENTRY_TYPE_LABEL, entryPage, isSetPreviewMarker, setEntryType, validateSetEntry } from '@/lib/rule-entries'
import { RuleDisclosure } from '@/screens/rules/disclosure'
import { NEW_SET, SetBadges, SetSourceDetails, setUsers } from '@/screens/rules/sets-tab'
import { useDraft } from '@/state/draft'
import { useCanWrite } from '@/state/resource'
import { closeQuery, setQuery } from '@/state/router'

export function SetInspector({ config, setId, linkedIndex, rulesPath }: { config: Config; setId: string | null; linkedIndex?: number; rulesPath: string }) {
  const set = config.sets.find(({ id }) => id === setId)
  const canWrite = useCanWrite()
  const creating = canWrite && setId === NEW_SET
  const fromUrl = set?.source.type === 'url'
  return (
    <DetailSheet
      open={!!setId}
      onClose={() => closeQuery('set', 'entry')}
      title={<span className="[overflow-wrap:anywhere]">{creating ? 'Новый набор' : set?.name ?? 'Набор не найден'}</span>}
      description={set && (fromUrl ? 'Доступные записи из источника' : canWrite ? undefined : 'Только чтение')}
      headerExtra={set && <div className="flex flex-wrap gap-1.5"><SetBadges set={set} /></div>}
    >
      {creating ? <CreateSet /> : set ? (
        <SetEntries key={`${set.id}/${linkedIndex ?? ''}`} set={set} config={config} linkedIndex={linkedIndex} rulesPath={rulesPath} editable={canWrite && !fromUrl} />
      ) : <p className="text-sm text-muted-foreground">Этот набор удалён или ещё не создан.</p>}
    </DetailSheet>
  )
}

const SET_KINDS = [
  { value: 'domains', label: 'Домены и их поддомены' },
  { value: 'cidrs', label: 'IP-адреса и подсети' },
]

function CreateSet() {
  const { edit } = useDraft()
  const formId = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<NamedSet['kind']>('domains')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const active = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function create() {
    const label = name.trim()
    if (saving || !label) return
    const entries = new Set<string>()
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      const entry = validateSetEntry(kind, line)
      if ('error' in entry) {
        setError(`Строка ${index + 1}. ${entry.error}`)
        return
      }
      entries.add(entry.value)
    }
    const set: NamedSet = { id: newId('set'), name: label, kind, entries: [...entries], source: { type: 'manual' } }
    setSaving(true)
    setError('')
    try {
      if (await edit(`Создан набор «${label}»`, (config) => { config.sets.push(set) }) && active.current) {
        setQuery({ set: set.id }, { replace: true })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <fieldset disabled={saving} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-name`}>Название набора</Label>
          <Input id={`${formId}-name`} value={name} maxLength={128} required onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-kind`}>Содержимое набора</Label>
          <SimpleSelect id={`${formId}-kind`} value={kind} disabled={saving} options={SET_KINDS}
            onChange={(value) => { setKind(value === 'cidrs' ? 'cidrs' : 'domains'); setError('') }} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-entries`}>Записи, по одной на строку</Label>
          <Textarea id={`${formId}-entries`} value={text} rows={6} spellCheck={false} className="font-mono"
            placeholder={kind === 'domains' ? 'example.com' : '192.0.2.0/24'}
            aria-invalid={Boolean(error)} onChange={(event) => { setText(event.target.value); setError('') }} />
          {error && <p role="alert" className="text-xs text-bad">{error}</p>}
        </div>
      </fieldset>
      <Button type="submit" disabled={saving || !name.trim()}>{saving ? 'Сохраняем…' : 'Создать набор'}</Button>
    </form>
  )
}

type PendingEntry = { index: number; original: string | null; value: string }

function SetEntries({ set, config, linkedIndex, rulesPath, editable }: {
  set: NamedSet
  config: Config
  linkedIndex?: number
  rulesPath: string
  editable: boolean
}) {
  const { edit } = useDraft()
  const id = useId()
  const motionReduced = useReducedMotion()
  const editor = useRef<HTMLInputElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const { entries } = set
  const realIndexes = useMemo(() => entries.flatMap((value, index) => isSetPreviewMarker(value) ? [] : [index]), [entries])
  const linkedPosition = linkedIndex === undefined ? -1 : realIndexes.indexOf(linkedIndex)
  const [search, setSearch] = useState('')
  const [requestedPage, setPage] = useState(Math.floor(Math.max(0, linkedPosition) / EDITOR_ENTRY_PAGE_SIZE))
  const [pending, setPending] = useState<PendingEntry | null>(() => {
    if (linkedIndex === undefined || linkedPosition < 0 || set.source.type !== 'manual') return null
    const original = entries[linkedIndex]
    return { index: linkedIndex, original, value: original }
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteSet, setDeleteSet] = useState(false)
  const used = setUsers(config.policies, set.id).length > 0
  const needle = search.trim().toLowerCase()
  const matches = useMemo(() => needle ? realIndexes.filter((index) => entries[index].toLowerCase().includes(needle)) : realIndexes, [realIndexes, entries, needle])
  const page = entryPage(requestedPage, matches.length, EDITOR_ENTRY_PAGE_SIZE)
  const visible = matches.slice(page.start, page.end)
  if (editable && pending && !visible.includes(pending.index)) visible.push(pending.index)

  useEffect(() => {
    if (linkedIndex === undefined || linkedPosition < 0) return
    const frame = requestAnimationFrame(() => {
      document.getElementById(`${id}-row-${linkedIndex}`)?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [linkedIndex, linkedPosition, id, editable])

  function focusRow(index?: number) {
    requestAnimationFrame(() => {
      const row = index === undefined ? null : document.getElementById(`${id}-edit-${index}`)
      const target = row ?? filterInput.current ?? addButton.current
      target?.focus()
    })
  }

  function begin(index: number, original: string | null) {
    if (saving) return
    if (pending && pending.index !== index && pending.value !== (pending.original ?? '')) {
      setError('Сохраните или отмените текущую правку.')
      editor.current?.focus()
      return
    }
    if (original === null) {
      setSearch('')
      setPage(Math.floor(realIndexes.length / EDITOR_ENTRY_PAGE_SIZE))
    }
    setPending({ index, original, value: original ?? '' })
    setError(null)
    requestAnimationFrame(() => editor.current?.focus())
  }

  function abandon() {
    const index = pending?.original === null ? undefined : pending?.index
    setPending(null)
    setError(null)
    focusRow(index)
  }

  async function commit(remove: boolean) {
    if (!editable || !pending || saving) return
    const { index, original } = pending
    const isNew = original === null
    if (!isNew && entries[index] !== original) {
      setError('Запись изменилась. Закройте редактор строки и откройте её заново.')
      return
    }
    if (remove && entries.length === 1 && used) {
      setError('В используемом наборе должна оставаться хотя бы одна запись.')
      return
    }
    const result = remove ? { value: '' } : validateSetEntry(set.kind, pending.value)
    if ('error' in result) {
      setError(result.error)
      editor.current?.focus()
      return
    }
    const { value } = result
    if (!remove && value !== original && entries.some((entry, i) => i !== index && entry.trim().toLowerCase() === value)) {
      setError('Такая запись уже есть в наборе.')
      editor.current?.focus()
      return
    }
    let insertedIndex = index
    if (remove || value !== original) {
      const operation = remove ? 'Удалена' : isNew ? 'Добавлена' : 'Изменена'
      setSaving(true)
      try {
        const saved = await edit(`${operation} запись в наборе «${set.name}»`, (config) => {
          const target = config.sets.find(({ id }) => id === set.id)
          if (!target || target.source.type !== 'manual') throw new Error('Набор больше недоступен для редактирования.')
          if (!isNew && target.entries[index] !== original) {
            throw new Error('Запись изменилась. Закройте редактор строки и откройте её заново.')
          }
          if (!remove && target.entries.some((entry, i) => (isNew || i !== index) && entry.trim().toLowerCase() === value)) {
            throw new Error('Такая запись уже есть в наборе.')
          }
          if (isNew) {
            insertedIndex = target.entries.length
            target.entries.push(value)
          } else if (remove) target.entries.splice(index, 1)
          else target.entries[index] = value
        })
        if (!saved) return
      } finally {
        setSaving(false)
      }
    }
    setPending(null)
    setError(null)
    if (remove) {
      const neighbors = matches.filter((other) => other !== index)
      const position = Math.min(neighbors.length - 1, Math.max(0, matches.indexOf(index)))
      if (position >= 0) {
        const neighbor = neighbors[position]
        setPage(Math.floor(position / EDITOR_ENTRY_PAGE_SIZE))
        focusRow(neighbor > index ? neighbor - 1 : neighbor)
      } else focusRow()
    } else if (isNew) {
      setPage(Math.floor(realIndexes.length / EDITOR_ENTRY_PAGE_SIZE))
      focusRow(insertedIndex)
    } else {
      focusRow(value.includes(needle) ? index : undefined)
    }
  }

  async function removeSet() {
    if (saving || used) return
    setSaving(true)
    try {
      if (await edit(`Удалён набор «${set.name}»`, (config) => {
        if (setUsers(config.policies, set.id).length) throw new Error('Сначала уберите ссылки на набор из правил.')
        config.sets = config.sets.filter(({ id }) => id !== set.id)
      })) closeQuery('set', 'entry')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          ref={filterInput}
          type="search"
          value={search}
          className="h-9 min-w-0 flex-1 basis-40"
          spellCheck={false}
          aria-label="Поиск по записям набора"
          placeholder="Найти запись в наборе"
          onChange={(event) => { setSearch(event.target.value); setPage(0) }}
        />
        {editable && <Button ref={addButton} type="button" variant="outline" size="sm" className="min-h-9" disabled={saving} onClick={() => begin(entries.length, null)}><Plus aria-hidden="true" /> Добавить запись</Button>}
      </div>
      {realIndexes.length !== entries.length && <p className="text-xs text-muted-foreground">Здесь показана доступная часть списка из источника.</p>}
      {set.source.type === 'url' && (
        <RuleDisclosure title="Источник и обновления" className="overflow-hidden rounded-xl border border-border">
          <SetSourceDetails set={set} config={config} rulesPath={rulesPath} compact />
        </RuleDisclosure>
      )}
      <EntryPagination state={page} label="Страницы записей набора" onPageChange={setPage} />

      {visible.length ? (
        <ul className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-label="Записи набора">
          {visible.map((index) => {
            const value = entries[index]
            const label = ENTRY_TYPE_LABEL[setEntryType(set.kind, value ?? '')]
            const rowId = `${id}-row-${index}`
            const summary = <><span className="min-w-0 flex-1 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{value}</span><span className="text-xs text-muted-foreground">{label}</span></>
            return (
              <li key={index} id={rowId} className="min-w-0">
                {editable && pending?.index === index ? (
                  <motion.form
                    className="min-w-0 space-y-2 bg-muted/35 p-3"
                    initial={motionReduced ? false : { opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: motionReduced ? 0 : 0.16 }}
                    onSubmit={(event) => { event.preventDefault(); void commit(false) }}
                  >
                    <Input
                      ref={editor}
                      className="h-9 w-full min-w-0 font-mono text-[13px]"
                      aria-label={pending.original === null ? 'Новая запись' : `Значение записи ${index + 1}`}
                      aria-invalid={!!error}
                      aria-describedby={error ? `${rowId}-error` : undefined}
                      placeholder={set.kind === 'domains' ? 'example.com' : '192.0.2.0/24'}
                      value={pending.value}
                      disabled={saving}
                      spellCheck={false}
                      onChange={(event) => { setPending({ ...pending, value: event.target.value }); setError(null) }}
                    />
                    {error && <p id={`${rowId}-error`} className="text-xs text-bad">{error}</p>}
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
                      {pending.original !== null && <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 text-bad" disabled={saving} onClick={() => void commit(true)} aria-label={`Удалить запись ${index + 1}`}><Trash2 aria-hidden="true" /></Button>}
                      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
                        <Button type="button" variant="ghost" size="sm" className="min-h-9" disabled={saving} onClick={abandon}>Отмена</Button>
                        <Button type="submit" size="sm" className="min-h-9" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</Button>
                      </div>
                    </div>
                  </motion.form>
                ) : editable ? (
                  <button
                    id={`${id}-edit-${index}`}
                    type="button"
                    className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    aria-label={`Редактировать запись ${index + 1}: ${value}`}
                    disabled={saving}
                    onClick={() => begin(index, value)}
                  >{summary}<Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /></button>
                ) : <div className="flex min-h-11 min-w-0 items-center gap-2.5 px-3 py-2">{summary}</div>}
              </li>
            )
          })}
        </ul>
      ) : <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">{realIndexes.length ? 'Записи не найдены' : 'В наборе пока нет записей'}</p>}

      {set.source.type === 'manual' && <SetSourceDetails set={set} config={config} rulesPath={rulesPath} compact />}
      {editable && !used && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {deleteSet ? (
            <>
              <p className="basis-full text-sm">Удалить набор со всеми записями?</p>
              <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setDeleteSet(false)}>Отмена</Button>
              <Button type="button" variant="destructive" size="sm" disabled={saving} onClick={() => void removeSet()}>Удалить</Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={saving || !!pending} onClick={() => setDeleteSet(true)}><Trash2 aria-hidden="true" /> Удалить набор</Button>
          )}
        </div>
      )}
    </div>
  )
}
