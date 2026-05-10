import type { D1DatabaseLike } from '../env'
import { badRequest } from '../http/errors'

const settingsKey = 'cloudflare'
const usageCacheKey = 'cloudflare_usage_cache'

export type WorkersPlan = 'free' | 'paid'
export type D1Plan = 'free' | 'paid'

type LegacyCloudflareSettings = {
  pagesProjectName?: string
  pagesPlan?: 'free' | 'pro' | 'business' | 'enterprise'
}

export type CloudflareSettings = {
  accountId: string
  apiToken: string
  workerScriptName: string
  d1DatabaseId: string
  workersPlan: WorkersPlan
  d1Plan: D1Plan
}

export type PublicCloudflareSettings = Omit<CloudflareSettings, 'apiToken'> & {
  hasApiToken: boolean
}

export type CloudflareUsage = {
  fetchedAt: string
  settings: PublicCloudflareSettings
  workers: {
    scriptName: string
    requests: number
    workerRequests: number
    pagesFunctionsRequests: number
    scriptRequests: number
    requestLimit: number | null
    requestPercent: number | null
    errors: number
    subrequests: number
    cpuTimeP99Ms: number | null
    windowStart: string
    windowEnd: string
  }
  d1: {
    databaseId: string
    databaseName: string | null
    rowsRead: number
    rowsWritten: number
    readQueries: number
    writeQueries: number
    storageBytes: number | null
    storageLimitBytes: number | null
    storagePercent: number | null
    rowsReadLimit: number | null
    rowsReadPercent: number | null
    rowsWrittenLimit: number | null
    rowsWrittenPercent: number | null
    queryLatencyP90Ms: number | null
    windowStart: string
    windowEnd: string
  }
}

export async function readCloudflareSettings(db: D1DatabaseLike): Promise<CloudflareSettings | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(settingsKey)
    .first<{ value: string }>()
  if (!row) return null

  try {
    const parsed = JSON.parse(row.value) as Partial<CloudflareSettings> & LegacyCloudflareSettings
    return normalizeSettings(parsed, parsed.apiToken ?? '')
  } catch {
    return null
  }
}

export async function saveCloudflareSettings(
  db: D1DatabaseLike,
  payload: unknown,
): Promise<PublicCloudflareSettings> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('Cloudflare settings must be an object')
  }

  const existing = await readCloudflareSettings(db)
  const incoming = payload as Partial<CloudflareSettings> & LegacyCloudflareSettings
  const apiToken = incoming.apiToken?.trim() || existing?.apiToken || ''
  const hasLegacyPagesPlan = incoming.pagesPlan !== undefined
  const next = normalizeSettings(
    {
      accountId: incoming.accountId,
      workerScriptName: incoming.workerScriptName ?? incoming.pagesProjectName,
      d1DatabaseId: incoming.d1DatabaseId,
      workersPlan: incoming.workersPlan ?? (hasLegacyPagesPlan ? undefined : existing?.workersPlan),
      pagesPlan: incoming.pagesPlan,
      d1Plan: incoming.d1Plan ?? existing?.d1Plan,
    },
    apiToken,
  )

  if (!next.accountId || !next.d1DatabaseId) {
    throw badRequest('Account ID and D1 database ID are required')
  }

  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(settingsKey, JSON.stringify(next), new Date().toISOString())
    .run()
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(usageCacheKey).run()

  return publicSettings(next)
}

export async function readCachedCloudflareUsage(db: D1DatabaseLike): Promise<CloudflareUsage | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(usageCacheKey)
    .first<{ value: string }>()
  if (!row) return null

  try {
    const parsed = JSON.parse(row.value) as CloudflareUsage
    return typeof parsed.fetchedAt === 'string' && parsed.workers ? parsed : null
  } catch {
    return null
  }
}

