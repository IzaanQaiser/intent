import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const storage = {
  getItem: (key: string) =>
    new Promise<string | null>((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result[key] ?? null));
    }),
  setItem: (key: string, value: string) =>
    new Promise<void>((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    }),
  removeItem: (key: string) =>
    new Promise<void>((resolve) => {
      chrome.storage.local.remove([key], () => resolve());
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
