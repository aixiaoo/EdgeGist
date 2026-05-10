import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
copyFileSync('.assetsignore', 'dist/.assetsignore')
