import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const status = document.createElement('div');
status.style.fontFamily = 'system-ui, sans-serif';
status.style.padding = '24px';
status.textContent = 'Signing you in…';
document.body.appendChild(status);

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

supabase.auth.getSession().then(() => {
  status.textContent = 'Signed in. You can close this tab.';
  window.close();
});
