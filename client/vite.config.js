import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/token': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/voice': 'http://localhost:3001',
      '/demo': 'http://localhost:3001',
    },
  },
})
