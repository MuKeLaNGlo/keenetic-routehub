const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto', style: 'short' })

export function timeAgo(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso == null) return '—'
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  const s = Math.round((t - now) / 1000)
  const a = Math.abs(s)
  if (a < 10) return 'только что'
  if (a < 60) return rtf.format(s, 'second')
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
}

export function clock(iso: string | number): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(iso: string | number): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`
  const u = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

/** bytes/s → "12.4 Мбит/с" */
export function bitrate(bps: number): string {
  const bits = bps * 8
  if (bits < 1e6) return `${(bits / 1e3).toFixed(0)} Кбит/с`
  if (bits < 1e9) return `${(bits / 1e6).toFixed(bits < 1e7 ? 1 : 0)} Мбит/с`
  return `${(bits / 1e9).toFixed(2)} Гбит/с`
}

export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} с`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return s ? `${m} мин ${s} с` : `${m} мин`
  const h = Math.floor(m / 60)
  return `${h} ч ${m % 60} мин`
}

/** Russian plural: plural(5, ['правило','правила','правил']) */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

export const count = (n: number, forms: [string, string, string]) => `${n} ${plural(n, forms)}`
