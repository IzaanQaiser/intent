import { supabase } from './supabaseClient';
import './settings.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

const container = document.createElement('div');
container.className = 'settings';
root.appendChild(container);

const header = document.createElement('div');
header.className = 'settings__header';
container.appendChild(header);

const title = document.createElement('h1');
title.textContent = 'Settings';
header.appendChild(title);

const subtitle = document.createElement('p');
subtitle.textContent = 'Tune your read-first flow and keep an eye on attention signals.';
header.appendChild(subtitle);

const cards = document.createElement('div');
cards.className = 'settings__grid';
container.appendChild(cards);

const accountCard = document.createElement('div');
accountCard.className = 'settings__card';
cards.appendChild(accountCard);

const accountTitle = document.createElement('h2');
accountTitle.textContent = 'Account';
accountCard.appendChild(accountTitle);

const accountStatus = document.createElement('div');
accountStatus.className = 'settings__status';
accountCard.appendChild(accountStatus);

const accountMeta = document.createElement('div');
accountMeta.className = 'settings__meta';
accountCard.appendChild(accountMeta);

const accountButton = document.createElement('button');
accountButton.className = 'settings__button';
accountButton.type = 'button';
accountButton.textContent = 'Log out';
accountCard.appendChild(accountButton);

const dashboardCard = document.createElement('div');
dashboardCard.className = 'settings__card';
cards.appendChild(dashboardCard);

const dashboardTitle = document.createElement('h2');
dashboardTitle.textContent = 'Insights';
dashboardCard.appendChild(dashboardTitle);

const dashboardCopy = document.createElement('p');
dashboardCopy.textContent = 'Review risk windows and behavior trends in your dashboard.';
dashboardCard.appendChild(dashboardCopy);

const dashboardButton = document.createElement('button');
dashboardButton.className = 'settings__button settings__button--secondary';
dashboardButton.type = 'button';
dashboardButton.textContent = 'my dashboard';
dashboardCard.appendChild(dashboardButton);

const streamCard = document.createElement('div');
streamCard.className = 'settings__card';
cards.appendChild(streamCard);

const streamTitle = document.createElement('h2');
streamTitle.textContent = 'Streaming';
streamCard.appendChild(streamTitle);

const streamCopy = document.createElement('p');
streamCopy.textContent = 'Events stream to Confluent for analytics and AI insights.';
streamCard.appendChild(streamCopy);

const streamBadge = document.createElement('div');
streamBadge.className = 'settings__badge';
streamBadge.textContent = 'Enabled';
streamCard.appendChild(streamBadge);

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

accountButton.addEventListener('click', async () => {
  if (!supabase) return;
  accountButton.disabled = true;
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) {
    accountButton.disabled = false;
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'auth_signed_out' });
  } catch {}
  await refreshAccount();
});

async function refreshAccount() {
  if (!supabase) {
    accountStatus.textContent = 'Missing Supabase configuration.';
    accountMeta.textContent = 'Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.';
    accountButton.disabled = true;
    return;
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    accountStatus.textContent = 'Signed in';
    accountMeta.textContent = data.session.user?.email || 'Connected';
    accountButton.disabled = false;
  } else {
    accountStatus.textContent = 'Not signed in';
    accountMeta.textContent = 'Open YouTube to sign in.';
    accountButton.disabled = true;
  }
}

void refreshAccount();
