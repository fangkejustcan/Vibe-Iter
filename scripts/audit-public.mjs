import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { publicFiles } from './public-files.mjs'
import { execFileSync } from 'node:child_process'

// Report locations and rule names only. Never echo potential secret values.
export const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['provider-token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|hf_[A-Za-z0-9]{25,}|AKIA[A-Z0-9]{16})\b/],
  ['credential-in-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['personal-windows-home', /[A-Za-z]:[\\/]Users[\\/][^\s\\/]+/i],
  ['personal-unix-home', /\/(?:Users|home)\/(?!runner(?:\/|\b))[^\s/]+/],
  ['private-local-recording', /session-mv[a-z0-9]+-[a-z0-9]+|\.local[\\/]reviews[\\/]/i],
  ['internal-service-link', /https?:\/\/[^\s/]*(?:feishu\.cn|larksuite\.com)\//i],
]

export function inspectText(text, file) {
  return text.split(/\r?\n/).flatMap((line, index) => rules
    .filter(([, pattern]) => pattern.test(line))
    .map(([rule]) => ({ file, line: index + 1, rule })))
}

export function audit(root, checkTracked = false) {
  const files = publicFiles(root)
  const findings = []
  for (const file of files) {
    const data = readFileSync(resolve(root, file))
    if (!/\.(?:png|jpg|jpeg|mp4|gif|webp|ico|woff2?)$/i.test(file)) {
      findings.push(...inspectText(data.toString('utf8'), file))
    }
    if (/\.(?:webm|wav|mp3|zip|pem|key|log)$/i.test(file) || /(?:^|\/)(?:\.env(?:\.|$)|\.aws|\.local|node_modules)(?:\/|$)/.test(file)) {
      findings.push({ file, rule: 'private-artifact' })
    }
  }
  if (checkTracked) {
    const allowed = new Set(files)
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    for (const file of tracked) {
      if (!allowed.has(file)) findings.push({ file, rule: 'unexpected-tracked-file' })
    }
  }
  return { files: files.length, findings }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '.')
  const result = audit(root, process.argv.includes('--tracked'))
  console.log(JSON.stringify(result, null, 2))
  if (result.findings.length) process.exitCode = 1
}
