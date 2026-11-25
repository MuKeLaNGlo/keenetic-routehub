import type { SupportReport } from '@/api/contract'
import { count, dateTime } from '@/lib/format'

const MASK = '••••'

/**
 * The downloadable report is built from exactly what the preview shows:
 * redacted values stay redacted in the file. There is no second, unredacted
 * representation on the client.
 */
export function supportReportText(r: SupportReport): string {
  const lines: string[] = []
  lines.push('RouteHub — отчёт для поддержки')
  lines.push(`Создан: ${dateTime(Date.now())}`)
  lines.push(`Размер: ${r.sizeKb} КБ · скрыто ${count(r.redactedCount, ['поле', 'поля', 'полей'])}`)
  lines.push('Секреты профилей, подписок и персональные данные замаскированы символом «•».')
  lines.push('')
  for (const s of r.sections) {
    lines.push(`## ${s.title}`)
    for (const l of s.lines) lines.push(`${l.key}: ${l.redacted ? maskLine(l.value) : l.value}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Belt and braces: no long opaque token survives in a line marked redacted. */
function maskLine(value: string): string {
  return value.replace(/[A-Za-z0-9+/_=-]{20,}/g, MASK)
}

export function supportReportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `routehub-support-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`
}

export function downloadText(fileName: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
