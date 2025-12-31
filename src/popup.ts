import { supabase } from './supabaseClient';
import './popup.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

const container = document.createElement('div');
container.className = 'popup';
root.appendChild(container);

const header = document.createElement('div');
header.className = 'popup__header';
container.appendChild(header);

const title = document.createElement('div');
title.className = 'popup__title';
title.textContent = 'Intent';
header.appendChild(title);

const settingsButton = document.createElement('button');
settingsButton.className = 'popup__gear';
settingsButton.type = 'button';
settingsButton.textContent = '⚙';
header.appendChild(settingsButton);

const actions = document.createElement('div');
actions.className = 'popup__actions';
container.appendChild(actions);

const dashboardButton = document.createElement('button');
dashboardButton.className = 'popup__button popup__button--secondary';
dashboardButton.type = 'button';
dashboardButton.textContent = 'My Dashboard';
actions.appendChild(dashboardButton);

const button = document.createElement('button');
button.className = 'popup__button';
button.type = 'button';
actions.appendChild(button);

async function clearLocalSession() {
  const storageKey = (supabase?.auth as { storageKey?: string } | undefined)?.storageKey;
  if (!storageKey) return;
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove(
      [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`],
      () => resolve()
    );
  });
}

async function refresh() {
  if (!supabase) {
    button.textContent = 'Unavailable';
    button.disabled = true;
    return;
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    button.textContent = 'Log out';
    button.disabled = false;
  } else {
    button.textContent = 'Sign in in-page';
    button.disabled = true;
  }
}

button.addEventListener('click', async () => {
  if (!supabase) return;
  button.disabled = true;
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) {
    await clearLocalSession();
  }
  try {
    chrome.runtime.sendMessage({ type: 'auth_signed_out' });
  } catch {}
  await refresh();
});

const openExtensionPage = (page: string) => {
  const url = chrome.runtime?.getURL(page);
  if (!url) return;
  try {
    chrome.tabs?.create({ url });
  } catch {
    window.open(url, '_blank');
  }
};

dashboardButton.addEventListener('click', () => openExtensionPage('index.html'));
settingsButton.addEventListener('click', () => openExtensionPage('settings.html'));

void refresh();
