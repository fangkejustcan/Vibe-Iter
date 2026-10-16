import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'extension-public-assets',
    generateBundle() {
      for (const fileName of ['manifest.json', ...[16, 32, 48, 128].map((size) => `icons/icon-${size}.png`)]) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(root, 'public', fileName)) })
      }
    },
  }],
  build: {
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(root, 'sidepanel.html'),
        microphone: resolve(root, 'microphone.html'),
        offscreen: resolve(root, 'offscreen.html'),
        background: resolve(root, 'src/background.ts'),
        content: resolve(root, 'src/content.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
