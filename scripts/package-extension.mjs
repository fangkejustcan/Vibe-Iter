import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { walk } from './public-files.mjs'
import { inspectText } from './audit-public.mjs'

const rootEntries = new Set(['manifest.json', 'background.js', 'content.js', 'sidepanel.js', 'microphone.js', 'offscreen.js', 'sidepanel.html', 'microphone.html', 'offscreen.html'])
const licenseEntries = new Set(['LICENSE', 'THIRD_PARTY_NOTICES.md'])

export function checkBundle(files, root) {
  const errors = []
  for (const required of [...rootEntries, ...[16, 32, 48, 128].map((size) => `icons/icon-${size}.png`)]) {
    if (!files[required]) errors.push(`Missing required extension file: ${required}`)
  }
  for (const [name, bytes] of Object.entries(files)) {
    const allowed = rootEntries.has(name) || licenseEntries.has(name)
      || /^chunks\/[A-Za-z0-9_-]+\.js$/.test(name)
      || /^assets\/[A-Za-z0-9_-]+\.(?:css|png|jpg|webp|woff2?)$/.test(name)
      || /^icons\/icon-(?:16|32|48|128)\.png$/.test(name)
    if (!allowed) errors.push(`Unexpected file in extension: ${name}`)
    if (/\.(?:js|html|css|json)$/.test(name)) {
      const text = new TextDecoder().decode(bytes)
      errors.push(...inspectText(text, name).map((finding) => `${finding.rule}: ${name}:${finding.line}`))
      if (/https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/))[^\s"'<>)}]+/i.test(text)
        && /(?:fetch\s*\(\s*['"]https?:|@import\s+url|<script[^>]+src=['"]https?:)/i.test(text)) {
        errors.push(`Remote runtime asset or endpoint in ${name}`)
      }
    }
  }
  if (files['manifest.json']) {
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const protocol = readFileSync(join(root, 'src/shared/protocol.ts'), 'utf8')
    if (manifest.version !== pkg.version || !protocol.includes(`BUILD_VERSION = '${pkg.version}'`)) errors.push('Package, manifest and UI versions must agree.')
    if (manifest.manifest_version !== 3) errors.push('Expected a Manifest V3 extension.')
    if (manifest.key || manifest.update_url) errors.push('Do not bundle private signing or update configuration.')
    const paths = [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_ui.page,
      ...manifest.content_scripts.flatMap((script) => script.js), ...Object.values(manifest.icons)]
    for (const path of paths) if (!files[path]) errors.push(`Manifest references missing file: ${path}`)
  }
  if (files['content.js'] && /(?:^|;)\s*(?:import\s|export\s)/m.test(new TextDecoder().decode(files['content.js']))) {
    errors.push('Content scripts must be classic scripts without ESM imports or exports.')
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

export function packageExtension(root = resolve('.'), checkOnly = false) {
  const files = Object.fromEntries(walk(root, 'dist').map((file) => [file.slice(5), new Uint8Array(readFileSync(join(root, file)))]))
  checkBundle(files, root)
  if (checkOnly) { console.log(`PASS: ${Object.keys(files).length} reviewed extension files`); return }
  for (const name of licenseEntries) files[name] = strToU8(readFileSync(join(root, name), 'utf8'))
  const input = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => [name, [data, { mtime: new Date(1980, 0, 1) }]]))
  const zip = zipSync(input, { level: 9 })
  checkBundle(unzipSync(zip), root)
  const destination = join(root, 'release')
  mkdirSync(destination, { recursive: true })
  const name = 'vibe-iter-chrome.zip'
  writeFileSync(join(destination, name), zip)
  writeFileSync(join(destination, 'SHA256SUMS.txt'), `${createHash('sha256').update(zip).digest('hex')}  ${name}\n`)
  console.log(`Packaged ${name}: ${zip.byteLength.toLocaleString()} bytes. SHA-256 written to release/SHA256SUMS.txt.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync('dist/manifest.json')) throw new Error('Build the extension before packaging.')
  packageExtension(resolve('.'), process.argv.includes('--check'))
}