export async function getCloudflareUsage(db: D1DatabaseLike): Promise<CloudflareUsage> {
  const settings = await readCloudflareSettings(db)
  if (!settings || !settings.apiToken || !settings.accountId || !settings.d1DatabaseId) {
    throw badRequest('Cloudflare settings are incomplete')
  }

  const accountId = encodeURIComponent(settings.accountId)
  const d1DatabaseId = encodeURIComponent(settings.d1DatabaseId)
  const [database, workersAnalytics, d1Analytics] = await Promise.all([
    cloudflareRequest<Record<string, unknown>>(settings, `/accounts/${accountId}/d1/database/${d1DatabaseId}`).catch(() => null),
    fetchWorkersRequestsAnalytics(settings),
    fetchD1Analytics(settings),
  ])

  const workersPlan = workersPlanLimits(settings.workersPlan)
  const d1Plan = d1PlanLimits(settings.d1Plan)
  const storageBytes = numberField(database, 'file_size') ?? d1Analytics.storageBytes
  const storageLimitBytes = d1Plan.databaseSizeBytes

  const usage: CloudflareUsage = {
    fetchedAt: new Date().toISOString(),
    settings: publicSettings(settings),
    workers: {
      scriptName: settings.workerScriptName || 'Account',
      requests: workersAnalytics.totalRequests,
      workerRequests: workersAnalytics.workerRequests,
      pagesFunctionsRequests: workersAnalytics.pagesFunctionsRequests,
      scriptRequests: workersAnalytics.scriptRequests,
      requestLimit: workersPlan.requests,
      requestPercent: ratioPercent(workersAnalytics.totalRequests, workersPlan.requests),
      errors: workersAnalytics.errors,
      subrequests: workersAnalytics.subrequests,
      cpuTimeP99Ms: workersAnalytics.cpuTimeP99Ms,
      windowStart: workersAnalytics.windowStart,
      windowEnd: workersAnalytics.windowEnd,
    },
    d1: {
      databaseId: settings.d1DatabaseId,
      databaseName: stringField(database, 'name'),
      rowsRead: d1Analytics.rowsRead,
      rowsWritten: d1Analytics.rowsWritten,
      readQueries: d1Analytics.readQueries,
      writeQueries: d1Analytics.writeQueries,
      storageBytes,
      storageLimitBytes,
      storagePercent: storageBytes === null ? null : ratioPercent(storageBytes, storageLimitBytes),
      rowsReadLimit: d1Plan.rowsRead,
      rowsReadPercent: ratioPercent(d1Analytics.rowsRead, d1Plan.rowsRead),
      rowsWrittenLimit: d1Plan.rowsWritten,
      rowsWrittenPercent: ratioPercent(d1Analytics.rowsWritten, d1Plan.rowsWritten),
      queryLatencyP90Ms: d1Analytics.queryLatencyP90Ms,
      windowStart: d1Analytics.windowStart,
      windowEnd: d1Analytics.windowEnd,
    },
  }

  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(usageCacheKey, JSON.stringify(usage), usage.fetchedAt)
    .run()

  return usage
}

async function fetchWorkersRequestsAnalytics(settings: CloudflareSettings) {
  const end = new Date()
  const start =
    settings.workersPlan === 'free'
      ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  const variables = {
    accountTag: settings.accountId,
    scriptName: settings.workerScriptName || '__edgegist_no_worker_name__',
    datetimeStart: start.toISOString(),
    datetimeEnd: end.toISOString(),
  }
  const query = `
    query EdgeGistWorkersRequestsUsage(
      $accountTag: string,
      $scriptName: string,
      $datetimeStart: string,
      $datetimeEnd: string
    ) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          accountWorkers: workersInvocationsAdaptive(
            limit: 10000
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP99
            }
          }
          scriptWorkers: workersInvocationsAdaptive(
            limit: 10000
            filter: {
              scriptName: $scriptName,
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
          ) {
            sum {
              requests
              errors
              subrequests
            }
          }
          pagesFunctionsInvocationsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
          ) {
            sum {
              requests
              errors
              subrequests
            }
          }
        }
      }
    }
  `

  const payload = await cloudflareGraphqlRequest(settings, query, variables)
  const account = payload?.data?.viewer?.accounts?.[0]
  const accountWorkers = Array.isArray(account?.accountWorkers)
    ? account.accountWorkers
    : []
  const scriptWorkers = Array.isArray(account?.scriptWorkers)
    ? account.scriptWorkers
    : []
  const pagesFunctions = Array.isArray(account?.pagesFunctionsInvocationsAdaptiveGroups)
    ? account.pagesFunctionsInvocationsAdaptiveGroups
    : []
  const workerRequests = sumField(accountWorkers, 'sum', 'requests')
  const pagesFunctionsRequests = sumField(pagesFunctions, 'sum', 'requests')

  return {
    totalRequests: workerRequests + pagesFunctionsRequests,
    workerRequests,
    pagesFunctionsRequests,
    scriptRequests: sumField(scriptWorkers, 'sum', 'requests'),
    errors: sumField(accountWorkers, 'sum', 'errors') + sumField(pagesFunctions, 'sum', 'errors'),
    subrequests: sumField(accountWorkers, 'sum', 'subrequests') + sumField(pagesFunctions, 'sum', 'subrequests'),
    cpuTimeP99Ms: maxField(accountWorkers, 'quantiles', 'cpuTimeP99'),
    windowStart: variables.datetimeStart,
    windowEnd: variables.datetimeEnd,
  }
}

