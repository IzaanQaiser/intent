import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const storage = {
  getItem: (key: string) =>
    new Promise<string | null>((resolve) => {
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime?.lastError) {
            resolve(null);
            return;
          }
          resolve(result[key] ?? null);
        });
      } catch {
        resolve(null);
      }
    }),
  setItem: (key: string, value: string) =>
    new Promise<void>((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      } catch {
        resolve();
      }
    }),
  removeItem: (key: string) =>
    new Promise<void>((resolve) => {
      try {
        chrome.storage.local.remove([key], () => resolve());
      } catch {
        resolve();
      }
    })
};

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage
      }
    })
  : null;
