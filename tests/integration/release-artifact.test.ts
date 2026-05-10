import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { verifyReleaseDirectory } from '../../scripts/verify-release'

describe('release artifact verification', () => {
  test('passes when required release files exist', () => {
    const root = '.tmp-release-test/pass'
    rmSync(root, { recursive: true, force: true })
    mkdirSync(`${root}/dist`, { recursive: true })
    mkdirSync(`${root}/migrations`, { recursive: true })
    writeFileSync(`${root}/dist/_worker.js`, 'export default {}')
    writeFileSync(`${root}/dist/.assetsignore`, '_worker.js')
    writeFileSync(`${root}/migrations/0001_initial.sql`, 'SELECT 1;')
    writeFileSync(`${root}/README.md`, '# EdgeGist')
    writeFileSync(`${root}/README.zh-CN.md`, '# EdgeGist')
    writeFileSync(`${root}/wrangler.example.jsonc`, '{}')
    writeFileSync(`${root}-package.zip`, 'zip')

    expect(
      verifyReleaseDirectory(root, {
        requirePackageZip: true,
        packageZipPath: `${root}-package.zip`,
      }).ok,
    ).toBe(true)
    rmSync('.tmp-release-test', { recursive: true, force: true })
  })

  test('fails when worker output is missing', () => {
    const root = '.tmp-release-test/fail'
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })

    const result = verifyReleaseDirectory(root)

    expect(result.ok).toBe(false)
    expect(result.missing).toContain('dist/_worker.js')
    rmSync('.tmp-release-test', { recursive: true, force: true })
    expect(existsSync('.tmp-release-test')).toBe(false)
  })

  test('fails when the package zip artifact is required and missing', () => {
    const root = '.tmp-release-test/no-zip'
    rmSync(root, { recursive: true, force: true })
    mkdirSync(`${root}/dist`, { recursive: true })
    mkdirSync(`${root}/migrations`, { recursive: true })
    writeFileSync(`${root}/dist/_worker.js`, 'export default {}')
    writeFileSync(`${root}/dist/.assetsignore`, '_worker.js')
    writeFileSync(`${root}/migrations/0001_initial.sql`, 'SELECT 1;')
    writeFileSync(`${root}/README.md`, '# EdgeGist')
    writeFileSync(`${root}/README.zh-CN.md`, '# EdgeGist')
    writeFileSync(`${root}/wrangler.example.jsonc`, '{}')

    const result = verifyReleaseDirectory(root, {
      requirePackageZip: true,
      packageZipPath: `${root}-package.zip`,
    })

    expect(result.ok).toBe(false)
    expect(result.missing).toContain(`${root}-package.zip`)
    rmSync('.tmp-release-test', { recursive: true, force: true })
  })

  test('fails when the assets ignore file is missing', () => {
    const root = '.tmp-release-test/no-assetsignore'
    rmSync(root, { recursive: true, force: true })
    mkdirSync(`${root}/dist`, { recursive: true })
    mkdirSync(`${root}/migrations`, { recursive: true })
    writeFileSync(`${root}/dist/_worker.js`, 'export default {}')
    writeFileSync(`${root}/migrations/0001_initial.sql`, 'SELECT 1;')
    writeFileSync(`${root}/README.md`, '# EdgeGist')
    writeFileSync(`${root}/README.zh-CN.md`, '# EdgeGist')
    writeFileSync(`${root}/wrangler.example.jsonc`, '{}')

    const result = verifyReleaseDirectory(root)

    expect(result.ok).toBe(false)
    expect(result.missing).toContain('dist/.assetsignore')
    rmSync('.tmp-release-test', { recursive: true, force: true })
  })
})
