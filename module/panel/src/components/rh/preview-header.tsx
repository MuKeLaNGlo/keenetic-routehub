import type { ReactNode } from 'react'

export function PreviewHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5">
      <h1 className="text-[1.75rem] leading-[1.15] font-[650] tracking-[-.042em] md:text-[1.9375rem]">{title}</h1>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
