import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { publicFiles } from './public-files.mjs'
import { audit } from './audit-public.mjs'

const root = resolve('.')
const destination = resolve(process.argv[2] || '.local/open-source')
if (existsSync(destination)) throw new Error('Destination already exists; choose a new empty directory.')
const result = audit(root)
if (result.findings.length) throw new Error(`Public audit failed: ${JSON.stringify(result.findings)}`)
const files = publicFiles(root)
for (const file of files) {
  mkdirSync(dirname(resolve(destination, file)), { recursive: true })
  cpSync(resolve(root, file), resolve(destination, file), { errorOnExist: true, force: false })
}
mkdirSync(resolve('.local'), { recursive: true })
writeFileSync(resolve('.local/public-export-manifest.json'), JSON.stringify({ destination, files }, null, 2))
console.log(`Exported ${files.length} reviewed files to ${destination}. No Git history was copied.`)
