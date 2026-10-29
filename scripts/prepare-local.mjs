import { access, copyFile } from 'node:fs/promises'

try {
  await access(new URL('../.dev.vars', import.meta.url))
} catch {
  await copyFile(new URL('../.dev.vars.example', import.meta.url), new URL('../.dev.vars', import.meta.url))
  console.log('Local configuration created. R2 data persists in .wrangler/state.')
}
