import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ReleaseVerificationResult = {
  ok: boolean
  missing: string[]
}

const requiredFiles = [
  'dist/_worker.js',
  'dist/.assetsignore',
  'migrations/0001_initial.sql',
  'README.md',
  'README.zh-CN.md',
  'wrangler.example.jsonc',
]

export function verifyReleaseDirectory(
  root = 'release/edgegist',
  options: {
    requirePackageZip?: boolean
    packageZipPath?: string
  } = {},
): ReleaseVerificationResult {
  const missing = requiredFiles.filter((file) => !existsSync(join(root, file)))
  if (options.requirePackageZip && !existsSync(options.packageZipPath ?? 'release/edgegist-package.zip')) {
    missing.push(options.packageZipPath ?? 'release/edgegist-package.zip')
  }
  return {
    ok: missing.length === 0,
    missing,
  }
}

if (import.meta.main) {
  const root = process.argv[2] ?? 'release/edgegist'
  const result = verifyReleaseDirectory(root, {
    requirePackageZip: true,
  })
  if (!result.ok) {
    console.error(`Release artifact is missing required files:\n${result.missing.join('\n')}`)
    process.exit(1)
  }
  console.log(`Release artifact verified: ${root}`)
}
