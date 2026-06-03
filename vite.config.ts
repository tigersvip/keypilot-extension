import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: resolve(rootDir, 'popup.html'),
        vault: resolve(rootDir, 'vault.html'),
        options: resolve(rootDir, 'options.html'),
        background: resolve(rootDir, 'src/background/serviceWorker.ts'),
        content: resolve(rootDir, 'src/content/index.ts')
      },
      output: {
        entryFileNames: (chunk: { name: string }) => {
          if (chunk.name === 'background') {
            return 'background.js';
          }

          if (chunk.name === 'content') {
            return 'content.js';
          }

          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
