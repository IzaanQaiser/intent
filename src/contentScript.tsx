import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './contentScript.css';
import FullPageGateOverlay from './FullPageGateOverlay';

const CONTAINER_ID = 'intent-read-first-root';

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

  const handleWatchNow = useCallback(() => {
    setIsVisible(false);
    setIsLoading(false);
  }, []);

  const handleReadFirst = useCallback(() => {
    setIsLoading(true);
  }, []);

  const metrics = useMemo(
    () => ({
      level: 3,
      readScore: 1240,
      watchBalanceMinutes: 15
    }),
    []
  );

  if (!videoId) return null;

  return (
    <FullPageGateOverlay
      isVisible={isVisible}
      isLoading={isLoading}
      metrics={metrics}
      quote={quotes[quoteIndex]}
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
