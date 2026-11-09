import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the server to out/index.js and the local-patch CLI to out/patches.js (CommonJS, plain Node 24). Dependencies stay external (ssr build), so node_modules must be
// present next to the repo.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'out',
    emptyOutDir: true,
    target: 'node24',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/index.ts'), patches: resolve(__dirname, 'src/patches-cli.ts') },
      output: { format: 'cjs', entryFileNames: '[name].js', banner: '#!/usr/bin/env node' }
    }
  },
  ssr: { target: 'node', noExternal: [] }
})
