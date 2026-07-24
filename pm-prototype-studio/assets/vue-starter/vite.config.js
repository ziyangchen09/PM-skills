import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  css: {
    // Keep prototypes isolated from unrelated PostCSS configs in parent folders.
    postcss: { plugins: [] },
  },
})
