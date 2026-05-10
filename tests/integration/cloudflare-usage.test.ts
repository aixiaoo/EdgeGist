import { afterEach, describe, expect, test } from 'bun:test'
import { createApp } from '../../src/index'
import { createTestEnv, ownerHeaders } from '../helpers'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Cloudflare usage API', () => {
  test('fetches Workers and D1 usage from Cloudflare', async () => {
    const app = createApp()
    const env = createTestEnv()
    const requestedUrls: string[] = []
    const graphqlQueries: string[] = []

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      requestedUrls.push(url)

      const parsed = new URL(url)
      if (parsed.pathname === '/client/v4/graphql') {
        graphqlQueries.push(String(init?.body ?? ''))
        return jsonResponse({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: [],
                  d1StorageAdaptiveGroups: [],
                  accountWorkers: [
                    {
                      sum: {
                        errors: 1,
                        requests: 139,
                        subrequests: 4,
                      },
                      quantiles: {
                        cpuTimeP99: 8.5,
                      },
                    },
                  ],
                  scriptWorkers: [
                    {
                      sum: {
                        errors: 0,
                        requests: 100,
                        subrequests: 2,
                      },
                    },
                  ],
                  pagesFunctionsInvocationsAdaptiveGroups: [
                    {
                      sum: {
                        errors: 0,
                        requests: 60,
                        subrequests: 1,
                      },
                    },
                  ],
                },
              ],
            },
          },
        })
      }

      if (parsed.pathname.endsWith('/d1/database/database-id')) {
        return cloudflareResponse({
          name: 'edge-gist',
          file_size: 1024,
        })
      }

      throw new Error(`Unexpected Cloudflare request: ${url}`)
    }) as typeof fetch

    await app.request(
      '/owner/_edgegist/api/cloudflare/settings',
      {
        method: 'PUT',
        headers: ownerHeaders(),
        body: JSON.stringify({
          accountId: 'account-id',
          apiToken: 'secret-token',
          workerScriptName: 'edge-gist',
          d1DatabaseId: 'database-id',
          workersPlan: 'free',
          d1Plan: 'free',
        }),
      },
      env,
    )

    const response = await app.request('/owner/_edgegist/api/cloudflare/usage?refresh=true', { headers: ownerHeaders() }, env)
    expect(response.status).toBe(200)
    const usage = await response.json() as Record<string, unknown>
    expect(usage.fetchedAt).toBeString()
    expect((usage.workers as Record<string, unknown>).requests).toBe(199)
    expect((usage.workers as Record<string, unknown>).workerRequests).toBe(139)
    expect((usage.workers as Record<string, unknown>).pagesFunctionsRequests).toBe(60)
    expect((usage.workers as Record<string, unknown>).scriptRequests).toBe(100)
    expect((usage.workers as Record<string, unknown>).requestLimit).toBe(100_000)
    expect((usage.workers as Record<string, unknown>).requestPercent).toBe(0.2)
    expect((usage.workers as Record<string, unknown>).errors).toBe(1)
    expect((usage.workers as Record<string, unknown>).subrequests).toBe(5)
    expect(graphqlQueries.some((body) => body.includes('workersInvocationsAdaptive'))).toBe(true)
    expect(graphqlQueries.some((body) => body.includes('pagesFunctionsInvocationsAdaptiveGroups'))).toBe(true)
    expect(graphqlQueries.some((body) => body.includes('scriptName'))).toBe(true)

    requestedUrls.length = 0
    const cachedResponse = await app.request('/owner/_edgegist/api/cloudflare/usage', { headers: ownerHeaders() }, env)
    expect(cachedResponse.status).toBe(200)
    const cachedUsage = await cachedResponse.json() as Record<string, unknown>
    expect(cachedUsage.fetchedAt).toBe(usage.fetchedAt)
    expect(requestedUrls).toEqual([])
  })
})

function cloudflareResponse(result: unknown, resultInfo?: Record<string, unknown>): Response {
  return jsonResponse({
    errors: [],
    messages: [],
    result,
    result_info: resultInfo,
    success: true,
  })
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  })
}
