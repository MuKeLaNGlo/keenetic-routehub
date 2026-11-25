import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}
export const useIsMobile = () => useMediaQuery('(max-width: 767px)')

/**
 * While a surface animates out, keep showing what it showed when open.
 * Sheets are bound to URL params, which clear *before* the exit animation:
 * without this the leaving sheet flashes its "not found" fallback.
 */
function useHeldWhileClosing<T>(open: boolean, value: T): T {
  const held = useRef(value)
  if (open) held.current = value
  return open ? value : held.current
}

/**
 * Detail / editor surface. Desktop: side sheet from the right (non-blocking
 * feel, content stays visible). Mobile: bottom sheet. Enters and leaves along
 * the same edge; closes on Escape and outside click. Bind `open` to a URL
 * param so Back closes it.
 */
export function DetailSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
  headerExtra,
  fixedMobileHeight = false,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: 'md' | 'lg'
  headerExtra?: ReactNode
  fixedMobileHeight?: boolean
}) {
  const mobile = useIsMobile()
  const bodyRef = useRef<HTMLDivElement>(null)
  const shown = useHeldWhileClosing(open, { title, description, children, footer, headerExtra })
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side={mobile ? 'bottom' : 'right'}
        // Keyboard openers land on the first control; pointer / URL openers on
        // the (quiet) body, so no focus ring flashes on the first link.
        initialFocus={(type) => (type === 'keyboard' ? true : bodyRef.current)}
        className={cn(
          'gap-0 bg-background p-0 duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:opacity-100 data-starting-style:opacity-100',
          // `cn` does not merge these data-variant pairs reliably; `!` makes the
          // override explicit instead of depending on CSS source order.
          mobile
            ? cn('max-h-[92dvh] rounded-t-2xl data-[side=bottom]:data-ending-style:translate-y-full! data-[side=bottom]:data-starting-style:translate-y-full!', fixedMobileHeight && 'data-[side=bottom]:h-[92dvh]!')
            : cn(
                'data-[side=right]:w-full! data-[side=right]:data-ending-style:translate-x-full! data-[side=right]:data-starting-style:translate-x-full!',
                width === 'lg' ? 'data-[side=right]:sm:max-w-[680px]!' : 'data-[side=right]:sm:max-w-[540px]!',
              ),
        )}
      >
        {mobile && <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />}
        <div className="shrink-0 border-b px-5 pt-4 pb-3.5 pr-12">
          <SheetTitle className="text-[17px] leading-snug font-semibold">{shown.title}</SheetTitle>
          {shown.description && <SheetDescription className="mt-0.5 text-[13px]">{shown.description}</SheetDescription>}
          {shown.headerExtra && <div className="mt-2.5">{shown.headerExtra}</div>}
        </div>
        <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 outline-none">
          {shown.children}
        </div>
        {shown.footer && <div className="material-strong shrink-0 border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{shown.footer}</div>}
      </SheetContent>
    </Sheet>
  )
}

/** Centered modal for focused, blocking decisions (apply, confirm, import). */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Write operations in progress are not dismissible by outside click. */
  dismissible?: boolean
}) {
  const mobile = useIsMobile()
  const shown = useHeldWhileClosing(open, { title, description, children, footer })
  if (mobile)
    return (
      <DetailSheet open={open} onClose={dismissible ? onClose : () => {}} title={title} description={description} footer={footer}>
        {children}
      </DetailSheet>
    )
  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismissible && onClose()} disablePointerDismissal={!dismissible}>
      <DialogContent
        showCloseButton={dismissible}
        className={cn(
          'flex max-h-[min(86dvh,860px)] flex-col gap-0 overflow-hidden bg-background p-0',
          size === 'sm' && 'sm:max-w-md',
          size === 'md' && 'sm:max-w-xl',
          size === 'lg' && 'sm:max-w-3xl',
          size === 'xl' && 'sm:max-w-5xl',
        )}
      >
        <div className="shrink-0 border-b px-5 pt-4 pb-3.5 pr-12">
          <DialogTitle className="text-[17px] leading-snug font-semibold">{shown.title}</DialogTitle>
          {shown.description && <DialogDescription className="mt-1 text-[13px]">{shown.description}</DialogDescription>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{shown.children}</div>
        {shown.footer && <div className="shrink-0 border-t bg-muted/30 px-5 py-3">{shown.footer}</div>}
      </DialogContent>
    </Dialog>
  )
}
