import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the server to out/index.js (CommonJS, plain Node 24). Dependencies stay external (ssr build), so node_modules must be
// present next to the repo.
export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/index.ts'),
    outDir: 'out',
    emptyOutDir: true,
    target: 'node24',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'index.js', banner: '#!/usr/bin/env node' }
    }
  },
  ssr: { target: 'node', noExternal: [] }
})
