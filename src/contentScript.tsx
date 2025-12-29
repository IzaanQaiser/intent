import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Session } from '@supabase/supabase-js';
import './contentScript.css';
import FullPageGateOverlay from './FullPageGateOverlay';
import { supabase } from './supabaseClient';

const CONTAINER_ID = 'intent-read-first-root';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';
const READ_GAIN_SCORE = 40;
const READ_GAIN_MIN = 5;
const WATCH_COST_MIN = 10;
const SCORE_PENALTY = 10;
const SUMMARY_WORDS_PER_MINUTE = 200;
const MIN_CLAIM_SECONDS = 15;

const computeLevel = (readScore: number) => Math.floor(readScore / 400) + 1;
const VIDEO_ROUND_UP_THRESHOLD_SEC = 30;

type Metrics = {
  level: number;
  readScore: number;
  watchBalanceMinutes: number;
};

type SummaryData = {
  title: string;
  summary: string;
  keyPoints: string[];
  readingTimeMinutes: number;
  source?: string;
  language?: string;
};

function countWords(text: string) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function estimateSummaryReadSeconds(summary: SummaryData | null) {
  if (!summary) return 0;
  const baseWords = countWords(summary.summary);
  const keyPointWords = summary.keyPoints?.reduce((total, point) => total + countWords(point), 0) ?? 0;
  const totalWords = baseWords + keyPointWords;
  if (totalWords === 0) return 0;
  const seconds = Math.round((totalWords / SUMMARY_WORDS_PER_MINUTE) * 60);
  return Math.max(MIN_CLAIM_SECONDS, seconds);
}

function formatCountdown(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}


type ApiResponse<T> =
  | { ok: true; status: number; body: T | null }
  | { ok: false; status?: number; error?: string; body?: unknown };

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

function formatDuration(seconds: number) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = hours > 0 ? [hours, minutes, secs] : [minutes, secs];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

function getVideoTitle() {
  return (
    document.querySelector('h1 yt-formatted-string')?.textContent?.trim() ||
    document.title.replace(/\s+-\s+YouTube$/i, '').trim() ||
    'Untitled video'
  );
}

function getVideoDurationSeconds() {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video || !Number.isFinite(video.duration)) {
    return null;
  }
  return video.duration;
}

function getReadScoreGain(watchCostMinutes: number) {
  if (!Number.isFinite(watchCostMinutes)) {
    return READ_GAIN_SCORE;
  }
  return Math.round((watchCostMinutes * 2) / 10) * 10;
}

