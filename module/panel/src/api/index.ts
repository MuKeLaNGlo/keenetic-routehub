import type { RouteHubApi } from './contract'
import { isDemo } from './mode'
import { HttpRouteHub } from './http'
import { MockRouteHub } from './mock'

export const mock = isDemo ? new MockRouteHub() : null
export const api: RouteHubApi = mock ?? new HttpRouteHub()

export type * from './contract'
