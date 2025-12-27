import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';

const manifest = {
  manifest_version: 3,
  name: 'Intentional Consumption',
  version: '0.0.1',
  description: 'Read-first YouTube summaries with attention-aware feedback.',
  permissions: ['storage'],
  host_permissions: ['https://www.youtube.com/*'],
  content_scripts: [
    {
      matches: ['https://www.youtube.com/watch*'],
      js: ['src/contentScript.tsx'],
      run_at: 'document_idle'
    }
  ],
  action: {
    default_title: 'Intentional Consumption'
  }
};

export default defineConfig({
  plugins: [react(), crx({ manifest })]
});
