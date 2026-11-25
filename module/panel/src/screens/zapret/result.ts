/**
 * The sub-checks of a Zapret check, in the one shape the screen renders.
 *
 * The contract says a check task's `result` is a `ZapretCheckResult`. The mock
 * implementation fills `result` for real route tests only; `zapretCheck`
 * reports the very same sub-checks as task steps. Both are read here, and every
 * step state is mapped explicitly — an unfinished or skipped step is never
 * presented as a passing one.
 */
import type { ServiceCheckItem, Task, ZapretCheckResult } from '@/api/contract'
import type { Tone } from '@/components/rh/status'

export interface CheckRow {
  id: string
  label: string
  proto?: string
  state: ServiceCheckItem['state']
  ms?: number
  detail?: string
}

/** Two-phase view: the same sub-check as seen before and after applying. */
export interface CompareRow {
  id: string
  label: string
  proto?: string
  before?: CheckRow
  after?: CheckRow
}

export const CHECK_STATE: Record<ServiceCheckItem['state'], { tone: Tone; label: string; dashed?: boolean }> = {
  ok: { tone: 'ok', label: 'Проходит' },
  fail: { tone: 'bad', label: 'Не проходит' },
  untested: { tone: 'muted', label: 'Не проверено', dashed: true },
  interrupted: { tone: 'warn', label: 'Прервано', dashed: true },
  unavailable: { tone: 'muted', label: 'Недоступно', dashed: true },
}

function fromResult(task: Task): CheckRow[] | null {
  const result = task.result as ZapretCheckResult | undefined
  if (!result || !Array.isArray(result.items) || result.items.length === 0) return null
  return result.items.map((i) => ({ id: i.id, label: i.label, proto: i.proto, state: i.state, ms: i.ms, detail: i.detail }))
}

function fromSteps(task: Task): CheckRow[] {
  const cut = task.state === 'cancelled' || task.state === 'error'
  return task.steps.map((s, i) => ({
    id: `step-${i}`,
    label: s.label,
    state:
      s.state === 'done'
        ? 'ok'
        : s.state === 'error'
          ? 'fail'
          : s.state === 'skipped'
            ? 'untested'
            : cut
              ? 'interrupted'
              : 'untested',
    detail: s.detail,
  }))
}

/** Rows of one run check; empty while no check has run. */
export function checkRows(task: Task | undefined): CheckRow[] {
  if (!task) return []
  return fromResult(task) ?? fromSteps(task)
}

/** Sub-checks of both phases, ordered by the first list that has them. */
export function compareRows(before: Task | undefined, after: Task | undefined): CompareRow[] {
  const b = checkRows(before)
  const a = checkRows(after)
  const order = (a.length ? a : b).map((r) => r.id)
  const ids = [...order, ...b.map((r) => r.id).filter((id) => !order.includes(id))]
  return ids.map((id) => {
    const bi = b.find((r) => r.id === id)
    const ai = a.find((r) => r.id === id)
    const shown = ai ?? bi
    return { id, label: shown?.label ?? id, proto: shown?.proto, before: bi, after: ai }
  })
}

export const isSettled = (t: Task | undefined) => !!t && t.state !== 'running' && t.state !== 'pending'
