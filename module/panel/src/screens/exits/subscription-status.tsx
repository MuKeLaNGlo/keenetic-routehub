import { CalendarClock } from 'lucide-react'
import type { SubscriptionPreview, SubscriptionStatus } from '@/api/contract'
import { TimeAgo } from '@/components/rh/controls'
import { Notice } from '@/components/rh/layout'
import { StatusBadge } from '@/components/rh/status'

export function SubscriptionPreviewTime({ preview }: { preview: SubscriptionPreview }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
      <CalendarClock className="size-3.5" aria-hidden="true" />
      <span>{preview.ok ? 'Предпросмотр' : 'Попытка предпросмотра'} <TimeAgo at={preview.fetchedAt} /></span>
      <StatusBadge tone={preview.ok ? 'ok' : 'bad'}>{preview.ok ? 'ответ получен' : 'ошибка'}</StatusBadge>
    </div>
  )
}

export function SubscriptionPreviewError({ error, status }: {
  error?: string
  status?: SubscriptionStatus
}) {
  const latest = status?.lastSuccess
  return (
    <div role="alert">
      <Notice tone="bad" title="Не удалось загрузить предпросмотр">
        <p className="[overflow-wrap:anywhere]">{error ?? 'Панель не получила подходящий список профилей.'}</p>
        <p className="mt-1">
          Каталог сохранён. {latest && <>Последняя успешная синхронизация <TimeAgo at={latest.at} />.</>}
        </p>
      </Notice>
    </div>
  )
}

export function SubscriptionAttemptError({ attempt }: { attempt: NonNullable<SubscriptionStatus['lastAttempt']> }) {
  return (
    <p className="text-[12px] text-warn [overflow-wrap:anywhere]">
      Предыдущая попытка <TimeAgo at={attempt.at} />. {attempt.reason ?? 'Не удалось загрузить подписку.'}
      {attempt.code && <span className="text-muted-foreground"> ({attempt.code})</span>}
    </p>
  )
}
