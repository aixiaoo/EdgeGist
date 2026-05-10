import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative } from 'node:path'
import { zipSync } from 'fflate'
import { verifyReleaseDirectory } from './verify-release'

const releaseRoot = 'release/edgegist'
const packageZipPath = 'release/edgegist-package.zip'

rmSync(releaseRoot, { recursive: true, force: true })
rmSync(packageZipPath, { force: true })
rmSync('release/edgegist.zip', { force: true })
mkdirSync(releaseRoot, { recursive: true })

copyDirectory('dist', join(releaseRoot, 'dist'))
copyDirectory('migrations', join(releaseRoot, 'migrations'))
copyDirectory('docs', join(releaseRoot, 'docs'))

for (const file of [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'package.json',
  'wrangler.example.jsonc',
]) {
  if (existsSync(file)) copyFileSync(file, join(releaseRoot, basename(file)))
}

writeFileSync(packageZipPath, zipSync(collectFilesForZip(releaseRoot, 'edgegist')))

const verification = verifyReleaseDirectory(releaseRoot, {
  requirePackageZip: true,
  packageZipPath,
})
if (!verification.ok) {
  console.error(`Release package missing required files:\n${verification.missing.join('\n')}`)
  process.exit(1)
}

console.log(`Release package created at ${releaseRoot} and ${packageZipPath}`)

function copyDirectory(from: string, to: string): void {
  if (!existsSync(from)) return
  cpSync(from, to, { recursive: true })
}

function collectFilesForZip(root: string, prefix = ''): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  visit(root)
  return files

  function visit(path: string): void {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry))
      return
    }

    const zipName = join(prefix, relative(root, path)).replaceAll('\\', '/')
    files[zipName] = new Uint8Array(readFileSync(path))
  }
}
