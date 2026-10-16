import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8 } from 'fflate'
import { inspectText } from '../scripts/audit-public.mjs'
import { checkBundle } from '../scripts/package-extension.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-package-test-'))
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  writeFileSync(join(root, 'src/shared/protocol.ts'), "export const BUILD_VERSION = '1.2.3'")
  const manifest = {
    manifest_version: 3, version: '1.2.3',
    background: { service_worker: 'background.js' }, side_panel: { default_path: 'sidepanel.html' },
    options_ui: { page: 'microphone.html' }, content_scripts: [{ js: ['content.js'] }],
    icons: { 16: 'icons/icon-16.png' },
  }
  const names = ['background.js', 'content.js', 'sidepanel.js', 'microphone.js', 'offscreen.js',
    'sidepanel.html', 'microphone.html', 'offscreen.html', ...[16,32,48,128].map(size => `icons/icon-${size}.png`)]
  const files = Object.fromEntries(names.map(name => [name, strToU8('/* test */')]))
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return { root, files }
}

test('release boundary rejects private recordings and unplanned build files', () => {
  const { root, files } = fixture()
  try {
    checkBundle(files, root)
    for (const name of ['audio.webm', '.env', 'game.html', 'assets/debug.js.map', 'sessions/session.json']) {
      assert.throws(() => checkBundle({ ...files, [name]: strToU8('private') }, root), /Unexpected file/)
    }
    assert.throws(() => checkBundle({ ...files, 'content.js': strToU8('import x from "./chunk.js";') }, root), /classic scripts/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('broken version or missing manifest target blocks release', () => {
  const { root, files } = fixture()
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.4' }))
    assert.throws(() => checkBundle(files, root), /versions must agree/)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    delete files['background.js']
    assert.throws(() => checkBundle(files, root), /Missing required|missing file/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('audit locates credentials and personal paths without echoing their values', () => {
  const secret = ['ghp', 'A'.repeat(36)].join('_')
  const personal = ['C:', 'Users', 'example-person', 'Downloads'].join('\\')
  const findings = inspectText(`${secret}\n${personal}`, 'sample.txt')
  assert.deepEqual(findings.map(f => f.line), [1, 2])
  assert.ok(!JSON.stringify(findings).includes(secret))
  assert.ok(!JSON.stringify(findings).includes('example-person'))
  assert.deepEqual(inspectText('http://127.0.0.1:4318\nhttps://github.com/example/project', 'safe.txt'), [])
})
