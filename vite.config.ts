import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';

const manifest = {
  manifest_version: 3,
  name: 'Intent',
  version: '0.0.1',
  description: 'Read-first YouTube summaries with attention-aware feedback.',
  permissions: ['storage', 'identity'],
  host_permissions: ['https://www.youtube.com/*', 'http://localhost:8787/*'],
  content_scripts: [
    {
      matches: ['https://www.youtube.com/watch*'],
      js: ['src/contentScript.tsx'],
      run_at: 'document_idle'
    }
  ],
  action: {
    default_title: 'Intent',
    default_popup: 'popup.html'
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module'
  },
  web_accessible_resources: [
    {
      resources: ['auth.html'],
      matches: ['<all_urls>']
    }
  ]
};

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        auth: 'auth.html',
        popup: 'popup.html'
      }
    }
  }
});