function getRoundedMinutesFromDuration(durationSeconds: number | null) {
  if (!durationSeconds || !Number.isFinite(durationSeconds)) {
    return WATCH_COST_MIN;
  }
  const duration = Math.max(0, durationSeconds);
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  if (seconds >= VIDEO_ROUND_UP_THRESHOLD_SEC) {
    return minutes + 1;
  }
  return minutes;
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
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [isClaimingRewards, setIsClaimingRewards] = useState(false);
  const [hasClaimedRewards, setHasClaimedRewards] = useState(false);
  const [claimSecondsRemaining, setClaimSecondsRemaining] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [watchCostMinutes, setWatchCostMinutes] = useState(WATCH_COST_MIN);
  const latestVideoId = useRef<string | null>(videoId);
  const transcriptLoggedRef = useRef<string | null>(null);
  const claimDeadlineRef = useRef<number | null>(null);
  const loadStateRef = useRef<() => Promise<boolean>>(async () => false);
  const readGainMinutes = useMemo(() => watchCostMinutes / 2, [watchCostMinutes]);
  const readScoreGain = useMemo(() => getReadScoreGain(watchCostMinutes), [watchCostMinutes]);
  const watchScorePenalty = readScoreGain;
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

  const requestFromBackground = useCallback(
    async <T,>(url: string, init?: RequestInit): Promise<ApiResponse<T>> =>
      new Promise((resolve) => {
        if (!chrome?.runtime?.sendMessage) {
          resolve({ ok: false, error: 'Extension runtime unavailable.' });
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: 'api_request', url, init }, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response as ApiResponse<T>);
          });
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    []
  );


  const getStateRowFromSupabase = useCallback(async () => {
    if (!supabase) {
      return { ok: false, error: 'Supabase client not configured.' } as const;
    }
    const userId = session?.user?.id;
    if (!userId) {
      return { ok: false, error: 'Supabase session unavailable.' } as const;
    }
    const { data: existing, error } = await supabase
      .from('user_state')
      .select('user_id, read_score, watch_balance_minutes')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      return { ok: false, error: error.message } as const;
    }
    if (existing) {
      return { ok: true, data: existing } as const;
    }
    const { data: inserted, error: insertError } = await supabase
      .from('user_state')
      .insert({ user_id: userId, read_score: 0, watch_balance_minutes: 0 })
      .select('user_id, read_score, watch_balance_minutes')
      .single();
    if (insertError || !inserted) {
      return {
        ok: false,
        error: insertError?.message || 'Failed to create watch balance state.'
      } as const;
    }
    return { ok: true, data: inserted } as const;
  }, [session, supabase]);

  const loadStateFromSupabase = useCallback(async () => {
    const result = await getStateRowFromSupabase();
    if (!result.ok) {
      return { ok: false, error: result.error } as const;
    }
    const data = result.data;
    return {
      ok: true,
      data: {
        level: computeLevel(data.read_score),
        readScore: data.read_score,
        watchBalanceMinutes: data.watch_balance_minutes
      }
    } as const;
  }, [getStateRowFromSupabase]);

  useEffect(() => {
    if (videoId && videoId !== latestVideoId.current) {
      latestVideoId.current = videoId;
      setIsVisible(true);
      setIsLoading(false);
      setWatchCostMinutes(WATCH_COST_MIN);
      setSummary(null);
      setHasClaimedRewards(false);
      setIsClaimingRewards(false);
      setClaimSecondsRemaining(0);
      claimDeadlineRef.current = null;
      transcriptLoggedRef.current = null;
    }
  }, [videoId]);

  useEffect(() => {
    if (!summary) {
      setClaimSecondsRemaining(0);
      claimDeadlineRef.current = null;
      return;
    }
    const seconds = estimateSummaryReadSeconds(summary);
    const deadline = Date.now() + seconds * 1000;
    claimDeadlineRef.current = deadline;
    setClaimSecondsRemaining(seconds);
    if (seconds === 0) return;

    const intervalId = window.setInterval(() => {
      if (!claimDeadlineRef.current) return;
      const remainingMs = claimDeadlineRef.current - Date.now();
      const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      setClaimSecondsRemaining(remainingSeconds);
      if (remainingSeconds <= 0) {
        window.clearInterval(intervalId);
      }
    }, 500);

    return () => window.clearInterval(intervalId);
  }, [summary]);

  useEffect(() => {
    if (!isVisible || !videoId) return;
    let currentVideo: HTMLVideoElement | null = null;

    const updateDuration = () => {
      const duration = currentVideo ? currentVideo.duration : null;
      setWatchCostMinutes(getRoundedMinutesFromDuration(duration));
    };

    const bindVideo = () => {
      const nextVideo = document.querySelector<HTMLVideoElement>('video');
      if (!nextVideo) {
        updateDuration();
        return;
      }
      if (currentVideo && currentVideo !== nextVideo) {
        currentVideo.removeEventListener('loadedmetadata', updateDuration);
        currentVideo.removeEventListener('durationchange', updateDuration);
      }
      currentVideo = nextVideo;
      updateDuration();
      currentVideo.addEventListener('loadedmetadata', updateDuration);
      currentVideo.addEventListener('durationchange', updateDuration);
    };

    bindVideo();
    const observer = new MutationObserver(bindVideo);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (currentVideo) {
        currentVideo.removeEventListener('loadedmetadata', updateDuration);
        currentVideo.removeEventListener('durationchange', updateDuration);
      }
    };
  }, [isVisible, videoId]);

  const loadState = useCallback(async () => {
    if (!session) return false;
    const supabaseState = await loadStateFromSupabase();
    if (supabaseState.ok && supabaseState.data) {
      setMetrics(supabaseState.data);
      return true;
    }
    const response = await requestFromBackground<Metrics>(`${API_BASE_URL}/state`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok || !response.body) {
      return false;
    }
    const data = response.body;
    setMetrics({
      level: data.level,
      readScore: data.readScore,
      watchBalanceMinutes: data.watchBalanceMinutes
    });
    return true;
  }, [session, loadStateFromSupabase, requestFromBackground]);

  useEffect(() => {
    loadStateRef.current = loadState;
  }, [loadState]);

  const applyEventWithSupabase = useCallback(
    async (type: string, data?: Record<string, unknown>) => {
      if (!supabase) {
        return { ok: false, error: 'Supabase client not configured.' } as const;
      }
      const userId = session?.user?.id;
      if (!userId) {
        return { ok: false, error: 'Supabase session unavailable.' } as const;
      }

      let deltaScore = 0;
      let deltaMinutes = 0;

      switch (type) {
        case 'read_completed':
          deltaScore += typeof data?.score === 'number' ? data.score : READ_GAIN_SCORE;
          deltaMinutes += typeof data?.minutes === 'number' ? data.minutes : READ_GAIN_MIN;
          break;
        case 'watch_initiated': {
          const minutes = typeof data?.minutes === 'number' ? data.minutes : WATCH_COST_MIN;
          deltaMinutes -= minutes;
          const score = typeof data?.score === 'number' ? data.score : 0;
          deltaScore -= score;
          break;
        }
        case 'session_end': {
          const state = await getStateRowFromSupabase();
          if (!state.ok || !state.data) {
            return { ok: false, error: state.error || 'Unable to load state.' } as const;
          }
          if (state.data.watch_balance_minutes < 0) {
            deltaScore -= SCORE_PENALTY;
          }
          break;
        }
        default:
          return { ok: true, data: null } as const;
      }

      const currentState = await getStateRowFromSupabase();
      if (!currentState.ok || !currentState.data) {
        return { ok: false, error: currentState.error || 'Unable to load state.' } as const;
      }
      const nextScore = currentState.data.read_score + deltaScore;
      const nextBalance = currentState.data.watch_balance_minutes + deltaMinutes;
      const { error } = await supabase
        .from('user_state')
        .update({
          read_score: nextScore,
          watch_balance_minutes: nextBalance,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);
      if (error) {
        return { ok: false, error: error.message } as const;
      }
      return {
        ok: true,
        data: {
          level: computeLevel(nextScore),
          readScore: nextScore,
          watchBalanceMinutes: nextBalance
        }
      } as const;
    },
    [session, getStateRowFromSupabase, supabase]
  );

  const sendEvent = useCallback(
    async (type: string, data?: Record<string, unknown>) => {
      if (!session) return null;
      const supabaseEvent = await applyEventWithSupabase(type, data);
      if (supabaseEvent.ok) {
        return supabaseEvent.data ?? null;
      }
      const response = await requestFromBackground<Metrics>(`${API_BASE_URL}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ type, data })
      });
      if (!response.ok) {
        return null;
      }
      return response.body ?? null;
    },
    [session, applyEventWithSupabase, requestFromBackground]
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
            void loadStateRef.current();
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
  }, [supabase]);

  useEffect(() => {
    if (!session) {
      setMetrics(null);
      setSummary(null);
      setHasClaimedRewards(false);
      setIsClaimingRewards(false);
      setClaimSecondsRemaining(0);
      claimDeadlineRef.current = null;
    }
  }, [session]);

  useEffect(() => {
    if (!supabase) {
      setAuthError('Missing Supabase configuration.');
    } else {
      setAuthError(null);
    }
  }, []);

  useEffect(() => {
    if (!videoId || !session) return;
    let attempts = 0;
    let retryId: number | null = null;
    let cancelled = false;

    const syncState = async () => {
      attempts += 1;
      const ok = await loadState();
      if (!ok && !cancelled && attempts < 3) {
        retryId = window.setTimeout(syncState, 1000);
      }
    };

    void syncState();
    void sendEvent('video_opened', { videoId });
    return () => {
      cancelled = true;
      if (retryId !== null) {
        window.clearTimeout(retryId);
      }
    };
  }, [videoId, session, loadState, sendEvent]);

  useEffect(() => {
    if (!videoId || !isVisible || !session || !metrics) return;
    if (transcriptLoggedRef.current === videoId) return;
    transcriptLoggedRef.current = videoId;

    const fetchTranscript = async () => {
      const response = await requestFromBackground<{ transcript?: string; source?: string }>(
        `${API_BASE_URL}/transcript`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId })
        }
      );
      if (response.ok && response.body?.transcript) {
        const source = response.body.source ? ` (${response.body.source})` : '';
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const title =
          document.querySelector('h1 yt-formatted-string')?.textContent?.trim() ||
          document.title.replace(/\s+-\s+YouTube$/i, '').trim() ||
          'Unknown';
        const video = document.querySelector<HTMLVideoElement>('video');
        const length =
          video && Number.isFinite(video.duration) ? formatDuration(video.duration) : 'Unknown';
        console.log(
          `[Intent]\nURL: ${url}\nLENGTH: ${length}\nTITLE: ${title}\nTRANSCRIPT:${source}\n${response.body.transcript}`
        );
      } else {
        console.warn(`[Intent] Transcript unavailable for ${videoId}.`);
      }
    };

    void fetchTranscript();
  }, [videoId, isVisible, session, metrics, requestFromBackground]);

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
    const updated = await sendEvent('watch_initiated', {
      minutes: watchCostMinutes,
      videoId,
      score: watchScorePenalty
    });
    if (updated) {
      setMetrics({
        level: updated.level,
        readScore: updated.readScore,
        watchBalanceMinutes: updated.watchBalanceMinutes
      });
    } else {
      await loadState();
    }
  }, [sendEvent, videoId, session, loadState, watchCostMinutes, watchScorePenalty]);

  const handleReadFirst = useCallback(async () => {
    if (!session) return;
    setIsLoading(true);
    setSummary(null);
    setHasClaimedRewards(false);
    setIsClaimingRewards(false);
    const title = getVideoTitle();
    const durationSeconds = getVideoDurationSeconds();

    const summaryResponse = await requestFromBackground<SummaryData>(`${API_BASE_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        title,
        durationSeconds
      })
    });

    if (summaryResponse.ok && summaryResponse.body?.summary) {
      setSummary(summaryResponse.body);
    } else {
      console.warn('[Intent] Summary unavailable', {
        videoId,
        status: summaryResponse.status,
        error: summaryResponse.error,
        body: summaryResponse.body
      });
    }
    setIsLoading(false);
  }, [videoId, session, requestFromBackground]);

  const handleClaimRewards = useCallback(async () => {
    if (!session || !summary || isClaimingRewards || hasClaimedRewards || claimSecondsRemaining > 0) return;
    setIsClaimingRewards(true);
    const updated = await sendEvent('read_completed', {
      videoId,
      minutes: readGainMinutes,
      score: readScoreGain
    });
    if (updated) {
      setMetrics({
        level: updated.level,
        readScore: updated.readScore,
        watchBalanceMinutes: updated.watchBalanceMinutes
      });
    } else {
      await loadState();
    }
    setHasClaimedRewards(true);
    setIsClaimingRewards(false);
    window.location.assign('https://www.youtube.com/');
  }, [
    session,
    summary,
    isClaimingRewards,
    hasClaimedRewards,
    claimSecondsRemaining,
    sendEvent,
    videoId,
    readGainMinutes,
    readScoreGain,
    loadState
  ]);

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
    try {
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
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Extension runtime unavailable.');
      setAuthInProgress(false);
    }
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
      watchCostMinutes={watchCostMinutes}
      readGainMinutes={readGainMinutes}
      readScoreGain={readScoreGain}
      watchScorePenalty={watchScorePenalty}
      summary={summary}
      isClaimingRewards={isClaimingRewards}
      hasClaimedRewards={hasClaimedRewards}
      claimSecondsRemaining={claimSecondsRemaining}
      claimCountdownLabel={formatCountdown(claimSecondsRemaining)}
      quote={quotes[quoteIndex]}
      onLogin={handleLogin}
      onReadFirst={handleReadFirst}
      onWatchNow={handleWatchNow}
      onClaimRewards={handleClaimRewards}
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
