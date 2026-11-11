import {defineConfig} from 'vite';
import {resolve} from 'node:path';
export default defineConfig({
  root:resolve(import.meta.dirname),base:'./',
  server:{host:'127.0.0.1',port:4174,strictPort:true,fs:{allow:[resolve(import.meta.dirname,'../..')]}},
  build:{outDir:resolve(import.meta.dirname,'../../ocr-lab-dist'),emptyOutDir:true,target:'es2022',assetsInlineLimit:2_000_000,chunkSizeWarningLimit:2000}
});
