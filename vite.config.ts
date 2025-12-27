import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const hostPermissions = new Set<string>(['https://www.youtube.com/*']);

  const addHostPermission = (value?: string) => {
    if (!value) return;
    try {
      const origin = new URL(value).origin;
      hostPermissions.add(`${origin}/*`);
    } catch {
      return;
    }
  };

  addHostPermission(env.VITE_API_BASE_URL || 'http://localhost:8787');
  addHostPermission(env.VITE_SUPABASE_URL);

  const manifest = {
    manifest_version: 3,
    name: 'Intent',
    version: '0.0.1',
    description: 'Read-first YouTube summaries with attention-aware feedback.',
    permissions: ['storage', 'identity'],
    host_permissions: Array.from(hostPermissions),
    content_scripts: [
      {
        matches: ['https://www.youtube.com/*'],
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

  return {
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
  };
});
