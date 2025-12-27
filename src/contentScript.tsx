import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Session } from '@supabase/supabase-js';
import './contentScript.css';
import FullPageGateOverlay from './FullPageGateOverlay';
import { supabase } from './supabaseClient';

const CONTAINER_ID = 'intent-read-first-root';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';

type Metrics = {
  level: number;
  readScore: number;
  watchBalanceMinutes: number;
};

function getVideoId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== '/watch') return null;
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

function pauseVideo() {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (video && !video.paused) {
    video.pause();
  }
  if (video) {
    video.autoplay = false;
    return;
  }
  const button = document.querySelector<HTMLButtonElement>('.ytp-play-button');
  if (button && button.getAttribute('aria-label')?.toLowerCase().includes('pause')) {
    button.click();
  }
}

function useVideoId() {
  const [videoId, setVideoId] = useState(() => getVideoId(window.location.href));

  useEffect(() => {
    const notify = () => setVideoId(getVideoId(window.location.href));

    const pushState = history.pushState;
    const replaceState = history.replaceState;

    history.pushState = function (...args) {
      pushState.apply(this, args);
      notify();
    };
    history.replaceState = function (...args) {
      replaceState.apply(this, args);
      notify();
    };

    window.addEventListener('popstate', notify);

    const observer = new MutationObserver(notify);
    observer.observe(document.body, { childList: true, subtree: true });

    const interval = window.setInterval(notify, 1000);

    return () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener('popstate', notify);
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, []);

  return videoId;
}

function OverlayApp() {
  const videoId = useVideoId();
  const [isVisible, setIsVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInProgress, setAuthInProgress] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({
    level: 1,
    readScore: 0,
    watchBalanceMinutes: 0
  });
  const [session, setSession] = useState<Session | null>(null);
  const latestVideoId = useRef<string | null>(videoId);
  const quotes = useMemo(
    () => [
      'It is not enough to be busy; so are the ants. The question is: What are we busy about? — Henry David Thoreau',
      'The successful warrior is the average man, with laser-like focus. — Bruce Lee',
      'Concentrate all your thoughts upon the work in hand. — Alexander Graham Bell',
      'Simplicity is the ultimate sophistication. — Leonardo da Vinci',
      'A well-spent day brings happy sleep. — Leonardo da Vinci',
      'Your focus determines your reality. — George Lucas'
    ],
    []
  );

  useEffect(() => {
    if (videoId && videoId !== latestVideoId.current) {
      latestVideoId.current = videoId;
      setIsVisible(true);
      setIsLoading(false);
    }
  }, [videoId]);

  const loadState = useCallback(async () => {
    if (!session) return;
    const response = await fetch(`${API_BASE_URL}/state`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok) return;
    const data = await response.json();
    setMetrics({
      level: data.level,
      readScore: data.readScore,
      watchBalanceMinutes: data.watchBalanceMinutes
    });
  }, [session]);

  const sendEvent = useCallback(
    async (type: string, data?: Record<string, unknown>) => {
      if (!session) return null;
      const response = await fetch(`${API_BASE_URL}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ type, data })
      });
      if (!response.ok) return null;
      return response.json();
    },
    [session]
  );

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        setAuthInProgress(false);
      }
    });
    const handleMessage = (message: { type?: string }) => {
      if (message?.type === 'auth_complete') {
        supabase.auth.getSession().then(({ data }) => {
          setSession(data.session);
          if (data.session) {
            void loadState();
          }
        });
        setAuthInProgress(false);
      }
      if (message?.type === 'auth_signed_out') {
        setSession(null);
        setAuthInProgress(false);
        setIsVisible(true);
        setIsLoading(false);
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      listener.subscription.unsubscribe();
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, [supabase, loadState]);

  useEffect(() => {
    if (!supabase) {
      setAuthError('Missing Supabase configuration.');
    } else {
      setAuthError(null);
    }
  }, []);

  useEffect(() => {
    if (!videoId || !session) return;
    void loadState();
    void sendEvent('video_opened', { videoId });
  }, [videoId, session, loadState, sendEvent]);

  useEffect(() => {
    if (!isVisible) return;
    setQuoteIndex((prev) => (prev + 1) % quotes.length);
  }, [isVisible, quotes.length]);

  useEffect(() => {
    if (!isVisible) return;
    let currentVideo: HTMLVideoElement | null = null;

    const handlePlay = () => {
      currentVideo?.pause();
    };

    const bindVideo = () => {
      const nextVideo = document.querySelector<HTMLVideoElement>('video');
      if (!nextVideo) {
        pauseVideo();
        return;
      }
      if (currentVideo && currentVideo !== nextVideo) {
        currentVideo.removeEventListener('play', handlePlay);
        currentVideo.removeEventListener('playing', handlePlay);
      }
      currentVideo = nextVideo;
      currentVideo.autoplay = false;
      currentVideo.addEventListener('play', handlePlay);
      currentVideo.addEventListener('playing', handlePlay);
      currentVideo.pause();
    };

    bindVideo();
    const observer = new MutationObserver(bindVideo);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (currentVideo) {
        currentVideo.removeEventListener('play', handlePlay);
        currentVideo.removeEventListener('playing', handlePlay);
      }
    };
  }, [isVisible, videoId]);

  const handleWatchNow = useCallback(async () => {
    if (!session) return;
    setIsVisible(false);
    setIsLoading(false);
    const updated = await sendEvent('watch_initiated', { minutes: 10, videoId });
    if (updated) {
      setMetrics({
        level: updated.level,
        readScore: updated.readScore,
        watchBalanceMinutes: updated.watchBalanceMinutes
      });
    }
  }, [sendEvent, videoId, session]);

  const handleReadFirst = useCallback(async () => {
    if (!session) return;
    setIsLoading(true);
    const updated = await sendEvent('read_completed', { videoId });
    if (updated) {
      setMetrics({
        level: updated.level,
        readScore: updated.readScore,
        watchBalanceMinutes: updated.watchBalanceMinutes
      });
    }
  }, [sendEvent, videoId, session]);

  const handleLogin = useCallback(async () => {
    if (!supabase) {
      setAuthError('Missing Supabase configuration.');
      return;
    }
    setAuthInProgress(true);
    const redirectTo = chrome.runtime?.getURL('auth.html');
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: redirectTo ? { redirectTo, skipBrowserRedirect: true } : { skipBrowserRedirect: true }
    });
    if (error || !data?.url) {
      setAuthError(error?.message || 'Failed to start sign-in.');
      setAuthInProgress(false);
      return;
    }
    chrome.runtime.sendMessage({ type: 'oauth_start', url: data.url }, (response) => {
      if (chrome.runtime.lastError) {
        setAuthError(chrome.runtime.lastError.message);
        setAuthInProgress(false);
        return;
      }
      if (!response?.ok) {
        setAuthError(response?.error || 'OAuth failed.');
        setAuthInProgress(false);
      }
    });
  }, [supabase]);

  if (!videoId) return null;

  return (
    <FullPageGateOverlay
      isVisible={isVisible}
      isLoading={isLoading}
      isAuthenticated={Boolean(session)}
      authError={authError}
      authInProgress={authInProgress}
      metrics={metrics}
      quote={quotes[quoteIndex]}
      onLogin={handleLogin}
      onReadFirst={handleReadFirst}
      onWatchNow={handleWatchNow}
    />
  );
}

function mountOverlay() {
  if (document.getElementById(CONTAINER_ID)) return;

  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <OverlayApp />
    </React.StrictMode>
  );
}

mountOverlay();
