import { supabase } from './supabaseClient';

const status = document.createElement('div');
status.style.fontFamily = 'system-ui, sans-serif';
status.style.padding = '24px';
status.textContent = 'Signing you in…';
document.body.appendChild(status);

if (!supabase) {
  status.textContent = 'Missing Supabase configuration.';
} else {
  supabase.auth.getSession().then(() => {
    status.textContent = 'Signed in. You can close this tab.';
    try {
      chrome.runtime.sendMessage({ type: 'auth_complete' });
    } catch {}
    window.close();
  });
}
