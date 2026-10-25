import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // three.js alone is ~700 kB minified.
    chunkSizeWarningLimit: 1000,
  },
})
