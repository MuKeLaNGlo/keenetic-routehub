/**
 * The sub-checks of a DNS check, in the shape the screen renders.
 *
 * The contract says a check task's `result` is a `DnsCheckResult`. The mock
 * implementation reports the same sub-checks as task steps only, so both are
 * read here and every step state is mapped explicitly — a skipped or unfinished
 * step never reads as a passing one.
 */
import type { DnsCheckResult, ServiceCheckItem, Task } from '@/api/contract'
import type { Tone } from '@/components/rh/status'

export interface CheckRow {
  id: string
  label: string
  state: ServiceCheckItem['state']
  ms?: number
  detail?: string
}

export const CHECK_STATE: Record<ServiceCheckItem['state'], { tone: Tone; label: string; dashed?: boolean }> = {
  ok: { tone: 'ok', label: 'Проходит' },
  fail: { tone: 'bad', label: 'Не проходит' },
  untested: { tone: 'muted', label: 'Не проверено', dashed: true },
  interrupted: { tone: 'warn', label: 'Прервано', dashed: true },
  unavailable: { tone: 'muted', label: 'Недоступно', dashed: true },
}

function fromResult(task: Task): CheckRow[] | null {
  const result = task.result as DnsCheckResult | undefined
  if (!result || !Array.isArray(result.items) || result.items.length === 0) return null
  return result.items.map((i) => ({ id: i.id, label: i.label, state: i.state, ms: i.ms, detail: i.detail }))
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

export function checkRows(task: Task | undefined): CheckRow[] {
  if (!task) return []
  return fromResult(task) ?? fromSteps(task)
}

export const isSettled = (t: Task | undefined) => !!t && t.state !== 'running' && t.state !== 'pending'

/** Overall outcome of one run: what passed, what did not, what was not tested. */
export function tally(rows: CheckRow[]) {
  return {
    total: rows.length,
    ok: rows.filter((r) => r.state === 'ok').length,
    fail: rows.filter((r) => r.state === 'fail').length,
    untested: rows.filter((r) => r.state === 'untested' || r.state === 'interrupted' || r.state === 'unavailable').length,
  }
}
