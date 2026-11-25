import type { ReactNode } from 'react'
import type { Capabilities } from '@/api/contract'
import { Notice } from '@/components/rh/layout'
import { useCaps } from '@/state/resource'

export function PanelFeature({ name, children }: { name: keyof NonNullable<Capabilities['features']>; children: ReactNode }) {
  const { data } = useCaps()
  const feature = data?.features?.[name]
  if (feature?.available === false) {
    return <Notice tone="info" title="Недоступно в этой версии RouteHub">{feature.reason}</Notice>
  }
  return children
}
