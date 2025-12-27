import { supabase } from './supabaseClient';
import './popup.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

const container = document.createElement('div');
container.className = 'popup';
root.appendChild(container);

const title = document.createElement('div');
title.className = 'popup__title';
title.textContent = 'Intent';
container.appendChild(title);

const status = document.createElement('div');
status.className = 'popup__status';
container.appendChild(status);

const button = document.createElement('button');
button.className = 'popup__button';
button.type = 'button';
container.appendChild(button);

async function refresh() {
  if (!supabase) {
    status.textContent = 'Missing Supabase configuration.';
    button.textContent = 'Unavailable';
    button.disabled = true;
    return;
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    status.textContent = 'Signed in.';
    button.textContent = 'Log out';
    button.disabled = false;
  } else {
    status.textContent = 'Not signed in.';
    button.textContent = 'Sign in in-page';
    button.disabled = true;
  }
}

button.addEventListener('click', async () => {
  if (!supabase) return;
  button.disabled = true;
  await supabase.auth.signOut();
  chrome.runtime.sendMessage({ type: 'auth_signed_out' });
  await refresh();
});

void refresh();
