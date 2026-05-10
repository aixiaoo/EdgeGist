import { describe, expect, test } from 'bun:test'
import { createApp } from '../../src/index'
import { createTestEnv, createTestGist, ownerHeaders } from '../helpers'

describe('Gist API contract', () => {
  test('creates and reads a gist with GitHub-shaped metadata', async () => {
    const app = createApp()
    const env = createTestEnv()

    const createResponse = await app.request(
      '/gists',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify({
          description: 'backup config',
          public: false,
          files: {
            'config.json': { content: '{"enabled":true}' },
            'nodes.txt': { content: 'node-a' },
          },
        }),
      },
      env,
    )

    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as Record<string, any>
    expect(created.id).toBeString()
    expect(created.html_url).toBe(`https://edgegist.test/owner/${created.id}`)
    expect(created.files['config.json'].content).toBe('{"enabled":true}')
    expect(created.files['config.json'].raw_url).toBe(`https://edgegist.test/owner/${created.id}/raw/config.json`)
    expect(created.owner.login).toBe('owner')
    expect(created.comments).toBe(0)

    const readResponse = await app.request(`/gists/${created.id}`, {}, env)
    expect(readResponse.status).toBe(200)
    const read = (await readResponse.json()) as Record<string, any>
    expect(read.files['nodes.txt'].content).toBe('node-a')
  })

  test('rejects empty filenames and content on create', async () => {
    const app = createApp()
    const env = createTestEnv()

    const emptyFilenameResponse = await app.request(
      '/gists',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            '': { content: 'not reachable later' },
          },
        }),
      },
      env,
    )

    expect(emptyFilenameResponse.status).toBe(400)
    expect((await emptyFilenameResponse.json()) as Record<string, unknown>).toMatchObject({
      message: 'Validation Failed: filename is required',
    })

    const emptyContentResponse = await app.request(
      '/gists',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'file.txt': { content: '' },
          },
        }),
      },
      env,
    )

    expect(emptyContentResponse.status).toBe(400)
    expect((await emptyContentResponse.json()) as Record<string, unknown>).toMatchObject({
      message: 'Validation Failed: file content is required',
    })
  })

  test('rejects filenames with path separators', async () => {
    const app = createApp()
    const env = createTestEnv()

    const createResponse = await app.request(
      '/gists',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'docs/file.txt': { content: 'not allowed' },
          },
        }),
      },
      env,
    )

    expect(createResponse.status).toBe(400)
    expect(await createResponse.json()).toMatchObject({
      message: 'Validation Failed: filename cannot contain /',
    })

    const gist = await createTestGist(env)
    const updateResponse = await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'config.json': { filename: 'docs/config.json', content: '{"enabled":false}' },
          },
        }),
      },
      env,
    )

    expect(updateResponse.status).toBe(400)
    expect(await updateResponse.json()).toMatchObject({
      message: 'Validation Failed: filename cannot contain /',
    })
  })

  test('allows whitespace-only filenames and content', async () => {
    const app = createApp()
    const env = createTestEnv()

    const response = await app.request(
      '/gists',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            '   ': { content: '   ' },
          },
        }),
      },
      env,
    )

    expect(response.status).toBe(201)
    const created = (await response.json()) as Record<string, any>
    expect(created.files['   '].filename).toBe('   ')
    expect(created.files['   '].content).toBe('   ')
  })

  test('serves owner status for owner token only', async () => {
    const app = createApp()
    const env = createTestEnv()

    const anonymous = await app.request('/owner/_edgegist/api/status', {}, env)
    expect(anonymous.status).toBe(401)

    const response = await app.request('/owner/_edgegist/api/status', { headers: ownerHeaders() }, env)
    expect(response.status).toBe(200)
    const status = (await response.json()) as Record<string, any>
    expect(status.ownerUsername).toBe('owner')
    expect(status.baseUrl).toBe('https://edgegist.test')
    expect(status.ownerToken).toBeUndefined()
  })

  test('serves owner login session with optional Turnstile verification', async () => {
    const app = createApp()
    const env = createTestEnv({
      EDGEGIST_TURNSTILE_SITE_KEY: 'site-key',
      EDGEGIST_TURNSTILE_SECRET_KEY: 'secret-key',
    })
    const originalFetch = globalThis.fetch
    const seenRequests: unknown[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
        seenRequests.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }) as typeof fetch

    try {
      const basicStatus = await app.request(
        'https://edgegist.test/owner/_edgegist/api/status',
        { headers: { authorization: `Basic ${btoa('owner:password')}` } },
        env,
      )
      expect(basicStatus.status).toBe(401)

      const bearerStatus = await app.request('https://edgegist.test/owner/_edgegist/api/status', { headers: ownerHeaders() }, env)
      expect(bearerStatus.status).toBe(200)

      const missingTurnstile = await app.request(
        'https://edgegist.test/owner/_edgegist/api/session',
        { method: 'POST', headers: { authorization: `Basic ${btoa('owner:password')}` } },
        env,
      )
      expect(missingTurnstile.status).toBe(401)

      const response = await app.request(
        'https://edgegist.test/owner/_edgegist/api/session',
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${btoa('owner:password')}`,
            'x-edgegist-turnstile-token': 'turnstile-token',
            'cf-connecting-ip': '203.0.113.10',
            'x-edgegist-remember-session': 'true',
          },
        },
        env,
      )

      expect(response.status).toBe(200)
      expect((await response.json() as Record<string, any>).ownerUsername).toBe('owner')
      const sessionCookie = response.headers.get('set-cookie')?.split(';')[0]
      expect(sessionCookie).toContain('edgegist_owner_session=')
      const sessionStatus = await app.request(
        'https://edgegist.test/owner/_edgegist/api/status',
        { headers: { cookie: sessionCookie ?? '' } },
        env,
      )
      expect(sessionStatus.status).toBe(200)
      expect(seenRequests).toEqual([
        {
          secret: 'secret-key',
          response: 'turnstile-token',
          remoteip: '203.0.113.10',
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('does not expose the owner route at root and serves the public frontend at the owner route', async () => {
    const app = createApp()
    const env = createTestEnv({
      EDGEGIST_TURNSTILE_SITE_KEY: 'site-key',
      EDGEGIST_TURNSTILE_SECRET_KEY: 'secret-key',
    })

    const rootResponse = await app.request('https://edgegist.test/', {}, env)
    expect(rootResponse.status).toBe(404)
    expect(rootResponse.headers.get('location')).toBeNull()
    expect(rootResponse.headers.get('content-type')).toContain('text/plain')
    expect(await rootResponse.text()).toBe('Not Found')

    const robotsResponse = await app.request('https://edgegist.test/robots.txt', {}, env)
    expect(robotsResponse.status).toBe(200)
    expect(robotsResponse.headers.get('content-type')).toContain('text/plain')
    expect(await robotsResponse.text()).toBe('User-agent: *\nDisallow: /\n')

    const response = await app.request('https://edgegist.test/owner', {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    const html = await response.text()
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('data-edgegist-boot-shell')
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive" />')
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />')
    expect(html).toContain('<link rel="manifest" href="/owner/manifest.webmanifest" />')
    expect(html).toContain('"turnstileSiteKey":"site-key"')
    expect(html).not.toContain('secret-key')

    const manifestResponse = await app.request('https://edgegist.test/owner/manifest.webmanifest', {}, env)
    expect(manifestResponse.status).toBe(200)
    expect(manifestResponse.headers.get('content-type')).toContain('application/manifest+json')
    const manifest = (await manifestResponse.json()) as Record<string, any>
    expect(manifest.start_url).toBe('/owner')
    expect(manifest.scope).toBe('/owner/')
    expect(manifest.icons.map((icon: Record<string, string>) => icon.src)).toContain('/icons/edgegist-512.png')
    expect(manifest.icons.map((icon: Record<string, string>) => icon.src)).toContain('/icons/edgegist-dark-512.png')

    const serviceWorkerResponse = await app.request('https://edgegist.test/owner/edgegist-sw', {}, env)
    expect(serviceWorkerResponse.status).toBe(200)
    expect(serviceWorkerResponse.headers.get('content-type')).toContain('application/javascript')
    expect(serviceWorkerResponse.headers.get('service-worker-allowed')).toBe('/owner/')
    expect(await serviceWorkerResponse.text()).toContain("url.pathname.startsWith('/static/')")

    expect((await app.request('https://edgegist.test/admin', {}, env)).status).toBe(404)
    expect((await app.request('https://edgegist.test/owner/_dashboard', {}, env)).status).toBe(404)
    expect((await app.request('https://edgegist.test/owner/cloudflare', {}, env)).status).toBe(200)
    expect((await app.request('https://edgegist.test/owner/example/abcdef', {}, env)).status).toBe(200)
  })

  test('skips Turnstile on local development requests even when keys are configured', async () => {
    const app = createApp()
    const env = createTestEnv({
      EDGEGIST_TURNSTILE_SITE_KEY: 'site-key',
      EDGEGIST_TURNSTILE_SECRET_KEY: 'secret-key',
    })

    const htmlResponse = await app.request('http://127.0.0.1:8787/owner', {}, env)
    expect(htmlResponse.status).toBe(200)
    expect(await htmlResponse.text()).toContain('"turnstileSiteKey":null')

    const loginResponse = await app.request(
      'http://127.0.0.1:8787/owner/_edgegist/api/session',
      { method: 'POST', headers: { authorization: `Basic ${btoa('owner:password')}` } },
      env,
    )
    expect(loginResponse.status).toBe(200)
  })

  test('decodes owner route parameters before comparing configured owner login', async () => {
    const app = createApp()
    const env = createTestEnv({
      EDGEGIST_OWNER_USERNAME: 'owner name',
    })

    const rootResponse = await app.request('/', {}, env)
    expect(rootResponse.status).toBe(404)
    expect(rootResponse.headers.get('location')).toBeNull()

    const statusResponse = await app.request('/owner%20name/_edgegist/api/status', { headers: ownerHeaders() }, env)
    expect(statusResponse.status).toBe(200)

    const listResponse = await app.request('/users/owner%20name/gists', {}, env)
    expect(listResponse.status).toBe(200)

    const wrongOwnerResponse = await app.request('/owner/_edgegist/api/status', { headers: ownerHeaders() }, env)
    expect(wrongOwnerResponse.status).toBe(404)
  })

  test('stores Cloudflare settings without exposing the API token', async () => {
    const app = createApp()
    const env = createTestEnv()

    const saveResponse = await app.request(
      '/owner/_edgegist/api/cloudflare/settings',
      {
        method: 'PUT',
        headers: ownerHeaders(),
        body: JSON.stringify({
          accountId: 'account-id',
          apiToken: 'secret-token',
          workerScriptName: 'edge-gist',
          d1DatabaseId: 'database-id',
          workersPlan: 'paid',
          d1Plan: 'paid',
        }),
      },
      env,
    )

    expect(saveResponse.status).toBe(200)
    const saved = (await saveResponse.json()) as Record<string, any>
    expect(saved.hasApiToken).toBe(true)
    expect(saved.apiToken).toBeUndefined()
    expect(saved.workersPlan).toBe('paid')
    expect(saved.d1Plan).toBe('paid')

    const readResponse = await app.request('/owner/_edgegist/api/cloudflare/settings', { headers: ownerHeaders() }, env)
    const read = (await readResponse.json()) as Record<string, any>
    expect(read.hasApiToken).toBe(true)
    expect(read.apiToken).toBeUndefined()
  })

  test('allows direct secret-link reads while keeping anonymous lists public-only', async () => {
    const app = createApp()
    const env = createTestEnv()
    const secretGist = await createTestGist(env, {
      public: false,
      files: { 'secret.txt': { content: 'shareable' } },
    })
    const publicGist = await createTestGist(env, {
      public: true,
      files: { 'public.txt': { content: 'hello' } },
    })

    expect((await app.request(`/gists/${secretGist.id}`, {}, env)).status).toBe(200)
    expect((await app.request(`/gists/${publicGist.id}`, {}, env)).status).toBe(200)

    const anonymousList = (await (await app.request('/gists?per_page=100&page=1', {}, env)).json()) as Array<{ id: string }>
    expect(anonymousList.map((gist) => gist.id)).toEqual([String(publicGist.id)])
  })

  test('serves retained revisions according to the current gist visibility', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      public: false,
      files: { 'secret.txt': { content: 'secret revision' } },
    })

    await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          visibility: 'public',
          files: { 'secret.txt': { content: 'public revision' } },
        }),
      },
      env,
    )

    const ownerCommits = (await (await app.request(
      `/gists/${gist.id}/commits`,
      { headers: ownerHeaders() },
      env,
    )).json()) as Array<{ version: string }>
    const originalVersion = ownerCommits.at(-1)?.version
    expect(originalVersion).toBeString()
    if (!originalVersion) throw new Error('Expected retained original revision')

    const anonymousCommits = (await (await app.request(`/gists/${gist.id}/commits`, {}, env)).json()) as Array<{ version: string }>
    expect(anonymousCommits.map((commit) => commit.version)).toContain(originalVersion)

    const anonymousGist = (await (await app.request(`/gists/${gist.id}`, {}, env)).json()) as Record<string, any>
    expect((anonymousGist.history as Array<{ version: string }>).map((commit) => commit.version)).toContain(originalVersion)

    const anonymousVersion = await app.request(`/gists/${gist.id}/${originalVersion}`, {}, env)
    expect(anonymousVersion.status).toBe(200)
    const anonymousVersionBody = (await anonymousVersion.json()) as Record<string, any>
    expect(anonymousVersionBody.public).toBe(true)
    expect(anonymousVersionBody.visibility).toBe('public')

    const anonymousRaw = await app.request(`/gists/${gist.id}/raw/${originalVersion}/secret.txt`, {}, env)
    expect(anonymousRaw.status).toBe(200)
    expect(await anonymousRaw.text()).toBe('secret revision')

    const anonymousOwnerRaw = await app.request(`/owner/${gist.id}/raw/${originalVersion}/secret.txt`, {}, env)
    expect(anonymousOwnerRaw.status).toBe(200)
    expect(await anonymousOwnerRaw.text()).toBe('secret revision')

    const ownerRaw = await app.request(
      `/gists/${gist.id}/raw/${originalVersion}/secret.txt`,
      { headers: ownerHeaders() },
      env,
    )
    expect(ownerRaw.status).toBe(200)
    expect(await ownerRaw.text()).toBe('secret revision')

    await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({ visibility: 'secret' }),
      },
      env,
    )

    const secretVersion = await app.request(`/gists/${gist.id}/${originalVersion}`, {}, env)
    expect(secretVersion.status).toBe(200)
    const secretVersionBody = (await secretVersion.json()) as Record<string, any>
    expect(secretVersionBody.public).toBe(false)
    expect(secretVersionBody.visibility).toBe('secret')

    expect((await app.request(`/gists/${gist.id}/raw/${originalVersion}/secret.txt`, {}, env)).status).toBe(200)

    const anonymousList = (await (await app.request('/gists?per_page=100&page=1', {}, env)).json()) as Array<{ id: string }>
    expect(anonymousList.map((listed) => listed.id)).not.toContain(String(gist.id))
  })

  test('lists only public gists for anonymous frontend reads', async () => {
    const app = createApp()
    const env = createTestEnv()
    await createTestGist(env, {
      public: false,
      files: { 'secret.txt': { content: 'secret' } },
    })
    const publicGist = await createTestGist(env, {
      public: true,
      files: { 'public.txt': { content: 'public' } },
    })

    const response = await app.request('/gists?per_page=100&page=1', {}, env)

    expect(response.status).toBe(200)
    const listed = (await response.json()) as Array<{ id: string; public: boolean; files: Record<string, { content?: string }>; history?: unknown[] }>
    expect(listed.map((gist) => gist.id)).toEqual([String(publicGist.id)])
    expect(listed[0]?.public).toBe(true)
    expect(listed[0]?.files['public.txt']?.content).toBeUndefined()
    expect(listed[0]?.history).toBeUndefined()
  })

  test('lists gists with backend search filters and pagination headers', async () => {
    const app = createApp()
    const env = createTestEnv()
    const firstMatch = await createTestGist(env, {
      description: 'first match',
      public: true,
      files: { 'alpha.yaml': { content: 'server: one' } },
    })
    const secretMatch = await createTestGist(env, {
      description: 'secret match',
      public: false,
      files: { 'beta.yaml': { content: 'server: two' } },
    })
    await createTestGist(env, {
      description: 'unrelated',
      public: true,
      files: { 'gamma.yaml': { content: 'port: 443' } },
    })

    await app.request(`/gists/${secretMatch.id}/star`, { method: 'PUT', headers: ownerHeaders() }, env)

    const firstPage = await app.request(
      '/users/owner/gists?q=server&type=all&sort=created&direction=asc&page=1&per_page=1',
      { headers: ownerHeaders() },
      env,
    )
    expect(firstPage.status).toBe(200)
    expect(firstPage.headers.get('x-total-count')).toBe('2')
    expect(firstPage.headers.get('x-page')).toBe('1')
    expect(firstPage.headers.get('x-per-page')).toBe('1')
    expect(firstPage.headers.get('x-total-pages')).toBe('2')
    const firstPageBody = (await firstPage.json()) as Array<{ id: string }>
    expect(firstPageBody).toHaveLength(1)
    expect([String(firstMatch.id), String(secretMatch.id)]).toContain(firstPageBody[0]?.id)

    const starredSecret = await app.request(
      '/users/owner/gists?q=server&type=secret&starred=true&page=1&per_page=10',
      { headers: ownerHeaders() },
      env,
    )
    expect(starredSecret.status).toBe(200)
    expect(starredSecret.headers.get('x-total-count')).toBe('1')
    const starredSecretBody = (await starredSecret.json()) as Array<{ id: string }>
    expect(starredSecretBody.map((gist) => gist.id)).toEqual([String(secretMatch.id)])
  })

  test('updates file content, renames files, and deletes files', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      files: {
        'old.txt': { content: 'old' },
        'delete.txt': { content: 'bye' },
      },
    })

    const updateResponse = await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          description: 'updated',
          files: {
            'old.txt': { filename: 'new.txt', content: 'new' },
            'delete.txt': null,
          },
        }),
      },
      env,
    )

    expect(updateResponse.status).toBe(200)
    const updated = (await updateResponse.json()) as Record<string, any>
    expect(updated.description).toBe('updated')
    expect(updated.files['new.txt'].content).toBe('new')
    expect(updated.files['old.txt']).toBeUndefined()
    expect(updated.files['delete.txt']).toBeUndefined()

    const commitsResponse = await app.request(`/gists/${gist.id}/commits`, {}, env)
    expect(commitsResponse.status).toBe(200)
    const commits = (await commitsResponse.json()) as Array<{ files: Array<Record<string, any>> }>
    const renamedChange = commits[0]?.files.find((file) => file.filename === 'new.txt')
    expect(renamedChange).toMatchObject({
      filename: 'new.txt',
      previous_filename: 'old.txt',
      status: 'modified',
    })
    const deletedChange = commits[0]?.files.find((file) => file.filename === 'delete.txt')
    expect(deletedChange).toMatchObject({
      filename: 'delete.txt',
      status: 'deleted',
    })
    expect(commits[0]?.files.some((file) => file.filename === 'old.txt')).toBe(false)
  })

  test('rejects file rename collisions instead of overwriting existing files', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      files: {
        'a.txt': { content: 'a' },
        'b.txt': { content: 'b' },
      },
    })

    const updateResponse = await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'a.txt': { filename: 'b.txt', content: 'replacement' },
          },
        }),
      },
      env,
    )

    expect(updateResponse.status).toBe(400)

    const readResponse = await app.request(`/gists/${gist.id}`, { headers: ownerHeaders() }, env)
    const unchanged = (await readResponse.json()) as Record<string, any>
    expect(unchanged.files['a.txt'].content).toBe('a')
    expect(unchanged.files['b.txt'].content).toBe('b')
  })

  test('allows rename onto a file deleted in the same update regardless of field order', async () => {
    const app = createApp()

    for (const files of [
      {
        'a.txt': { filename: 'b.txt', content: 'renamed' },
        'b.txt': null,
      },
      {
        'b.txt': null,
        'a.txt': { filename: 'b.txt', content: 'renamed' },
      },
    ]) {
      const env = createTestEnv()
      const gist = await createTestGist(env, {
        files: {
          'a.txt': { content: 'a' },
          'b.txt': { content: 'b' },
        },
      })

      const updateResponse = await app.request(
        `/gists/${gist.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders(),
          body: JSON.stringify({ files }),
        },
        env,
      )

      expect(updateResponse.status).toBe(200)
      const updated = (await updateResponse.json()) as Record<string, any>
      expect(Object.keys(updated.files)).toEqual(['b.txt'])
      expect(updated.files['b.txt'].content).toBe('renamed')
    }
  })

  test('treats empty content and empty file specs as gist file deletion', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      files: {
        'delete-empty.txt': { content: 'delete me' },
        'delete-object.txt': { content: 'delete me too' },
        'keep.txt': { content: 'keep' },
      },
    })

    const updateResponse = await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'delete-empty.txt': { content: '' },
            'delete-object.txt': {},
          },
        }),
      },
      env,
    )

    expect(updateResponse.status).toBe(200)
    const updated = (await updateResponse.json()) as Record<string, any>
    expect(updated.files['delete-empty.txt']).toBeUndefined()
    expect(updated.files['delete-object.txt']).toBeUndefined()
    expect(updated.files['keep.txt'].content).toBe('keep')
  })

  test('deletes the gist record when an update deletes all files', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      files: {
        'only.txt': { content: 'delete me' },
      },
    })

    const updateResponse = await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'only.txt': null,
          },
        }),
      },
      env,
    )

    expect(updateResponse.status).toBe(204)

    const readResponse = await app.request(`/gists/${gist.id}`, { headers: ownerHeaders() }, env)
    expect(readResponse.status).toBe(404)
  })

  test('retains only the latest configured number of versions for a single file', async () => {
    const app = createApp()
    const env = createTestEnv({ EDGEGIST_HISTORY_MAX_VERSIONS: '2' })
    const gist = await createTestGist(env)

    for (const content of ['one', 'two', 'three']) {
      await app.request(
        `/gists/${gist.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders(),
          body: JSON.stringify({
            files: {
              'config.json': { content },
            },
          }),
        },
        env,
      )
    }

    const commitsResponse = await app.request(`/gists/${gist.id}/commits`, {}, env)
    expect(commitsResponse.status).toBe(200)
    const commits = (await commitsResponse.json()) as unknown[]
    expect(commits).toHaveLength(2)
  })

  test('retains the latest configured number of versions per file', async () => {
    const app = createApp()
    const env = createTestEnv({ EDGEGIST_HISTORY_MAX_VERSIONS: '2' })
    const gist = await createTestGist(env, {
      files: {
        'a.txt': { content: 'a0' },
        'b.txt': { content: 'b0' },
      },
    })

    for (const [filename, content] of [
      ['a.txt', 'a1'],
      ['a.txt', 'a2'],
      ['a.txt', 'a3'],
      ['b.txt', 'b1'],
      ['b.txt', 'b2'],
      ['b.txt', 'b3'],
    ]) {
      await app.request(
        `/gists/${gist.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders(),
          body: JSON.stringify({
            files: {
              [filename]: { content },
            },
          }),
        },
        env,
      )
    }

    const commitsResponse = await app.request(`/gists/${gist.id}/commits`, {}, env)
    expect(commitsResponse.status).toBe(200)
    const commits = (await commitsResponse.json()) as Array<{ files: Array<{ filename: string }> }>
    expect(commits).toHaveLength(4)
    expect(commits.filter((commit) => commit.files.some((file) => file.filename === 'a.txt'))).toHaveLength(2)
    expect(commits.filter((commit) => commit.files.some((file) => file.filename === 'b.txt'))).toHaveLength(2)
  })

  test('retains no history when max versions is zero', async () => {
    const app = createApp()
    const env = createTestEnv({
      EDGEGIST_HISTORY_MAX_VERSIONS: '0',
    })
    const gist = await createTestGist(env)

    await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'config.json': { content: 'updated' },
          },
        }),
      },
      env,
    )

    const commitsResponse = await app.request(`/gists/${gist.id}/commits`, {}, env)
    expect(commitsResponse.status).toBe(200)
    expect(await commitsResponse.json()).toEqual([])
  })

  test('exports and imports all gist data with optional retained history', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      description: 'portable gist',
      files: { 'config.json': { content: 'one' } },
    })
    await app.request(
      '/owner/_edgegist/api/cloudflare/settings',
      {
        method: 'PUT',
        headers: ownerHeaders(),
        body: JSON.stringify({
          accountId: 'account-id',
          apiToken: 'cloudflare-token',
          d1DatabaseId: 'database-id',
          d1Plan: 'free',
          workersPlan: 'free',
          workerScriptName: 'edge-gist',
        }),
      },
      env,
    )

    await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'config.json': { content: 'two' },
          },
        }),
      },
      env,
    )

    const currentOnlyResponse = await app.request(
      '/owner/_edgegist/api/export?includeHistory=false',
      { headers: ownerHeaders() },
      env,
    )
    expect(currentOnlyResponse.status).toBe(200)
    const currentOnly = (await currentOnlyResponse.json()) as Record<string, any>
    expect(currentOnly.includeHistory).toBe(false)
    expect(currentOnly.settings.map((setting: Record<string, unknown>) => setting.key)).toContain('cloudflare')
    expect(currentOnly.gists[0].versions).toBeUndefined()

    const fullResponse = await app.request('/owner/_edgegist/api/export?includeHistory=true', { headers: ownerHeaders() }, env)
    expect(fullResponse.status).toBe(200)
    const fullExport = (await fullResponse.json()) as Record<string, any>
    expect(fullExport.includeHistory).toBe(true)
    expect(fullExport.gists[0].versions.length).toBeGreaterThan(0)
    expect(fullExport.gists[0].versions[0].visibility).toBeUndefined()

    const importedEnv = createTestEnv()
    const importResponse = await app.request(
      '/owner/_edgegist/api/import?includeHistory=true',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify(fullExport),
      },
      importedEnv,
    )
    expect(importResponse.status).toBe(200)
    expect(await importResponse.json()).toEqual({
      gistCount: 1,
      settingCount: fullExport.settings.length,
      versionCount: fullExport.gists[0].versions.length,
    })

    const importedGist = (await (await app.request(`/gists/${gist.id}`, { headers: ownerHeaders() }, importedEnv)).json()) as Record<string, any>
    expect(importedGist.files['config.json'].content).toBe('two')

    const importedCommits = await app.request(`/gists/${gist.id}/commits`, { headers: ownerHeaders() }, importedEnv)
    expect((await importedCommits.json()) as unknown[]).toHaveLength(fullExport.gists[0].versions.length)

    const importedSettings = (await (await app.request(
      '/owner/_edgegist/api/cloudflare/settings',
      { headers: ownerHeaders() },
      importedEnv,
    )).json()) as Record<string, unknown>
    expect(importedSettings).toMatchObject({
      accountId: 'account-id',
      d1DatabaseId: 'database-id',
      hasApiToken: true,
      workerScriptName: 'edge-gist',
    })
  })

  test('imports exported gists under the configured owner', async () => {
    const app = createApp()
    const sourceEnv = createTestEnv({ EDGEGIST_OWNER_USERNAME: 'old-owner' })
    const gist = await createTestGist(sourceEnv, {
      files: { 'config.json': { content: 'portable' } },
    })
    const exportResponse = await app.request(
      '/old-owner/_edgegist/api/export?includeHistory=false',
      { headers: ownerHeaders() },
      sourceEnv,
    )
    const exported = await exportResponse.json()

    const targetEnv = createTestEnv({ EDGEGIST_OWNER_USERNAME: 'new-owner' })
    const importResponse = await app.request(
      '/new-owner/_edgegist/api/import?includeHistory=false',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify(exported),
      },
      targetEnv,
    )

    expect(importResponse.status).toBe(200)
    const ownerList = (await (await app.request(
      '/users/new-owner/gists?per_page=100',
      { headers: ownerHeaders() },
      targetEnv,
    )).json()) as Array<{ id: string }>
    expect(ownerList.map((item) => item.id)).toEqual([String(gist.id)])
  })

  test('rejects malformed imports before replacing existing data', async () => {
    const app = createApp()
    const env = createTestEnv()
    const existing = await createTestGist(env, {
      files: { 'safe.txt': { content: 'keep' } },
    })
    const now = '2026-05-09T00:00:00.000Z'
    const malformedImport = {
      format: 'edgegist.export.v1',
      exportedAt: now,
      includeHistory: false,
      gists: [
        {
          id: 'imported-gist',
          ownerLogin: 'owner',
          description: 'malformed',
          visibility: 'secret',
          starredAt: null,
          createdAt: now,
          updatedAt: now,
          files: [
            {
              filename: 'broken.txt',
              content: 'missing size',
              type: null,
              language: null,
              truncated: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      ],
    }

    const importResponse = await app.request(
      '/owner/_edgegist/api/import?includeHistory=false',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify(malformedImport),
      },
      env,
    )

    expect(importResponse.status).toBe(400)
    expect(await importResponse.json()).toMatchObject({
      message: 'Imported file broken.txt has invalid size',
    })

    const ownerList = (await (await app.request(
      '/users/owner/gists?per_page=100',
      { headers: ownerHeaders() },
      env,
    )).json()) as Array<{ id: string }>
    expect(ownerList.map((item) => item.id)).toEqual([String(existing.id)])
  })

  test('rejects imported filenames with path separators before replacing existing data', async () => {
    const app = createApp()
    const env = createTestEnv()
    const existing = await createTestGist(env, {
      files: { 'safe.txt': { content: 'keep' } },
    })
    const now = '2026-05-09T00:00:00.000Z'
    const invalidImport = {
      format: 'edgegist.export.v1',
      exportedAt: now,
      includeHistory: false,
      gists: [
        {
          id: 'imported-gist',
          ownerLogin: 'owner',
          description: 'invalid filename',
          visibility: 'secret',
          starredAt: null,
          createdAt: now,
          updatedAt: now,
          files: [
            {
              filename: 'docs/file.txt',
              content: 'not allowed',
              type: null,
              language: null,
              size: 11,
              truncated: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      ],
    }

    const importResponse = await app.request(
      '/owner/_edgegist/api/import?includeHistory=false',
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify(invalidImport),
      },
      env,
    )

    expect(importResponse.status).toBe(400)
    expect(await importResponse.json()).toMatchObject({
      message: 'Imported file docs/file.txt has invalid filename',
    })

    const ownerList = (await (await app.request(
      '/users/owner/gists?per_page=100',
      { headers: ownerHeaders() },
      env,
    )).json()) as Array<{ id: string }>
    expect(ownerList.map((item) => item.id)).toEqual([String(existing.id)])
  })

  test('supports stars while keeping other social surfaces mocked', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env)

    expect((await app.request('/gists/starred', {}, env)).status).toBe(200)
    expect(await (await app.request('/gists/starred', {}, env)).json()).toEqual([])

    expect((await app.request(`/gists/${gist.id}/star`, { headers: ownerHeaders() }, env)).status).toBe(404)

    const forks = await app.request(`/gists/${gist.id}/forks`, {}, env)
    expect(forks.status).toBe(200)
    expect(await forks.json()).toEqual([])

    const comments = await app.request(`/gists/${gist.id}/comments`, {}, env)
    expect(comments.status).toBe(200)
    expect(await comments.json()).toEqual([])

    const star = await app.request(
      `/gists/${gist.id}/star`,
      { method: 'PUT', headers: ownerHeaders() },
      env,
    )
    expect(star.status).toBe(204)

    expect((await app.request(`/gists/${gist.id}/star`, { headers: ownerHeaders() }, env)).status).toBe(204)
    const starred = (await (await app.request('/gists/starred', { headers: ownerHeaders() }, env)).json()) as Array<Record<string, any>>
    expect(starred.map((item) => item.id)).toEqual([gist.id])
    expect(starred[0]?.starred).toBe(true)

    const read = (await (await app.request(`/gists/${gist.id}`, {}, env)).json()) as Record<string, any>
    expect(read.comments).toBe(0)
    expect(read.forks).toEqual([])
    expect(read.starred).toBe(true)

    const unstar = await app.request(
      `/gists/${gist.id}/star`,
      { method: 'DELETE', headers: ownerHeaders() },
      env,
    )
    expect(unstar.status).toBe(204)
    expect((await app.request(`/gists/${gist.id}/star`, { headers: ownerHeaders() }, env)).status).toBe(404)
  })

  test('serves raw file content for visible gists', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      public: true,
      files: { 'feed.txt': { content: 'node-subscription' } },
    })

    const response = await app.request(`/gists/${gist.id}/raw/feed.txt`, {}, env)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('node-subscription')

    const ownerPathResponse = await app.request(`/owner/${gist.id}/raw/feed.txt`, {}, env)
    expect(ownerPathResponse.status).toBe(200)
    expect(await ownerPathResponse.text()).toBe('node-subscription')
  })

  test('serves raw HTML gist files as inert plain text', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      public: true,
      files: { 'index.html': { content: '<script>window.evil = true</script>' } },
    })

    const response = await app.request(`/gists/${gist.id}/raw/index.html`, {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox")
    expect(response.headers.get('x-frame-options')).toBe('deny')
    expect(response.headers.get('cache-control')).toBeNull()
    expect(await response.text()).toBe('<script>window.evil = true</script>')
  })

  test('serves raw filenames with percent characters for current files and retained revisions', async () => {
    const app = createApp()
    const env = createTestEnv()
    const filename = 'a%b.txt'
    const encodedFilename = encodeURIComponent(filename)
    const gist = await createTestGist(env, {
      public: true,
      files: { [filename]: { content: 'one' } },
    })

    const apiCurrent = await app.request(`/gists/${gist.id}/raw/${encodedFilename}`, {}, env)
    expect(apiCurrent.status).toBe(200)
    expect(await apiCurrent.text()).toBe('one')

    const ownerCurrent = await app.request(`/owner/${gist.id}/raw/${encodedFilename}`, {}, env)
    expect(ownerCurrent.status).toBe(200)
    expect(await ownerCurrent.text()).toBe('one')

    await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            [filename]: { content: 'two' },
          },
        }),
      },
      env,
    )

    const commitsResponse = await app.request(`/gists/${gist.id}/commits`, {}, env)
    const commits = (await commitsResponse.json()) as Array<{ version: string }>
    const originalVersion = commits[1]
    expect(originalVersion).toBeDefined()

    const revisionResponse = await app.request(`/gists/${gist.id}/${originalVersion.version}`, {}, env)
    const revision = (await revisionResponse.json()) as Record<string, any>
    const rawUrl = revision.files[filename].raw_url as string
    expect(rawUrl).toBe(`https://edgegist.test/owner/${gist.id}/raw/${originalVersion.version}/${encodedFilename}`)

    const ownerRevisionRaw = await app.request(new URL(rawUrl).pathname, {}, env)
    expect(ownerRevisionRaw.status).toBe(200)
    expect(await ownerRevisionRaw.text()).toBe('one')

    const apiRevisionRaw = await app.request(
      `/gists/${gist.id}/raw/${originalVersion.version}/${encodedFilename}`,
      {},
      env,
    )
    expect(apiRevisionRaw.status).toBe(200)
    expect(await apiRevisionRaw.text()).toBe('one')
  })

  test('serves raw file content from retained revisions', async () => {
    const app = createApp()
    const env = createTestEnv()
    const gist = await createTestGist(env, {
      files: { 'config.json': { content: 'one' } },
    })

    await app.request(
      `/gists/${gist.id}`,
      {
        method: 'PATCH',
        headers: ownerHeaders(),
        body: JSON.stringify({
          files: {
            'config.json': { content: 'two' },
          },
        }),
      },
      env,
    )

    const commitsResponse = await app.request(`/gists/${gist.id}/commits`, {}, env)
    const commits = (await commitsResponse.json()) as Array<{ url: string; version: string }>
    const originalVersion = commits[1]
    expect(originalVersion).toBeDefined()

    const revisionResponse = await app.request(new URL(originalVersion.url).pathname, {}, env)
    expect(revisionResponse.status).toBe(200)
    const revision = (await revisionResponse.json()) as Record<string, any>
    expect(revision.html_url).toBe(`https://edgegist.test/owner/${gist.id}/${originalVersion.version}`)
    const rawUrl = revision.files['config.json'].raw_url as string
    expect(rawUrl).toBe(`https://edgegist.test/owner/${gist.id}/raw/${originalVersion.version}/config.json`)

    const rawResponse = await app.request(new URL(rawUrl).pathname, {}, env)
    expect(rawResponse.status).toBe(200)
    expect(await rawResponse.text()).toBe('one')

    const apiRawResponse = await app.request(`/gists/${gist.id}/raw/${originalVersion.version}/config.json`, {}, env)
    expect(apiRawResponse.status).toBe(200)
    expect(await apiRawResponse.text()).toBe('one')
  })
})
