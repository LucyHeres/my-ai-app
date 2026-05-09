import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/chat': 'http://localhost:8000',
      '/documents': 'http://localhost:8000',
      '/conversations': 'http://localhost:8000',
      '/rag': 'http://localhost:8000'
    }
  }
})
