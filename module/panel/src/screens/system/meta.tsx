import type { ReactNode } from 'react'
import { BadgeCheck, CheckCircle2, CircleDashed, RotateCcw, TimerOff, XCircle } from 'lucide-react'
import { isDemo } from '@/api/mode'
import type { Revision, UpdateInfo } from '@/api/contract'
import type { Tone } from '@/components/rh/status'

export const REVISION_RESULT: Record<Revision['result'], { tone: Tone; label: string; icon: ReactNode; consequence?: string }> = {
  ok: { tone: 'ok', label: 'Применено', icon: <CheckCircle2 /> },
  'rolled-back': {
    tone: 'warn',
    label: 'Откат',
    icon: <RotateCcw />,
    consequence: 'Применение не удержалось: сервер восстановил предыдущую рабочую конфигурацию и проверил её.',
  },
  failed: { tone: 'bad', label: 'Ошибка', icon: <XCircle />, consequence: 'Применение остановилось. Действует предыдущая удачная ревизия.' },
  'trial-expired': {
    tone: 'warn',
    label: 'Пробное истекло',
    icon: <TimerOff />,
    consequence: 'Подтверждение не получено вовремя — сервер вернул прежнюю конфигурацию независимо от браузера.',
  },
  'trial-confirmed': { tone: 'ok', label: 'Пробное подтверждено', icon: <BadgeCheck /> },
  'trial-cancelled': {
    tone: 'muted',
    label: 'Пробное отменено',
    icon: <RotateCcw />,
    consequence: 'Вы вернули прежнюю конфигурацию, не подтверждая пробу. Сбоя не было.',
  },
}

export const UPDATE_STATE: Record<UpdateInfo['state'], { tone: Tone; label: string; dashed?: boolean }> = {
  'up-to-date': { tone: 'ok', label: 'Актуально' },
  available: { tone: 'info', label: 'Доступно обновление' },
  checking: { tone: 'info', label: 'Проверяется' },
  blocked: { tone: 'bad', label: 'Заблокировано' },
  updating: { tone: 'info', label: 'Обновляется' },
  failed: { tone: 'bad', label: 'Ошибка' },
  'rolled-back': { tone: 'warn', label: 'Возвращена прежняя версия' },
}

export const SIGNATURE: Record<UpdateInfo['signature'], { tone: Tone; label: string; dashed?: boolean }> = {
  verified: { tone: 'ok', label: 'подпись проверена' },
  unverified: { tone: 'bad', label: 'подпись не проверена' },
  unknown: { tone: 'muted', label: 'подпись неизвестна', dashed: true },
}

export const requiresReleaseChecksum = (update: UpdateInfo) => !isDemo && update.component === 'xray'

function releaseChecksum(update: UpdateInfo) {
  const checksum = update.checksum
  return checksum?.algorithm === 'sha256' && checksum.source === 'github-releases' ? checksum.state : undefined
}

export function updateVerification(update: UpdateInfo): { tone: Tone; label: string } {
  if (!requiresReleaseChecksum(update)) return SIGNATURE[update.signature]
  switch (releaseChecksum(update)) {
    case 'ok': return { tone: 'ok', label: 'SHA-256 из GitHub Releases · подтверждена' }
    case 'fail': return { tone: 'bad', label: 'SHA-256 из GitHub Releases · ошибка проверки' }
    default: return { tone: 'muted', label: 'SHA-256 из GitHub Releases · ещё не проверена' }
  }
}

export const CHANNEL: Record<UpdateInfo['channel'], string> = {
  stable: 'stable · стабильный',
  beta: 'beta · тестовый',
}

export const CHECK_STATE = {
  ok: { tone: 'ok' as Tone, label: 'пройдено', icon: <CheckCircle2 /> },
  fail: { tone: 'bad' as Tone, label: 'не пройдено', icon: <XCircle /> },
  untested: { tone: 'muted' as Tone, label: 'не проверялось', icon: <CircleDashed /> },
}

/**
 * Why "Обновить" cannot run. The installed release checker reports the
 * candidate and its integrity evidence separately from demonstration data.
 */
export function updateBlockReason(u: UpdateInfo): string | null {
  if (u.state === 'updating') return 'Обновление уже выполняется'
  if (u.state === 'checking') return 'Идёт проверка совместимости — дождитесь результата'
  if (u.state === 'up-to-date') return requiresReleaseChecksum(u) && !u.checks.length
    ? 'Сначала проверьте доступную версию Xray'
    : 'Установлена последняя проверенная версия канала'
  if (!u.target) return 'Целевая версия не определена — проверьте канал обновления'
  if (u.state === 'blocked') {
    const fail = u.checks.find((c) => c.state === 'fail')
    return fail ? `Проверка не пройдена: ${fail.label}` : 'Проверка совместимости не пройдена'
  }
  if (requiresReleaseChecksum(u)) {
    if (releaseChecksum(u) !== 'ok') return 'Сверьте SHA-256 официального пакета Xray перед установкой'
  } else {
    if (u.signature !== 'verified') return 'Подпись кандидата не подтверждена'
    if (!u.checks.length) return 'Сначала выполните проверку совместимости'
  }
  const fail = u.checks.find((c) => c.state === 'fail')
  if (fail) return `Проверка не пройдена: ${fail.label}`
  const untested = u.checks.find((c) => c.state === 'untested')
  if (untested) return `Проверка не завершена: ${untested.label}`
  if (u.state !== 'available') return 'Нет готового кандидата для обновления'
  return null
}

/** What to do about a blocked candidate, derived from the failing check. */
export function updateRemedy(u: UpdateInfo): string | null {
  if (!requiresReleaseChecksum(u) && u.signature !== 'verified') return 'Дождитесь, пока канал опубликует артефакт с проверяемой подписью, или смените канал на стабильный.'
  const fail = u.checks.find((c) => c.state === 'fail')
  if (!fail) return u.checks.length ? null : 'Запустите проверку доступной версии.'
  const label = fail.label.toLowerCase()
  if (label.includes('место')) return 'Освободите место в /opt (кандидат и резервная копия) и повторите проверку.'
  if (label.includes('совместим')) return 'Обновите KeeneticOS или выберите версию ядра, совместимую с этой прошивкой и архитектурой.'
  if (requiresReleaseChecksum(u) && label.includes('sha-256')) return 'Повторно проверьте официальный пакет Xray.'
  if (label.includes('подпись')) return 'Проверьте доверенный канал: артефакт без подтверждённой подписи не устанавливается.'
  return null
}
