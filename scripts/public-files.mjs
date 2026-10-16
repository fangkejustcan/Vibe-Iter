import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export const rootFiles = [
  '.gitignore', '.gitattributes', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'PRIVACY.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', 'sidepanel.html', 'microphone.html', 'offscreen.html',
]
export const publicScripts = [
  'audit-public.mjs', 'export-public.mjs', 'public-files.mjs', 'package-extension.mjs',
  'transcription_server.py', 'requirements-voice.txt', 'requirements-test.txt', 'start-local.ps1',
  'extension_smoke.py', 'game_smoke.py', 'legacy_export_smoke.py', 'local_voice_smoke.py',
  'recording_recovery_smoke.py', 'session_recording_smoke.py', 'ui_smoke.py', 'package_smoke.py',
]
export const publicDocs = [
  'ARCHITECTURE.md', 'USER-NOTES.md', 'INSTALLATION.md', 'AGENT-INSTALL.md', 'DEVELOPMENT.md', 'RELEASING.md',
]

export function walk(root, directory) {
  const result = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${directory}/${entry.name}`)
    const name = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...walk(root, name))
    else if (entry.isFile()) result.push(relative(root, join(root, name)).replaceAll('\\', '/'))
  }
  return result.sort()
}

export function publicFiles(root) {
  return [
    ...rootFiles,
    ...publicScripts.map((name) => `scripts/${name}`),
    ...publicDocs.map((name) => `docs/${name}`),
    ...['src', 'public', 'tests', '.github', 'docs/assets'].flatMap((dir) => walk(root, dir)),
  ].sort()
}
