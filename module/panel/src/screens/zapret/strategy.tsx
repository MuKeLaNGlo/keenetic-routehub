import type { ZapretService, ZapretStrategy } from '@/api/contract'
import { SimpleSelect, Mono } from '@/components/rh/controls'
import { StatusBadge } from '@/components/rh/status'
import { CapabilityNote } from '@/components/rh/coverage'
import { KV } from '@/components/rh/layout'
import { cn } from '@/lib/utils'
import { PROTO_LABEL, READINESS, ZAPRET_META } from './meta'

/** Strategy picker plus what the chosen strategy depends on. */
export function StrategyBlock({
  service,
  strategy,
  strategies,
  disabled,
  onChange,
  compact = false,
  showPicker = true,
}: {
  service: ZapretService
  strategy: ZapretStrategy | undefined
  strategies: ZapretStrategy[]
  disabled: boolean
  onChange: (id: string) => void
  compact?: boolean
  showPicker?: boolean
}) {
  const readiness = strategy ? READINESS[strategy.readiness] : null
  const options = strategies
    .filter((s) => s.service === service.id)
    .map((s) => ({
      value: s.id,
      label: s.name,
      hint: `${s.protos.map((p) => PROTO_LABEL[p]).join('+')} · ${READINESS[s.readiness].label.toLowerCase()}`,
      disabled: s.readiness === 'needs-kernel-module',
    }))

  return (
    <div className={cn('space-y-2.5 py-3', compact ? 'px-3' : 'px-4')}>
      {!compact && <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">Стратегия обработки</span>
          {readiness && (
            <StatusBadge tone={readiness.tone} dashed={strategy?.readiness !== 'ready'}>
              {readiness.label}
            </StatusBadge>
          )}
        </div>
        {strategy && <span className="text-[12px] text-muted-foreground">{readiness?.hint}</span>}
      </div>}

      {showPicker && <SimpleSelect
        className="w-full"
        value={service.strategyId}
        options={options}
        disabled={disabled}
        onChange={onChange}
        placeholder="Выберите стратегию"
        aria-label={compact ? `Стратегия ${ZAPRET_META[service.id].name}` : undefined}
      />}

      {!strategy && (
        <p className="text-[12px] text-bad">Стратегия не найдена в каталоге — сервис не будет обработан, пока не выбрана существующая.</p>
      )}

      {strategy && (
        <>
          {compact ? (
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
              <span>{strategy.protos.map((proto) => PROTO_LABEL[proto]).join(' / ')}</span>
              <span>{strategy.queueOwner}</span>
            </p>
          ) : <KV
            cols={2}
            items={[
              ['Зависимость от ядра', <Mono>{strategy.kernelDependency}</Mono>],
              ['Владелец очереди', <Mono>{strategy.queueOwner}</Mono>],
              [
                'Протоколы',
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {strategy.protos.map((p) => (
                    <span key={p} className="rounded bg-muted px-1.5 py-0.5 text-[11.5px] font-medium">
                      {PROTO_LABEL[p]}
                    </span>
                  ))}
                </span>,
              ],
            ]}
          />}
          {compact && strategy.readiness === 'experimental' && <p className="text-[12px] text-warn">{readiness?.hint}</p>}
          {!strategy.protos.includes('udp') && (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {compact
                ? (service.id === 'youtube' ? 'Эта стратегия работает с TCP. QUIC остаётся без обработки.' : 'Эта стратегия работает с TCP. Голосовой UDP остаётся без обработки.')
                : 'Только TCP: QUIC и голос этой стратегией не обрабатываются — в проверке они останутся «не проверено».'}
            </p>
          )}
          <CapabilityNote
            availability={{
              available: strategy.readiness !== 'needs-kernel-module',
              reason: strategy.kernelDependency,
              remedy: 'Выберите другую стратегию для этого сервиса.',
            }}
          >
            Стратегия не запустится на этой прошивке
          </CapabilityNote>
        </>
      )}

      {!compact && <p className="text-[12px] leading-relaxed text-muted-foreground">
        Стратегия применяется только к этому сервису. Автоматического наложения Zapret на туннель и его служебный DNS нет — такое правило пришлось бы отлаживать отдельно.
      </p>}
    </div>
  )
}
