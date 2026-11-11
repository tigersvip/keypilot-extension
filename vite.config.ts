import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), {
    name: 'single-content-script-installation',
    renderChunk(code, chunk) {
      if (chunk.name !== 'content' || !chunk.isEntry) return null;
      // Manifest injection and the background fallback can race. Keep state private
      // and install one listener set per document, even after manual reinjection.
      // hasListener also allows recovery when an older extension context was invalidated.
      return {code:`(()=>{const key='__keypilotContentInstallation';const previous=globalThis[key];if(previous&&chrome.runtime.onMessage.hasListener(previous))return;const marker=()=>false;chrome.runtime.onMessage.addListener(marker);globalThis[key]=marker;\n${code}\n})();`,map:null};
    }
  }, {
    name: 'offline-ocr-assets',
    generateBundle() {
      this.emitFile({type:'asset',fileName:'ocr/digits-v1.bin.gz',source:readFileSync(resolve(rootDir,'src/ocr-lite/digits-v1.bin.gz'))});
      for(const name of ['captcha-ascii.onnx.gz','eng.traineddata.gz'])this.emitFile({type:'asset',fileName:'ocr/'+name,source:readFileSync(resolve(rootDir,'src/ocr-models',name))});
      this.emitFile({type:'asset',fileName:'ocr/ort-wasm-simd-threaded.wasm.gz',source:gzipSync(readFileSync(resolve(rootDir,'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')),{level:9})});
      for (const [source,target] of [
        ['onnxruntime-web/dist/ort.wasm.min.mjs','ocr/ort.wasm.min.mjs'],
        ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs','ocr/ort-wasm-simd-threaded.mjs'],
        ['onnxruntime-web/README.md','licenses/onnxruntime-web-README.md'],
        ['tesseract.js/dist/worker.min.js','ocr/worker.min.js'],
        ['tesseract.js-core/tesseract-core-lstm.js','ocr/tesseract-core-lstm.js'],
        ['tesseract.js-core/tesseract-core-lstm.wasm','ocr/tesseract-core-lstm.wasm'],
        ['tesseract.js/LICENSE.md','licenses/tesseract-js.txt'],
        ['tesseract.js/dist/worker.min.js.LICENSE.txt','ocr/worker.min.js.LICENSE.txt'],
        ['tesseract.js-core/LICENSE','licenses/tesseract-core.txt'],
        ['regenerator-runtime/LICENSE','licenses/ocr-regenerator-runtime.txt'],
        ['zlibjs/LICENSE','licenses/ocr-zlibjs.txt'],
        ['bmp-js/LICENSE','licenses/ocr-bmp-js.txt'],
        ['wasm-feature-detect/LICENSE','licenses/ocr-wasm-feature-detect.txt'],
        ['idb-keyval/LICENCE','licenses/ocr-idb-keyval.txt'],
        ['is-url/LICENSE-MIT','licenses/ocr-is-url.txt']
      ]) this.emitFile({type:'asset',fileName:target,source:readFileSync(resolve(rootDir,'node_modules',source))});
    }
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        loginStatus: resolve(rootDir, 'login-status.html'),
        offscreen: resolve(rootDir, 'offscreen.html'),
        reminder: resolve(rootDir, 'reminder.html'),
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
