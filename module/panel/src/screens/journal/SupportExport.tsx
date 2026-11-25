import { useState } from 'react'
import { toast } from 'sonner'
import { Download, FileText, Lock, ShieldCheck } from 'lucide-react'
import type { SupportReport } from '@/api/contract'
import { api } from '@/api'
import { Notice, Section, KV } from '@/components/rh/layout'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/rh/sheet'
import { Mono } from '@/components/rh/controls'
import { count } from '@/lib/format'
import { downloadText, supportReportFileName, supportReportText } from './reportFile'

export function SupportExport({ compact = false }: { compact?: boolean }) {
  const [report, setReport] = useState<SupportReport | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const build = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.buildSupportReport()
      setReport(r)
      setOpen(true)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error('Отчёт не собран', { description: msg })
    } finally {
      setBusy(false)
    }
  }

  const reportButton = (
    <Button
      variant={compact ? 'outline' : 'default'}
      size={compact ? 'sm' : 'default'}
      onClick={() => void build()}
      disabled={busy}
    >
      <FileText /> {busy ? 'Собираем отчёт…' : 'Собрать отчёт'}
    </Button>
  )

  return (
    <>
      {compact ? reportButton : (
        <Section
          title="Диагностика для поддержки"
          description="Отчёт собирает версии, возможности, состояния, ошибки и измерения. Секреты и персональные данные в нём замаскированы — вы видите ровно то, что уйдёт в файл."
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {reportButton}
              <span className="text-[12px] text-muted-foreground">Сначала предпросмотр, файл — только по кнопке «Скачать».</span>
            </div>

            {error && (
              <Notice tone="bad" title="Отчёт не собран">
                {error}. На роутере ничего не меняется; сбор можно повторить в любой момент.
              </Notice>
            )}

            <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Полная копия конфигурации с секретами — отдельная защищённая операция на самом роутере. Здесь она не выполняется, и в этот отчёт секреты не попадают.
            </p>
          </div>
        </Section>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Отчёт для поддержки"
        description="Предпросмотр. В файл попадёт только перечисленное ниже, в том же замаскированном виде."
        size="lg"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">
              {report ? `Файл .txt · ${report.sizeKb} КБ · скрыто ${count(report.redactedCount, ['поле', 'поля', 'полей'])}` : null}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Закрыть
              </Button>
              <Button
                onClick={() => {
                  if (!report) return
                  downloadText(supportReportFileName(), supportReportText(report))
                  toast.success('Файл отчёта сохранён')
                }}
              >
                <Download /> Скачать
              </Button>
            </div>
          </div>
        }
      >
        {report && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12px] text-muted-foreground ring-1 ring-border ring-inset">
                <Lock className="size-3" /> скрыто {count(report.redactedCount, ['поле', 'поля', 'полей'])}
              </span>
              <span className="text-[12px] text-muted-foreground">Размер файла: {report.sizeKb} КБ</span>
            </div>

            {report.sections.map((s) => (
              <div key={s.title} className="space-y-2">
                <h3 className="text-[13px] font-semibold">{s.title}</h3>
                <KV
                  items={s.lines.map((l) => [
                    l.key,
                    l.redacted ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Lock className="size-3 shrink-0 text-muted-foreground" />
                        <Mono className="text-muted-foreground">{l.value}</Mono>
                        <span className="rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground">скрыто</span>
                      </span>
                    ) : (
                      <Mono>{l.value}</Mono>
                    ),
                  ])}
                />
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}