async function fetchD1Analytics(settings: CloudflareSettings) {
  const end = new Date()
  const start =
    settings.d1Plan === 'free'
      ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  const variables = {
    accountTag: settings.accountId,
    databaseId: settings.d1DatabaseId,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
  const query = `
    query EdgeGistD1Usage($accountTag: string!, $start: Date, $end: Date, $databaseId: string) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(
            limit: 10000
            filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }
          ) {
            sum {
              readQueries
              writeQueries
              rowsRead
              rowsWritten
              queryBatchResponseBytes
            }
            quantiles {
              queryBatchTimeMsP90
            }
          }
          d1StorageAdaptiveGroups(
            limit: 10000
            filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }
          ) {
            max {
              databaseSizeBytes
            }
          }
        }
      }
    }
  `

  const payload = await cloudflareGraphqlRequest(settings, query, variables)
  const account = payload?.data?.viewer?.accounts?.[0]
  const analytics = Array.isArray(account?.d1AnalyticsAdaptiveGroups)
    ? account.d1AnalyticsAdaptiveGroups
    : []
  const storage = Array.isArray(account?.d1StorageAdaptiveGroups)
    ? account.d1StorageAdaptiveGroups
    : []

  return {
    rowsRead: sumField(analytics, 'sum', 'rowsRead'),
    rowsWritten: sumField(analytics, 'sum', 'rowsWritten'),
    readQueries: sumField(analytics, 'sum', 'readQueries'),
    writeQueries: sumField(analytics, 'sum', 'writeQueries'),
    queryLatencyP90Ms: maxField(analytics, 'quantiles', 'queryBatchTimeMsP90'),
    storageBytes: maxField(storage, 'max', 'databaseSizeBytes'),
    windowStart: variables.start,
    windowEnd: variables.end,
  }
}


async function cloudflareRequest<T>(settings: CloudflareSettings, path: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: {
      authorization: `Bearer ${settings.apiToken}`,
      accept: 'application/json',
    },
  })
  const payload = await response.json().catch(() => null) as CloudflareApiResponse<T> | null
  if (!response.ok || !payload?.success) {
    throw badRequest(cloudflareErrorMessage(payload, response.status))
  }
  return payload.result
}

async function cloudflareGraphqlRequest(
  settings: CloudflareSettings,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await response.json().catch(() => null) as any
  if (!response.ok || payload?.errors?.length) {
    throw badRequest(payload?.errors?.[0]?.message ?? `Cloudflare GraphQL request failed with ${response.status}`)
  }
  return payload
}

type CloudflareApiResponse<T> = {
  success: boolean
  result: T
  errors?: Array<{ message?: string }>
}

function normalizeSettings(
  payload: Partial<CloudflareSettings> & LegacyCloudflareSettings,
  apiToken: string,
): CloudflareSettings {
  const legacyWorkerPlan = payload.pagesPlan === 'free'
    ? 'free'
    : payload.pagesPlan === 'pro' || payload.pagesPlan === 'business' || payload.pagesPlan === 'enterprise'
      ? 'paid'
      : undefined
  return {
    accountId: payload.accountId?.trim() ?? '',
    apiToken: apiToken.trim(),
    workerScriptName: (payload.workerScriptName ?? payload.pagesProjectName)?.trim() ?? '',
    d1DatabaseId: payload.d1DatabaseId?.trim() ?? '',
    workersPlan: isWorkersPlan(payload.workersPlan) ? payload.workersPlan : legacyWorkerPlan ?? 'free',
    d1Plan: isD1Plan(payload.d1Plan) ? payload.d1Plan : 'free',
  }
}

function publicSettings(settings: CloudflareSettings): PublicCloudflareSettings {
  return {
    accountId: settings.accountId,
    hasApiToken: Boolean(settings.apiToken),
    workerScriptName: settings.workerScriptName,
    d1DatabaseId: settings.d1DatabaseId,
    workersPlan: settings.workersPlan,
    d1Plan: settings.d1Plan,
  }
}

function workersPlanLimits(plan: WorkersPlan) {
  return {
    requests: plan === 'paid' ? 10_000_000 : 100_000,
  }
}

function isWorkersPlan(value: unknown): value is WorkersPlan {
  return value === 'free' || value === 'paid'
}

function d1PlanLimits(plan: D1Plan) {
  if (plan === 'paid') {
    return {
      rowsRead: 25_000_000_000,
      rowsWritten: 50_000_000,
      databaseSizeBytes: 10 * 1024 * 1024 * 1024,
    }
  }

  return {
    rowsRead: 5_000_000,
    rowsWritten: 100_000,
    databaseSizeBytes: 500 * 1024 * 1024,
  }
}

function isD1Plan(value: unknown): value is D1Plan {
  return value === 'free' || value === 'paid'
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' ? candidate : null
}

function objectField(value: unknown, field: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const candidate = (value as Record<string, unknown>)[field]
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null
}

function sumField(items: unknown[], group: string, field: string): number {
  return items.reduce<number>((total, item) => total + (numberField(objectField(item, group), field) ?? 0), 0)
}

function maxField(items: unknown[], group: string, field: string): number | null {
  let max: number | null = null
  for (const item of items) {
    const value = numberField(objectField(item, group), field)
    if (value === null) continue
    max = max === null ? value : Math.max(max, value)
  }
  return max
}

function numberField(value: unknown, field: string): number | null {
  if (!value || typeof value !== 'object') return null
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null
}

function ratioPercent(value: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null
  return Math.min(100, Math.round((value / limit) * 1000) / 10)
}

function cloudflareErrorMessage(payload: CloudflareApiResponse<unknown> | null, status: number): string {
  const message = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ')
  return message || `Cloudflare request failed with ${status}`
}
