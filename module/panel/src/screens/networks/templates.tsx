import { useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { Policy } from '@/api/contract'
import { useCanWrite, useTopology } from '@/state/resource'
import { useDraft } from '@/state/draft'
import { href } from '@/state/router'
import { Section, EmptyState } from '@/components/rh/layout'
import { WriteButton, SimpleSelect } from '@/components/rh/controls'
import { ReadOnlyHint } from '@/components/rh/coverage'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { newId } from '@/lib/entities'
import { policyUsers } from '@/lib/policy'
import { count } from '@/lib/format'
import { globalPolicy, wouldCycle } from './helpers'

export function TemplatesSection({ compact = false }: { compact?: boolean }) {
  const { config, edit } = useDraft()
  const topo = useTopology()
  const can = useCanWrite()
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<Policy | null>(null)
  const [saving, setSaving] = useState<'create' | 'delete' | null>(null)
  if (!config) return null

  const templates = config.policies.filter((p) => p.kind === 'template')
  const create = async () => {
    const n = name.trim()
    if (!n || saving || !can) return
    setSaving('create')
    try {
      const saved = await edit(`Создан шаблон «${n}»`, (c) => {
        c.policies.push({
          id: newId('pol-tpl'),
          name: n,
          kind: 'template',
          parentId: globalPolicy(c)?.id ?? null,
          rules: [],
          disabledParentRuleIds: [],
          defaultAction: { kind: 'inherit' },
          fallbackOverride: null,
          description: 'Шаблон: к нему подключаются сети ссылкой из своей политики.',
        })
      })
      if (saved) setName('')
    } finally {
      setSaving(null)
    }
  }

  const usedBy = deleting ? policyUsers(config, topo.data, deleting.id) : []

  async function removeTemplate() {
    if (!deleting || usedBy.length || saving || !can) return
    setSaving('delete')
    try {
      if (await edit(`Удалён шаблон «${deleting.name}»`, (c) => {
        c.policies = c.policies.filter((p) => p.id !== deleting.id)
      })) setDeleting(null)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Section
      title={compact ? undefined : 'Шаблоны'}
      description={compact ? undefined : 'Шаблон — общий набор правил для нескольких сетей. Сеть ссылается на него, оставаясь со своей политикой: правка шаблона затрагивает все подключённые сети.'}
    >
      <div className="divide-y overflow-hidden rounded-xl ring-1 ring-border">
        {templates.map((p) => (
          <TemplateRow key={p.id} policy={p} onDelete={() => setDeleting(p)} />
        ))}
        {templates.length === 0 && <EmptyState title="Шаблонов пока нет">Создайте шаблон, чтобы применять один набор правил к нескольким сетям.</EmptyState>}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
          placeholder="Название нового шаблона"
          aria-label="Название нового шаблона"
          disabled={!can || !!saving}
          className="sm:max-w-72"
        />
        <WriteButton variant="outline" size="sm" onClick={() => void create()} disabled={!name.trim() || !!saving}>
          <Plus /> {saving === 'create' ? 'Создаём…' : 'Создать шаблон'}
        </WriteButton>
        <ReadOnlyHint />
      </div>
      {!compact && <p className="mt-2 text-[12px] text-muted-foreground">Шаблон подключается к сети в её политике: откройте сеть → «Родительская политика».</p>}

      <AlertDialog open={!!deleting} onOpenChange={(o) => { if (!o && saving !== 'delete') setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить шаблон «{deleting?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              {usedBy.length
                ? `Шаблон используется: ${usedBy.join(', ')}. Сначала отключите его у этих объектов — удаление ссылки, на которую опираются правила, недопустимо.`
                : 'Шаблон и его правила будут удалены из конфигурации.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving === 'delete'}>Оставить</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!can || usedBy.length > 0 || !!saving}
              onClick={() => void removeTemplate()}
            >
              {saving === 'delete' ? 'Удаляем…' : 'Удалить'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function TemplateRow({ policy: p, onDelete }: { policy: Policy; onDelete: () => void }) {
  const { config, edit } = useDraft()
  const topo = useTopology()
  const can = useCanWrite()
  const [rename, setRename] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)
  const [cycleError, setCycleError] = useState<string | null>(null)
  if (!config) return null

  const users = policyUsers(config, topo.data, p.id)
  const candidates = config.policies.filter((x) => (x.kind === 'template' || x.kind === 'global') && x.id !== p.id)
  const commitRename = async () => {
    if (rename === null || savingName || !can) return
    const n = rename.trim()
    if (!n || n === p.name) {
      setRename(null)
      return
    }
    setSavingName(true)
    try {
      if (await edit(`Шаблон «${p.name}» переименован в «${n}»`, (c) => {
        const target = c.policies.find((x) => x.id === p.id)
        if (!target) throw new Error('Шаблон удалён.')
        target.name = n
      })) setRename(null)
    } finally {
      setSavingName(false)
    }
  }
  const setParent = (nextId: string | null) => {
    if (wouldCycle(config, p.id, nextId)) {
      const name = config.policies.find((x) => x.id === nextId)?.name ?? nextId
      setCycleError(`«${name}» уже наследует от «${p.name}» — такая ссылка замкнула бы цепочку. Изменение не сохранено.`)
      return
    }
    setCycleError(null)
    edit(`Родитель шаблона «${p.name}»`, (c) => {
      const target = c.policies.find((x) => x.id === p.id)
      if (target) target.parentId = nextId
    })
  }

  return (
    <div className="bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {rename === null ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium">{p.name}</span>
              <span className="text-[11.5px] text-muted-foreground">{count(p.rules.length, ['правило', 'правила', 'правил'])}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={rename}
                disabled={savingName}
                onChange={(e) => setRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') setRename(null)
                }}
                className="h-7 max-w-64"
                aria-label="Новое имя шаблона"
              />
              <Button size="icon-xs" variant="ghost" disabled={savingName} onClick={() => void commitRename()} aria-label="Сохранить имя">
                <Check />
              </Button>
              <Button size="icon-xs" variant="ghost" disabled={savingName} onClick={() => setRename(null)} aria-label="Отменить переименование">
                <X />
              </Button>
            </div>
          )}
          <div className="mt-0.5 text-[12px] text-muted-foreground">{users.length ? `используется: ${users.join(', ')}` : 'никто не ссылается'}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Наследует от</span>
            <SimpleSelect
              className="w-60"
              value={p.parentId ?? 'none'}
              disabled={!can}
              options={[
                { value: 'none', label: 'Ни от кого — конец цепочки' },
                ...candidates.map((x) => ({ value: x.id, label: x.name, group: x.kind === 'global' ? 'Общие правила' : 'Шаблоны' })),
              ]}
              onChange={(v) => setParent(v === 'none' ? null : v)}
            />
          </div>
          {cycleError && (
            <p className="mt-1 text-[12px] text-bad" role="alert">
              {cycleError}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a href={href('/rules', { policy: p.id })} className="hidden h-7 items-center rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex">
            Правила
          </a>
          <Button size="icon-sm" variant="ghost" disabled={!can} onClick={() => setRename(p.name)} aria-label={`Переименовать шаблон «${p.name}»`}>
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={!can} onClick={onDelete} aria-label={`Удалить шаблон «${p.name}»`} className="text-muted-foreground hover:text-bad">
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  )
}
