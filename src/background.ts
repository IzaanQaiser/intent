function broadcastAuthEvent(type: 'auth_complete' | 'auth_signed_out') {
  chrome.tabs.query({ url: ['https://www.youtube.com/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type });
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'oauth_start' && message.url) {
    chrome.identity.launchWebAuthFlow({ url: message.url, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'Auth failed' });
        return;
      }
      chrome.tabs.create({ url: redirectUrl }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message?.type === 'auth_complete' || message?.type === 'auth_signed_out') {
    broadcastAuthEvent(message.type);
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: 'Unknown message' });
  return false;
});
