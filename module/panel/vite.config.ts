import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Keep the daemon's panel self-contained so the daemon serves a single file.
// The separate demo build can also open directly from disk.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  base: './',
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})
