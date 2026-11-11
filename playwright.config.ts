import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser',fullyParallel:false,workers:1,timeout:45000,
  reporter:'list',outputDir:'output/playwright/results',
  use:{trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'npm run lab',url:'http://127.0.0.1:4173/test-lab/',reuseExistingServer:false,timeout:30000}
});
