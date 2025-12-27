import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type Metrics = {
  level: number;
  readScore: number;
  watchBalanceMinutes: number;
};

type FullPageGateOverlayProps = {
  isVisible: boolean;
  isLoading: boolean;
  metrics: Metrics;
  quote: string;
  isAuthenticated: boolean;
  authError: string | null;
  authInProgress: boolean;
  onLogin: () => void;
  onReadFirst: () => void;
  onWatchNow: () => void;
};

const READ_GAIN_SCORE = 40;
const READ_GAIN_MIN = 5;
const WATCH_COST_MIN = 10;
const SCORE_PENALTY = 10;

export default function FullPageGateOverlay({
  isVisible,
  isLoading,
  metrics,
  quote,
  isAuthenticated,
  authError,
  authInProgress,
  onLogin,
  onReadFirst,
  onWatchNow
}: FullPageGateOverlayProps) {
  if (!isVisible) return null;

  const [holdProgress, setHoldProgress] = useState(0);
  const [buttonWidth, setButtonWidth] = useState(0);
  const [labelMetrics, setLabelMetrics] = useState({ left: 0, width: 0 });
  const holdStartRef = useRef<number | null>(null);
  const holdFrameRef = useRef<number | null>(null);
  const holdTriggeredRef = useRef(false);
  const releaseFrameRef = useRef<number | null>(null);
  const progressRef = useRef(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const HOLD_DURATION_MS = 5000;
  const BOOST_DURATION_MS = 120;
  const RELEASE_DURATION_MS = 140;

  const stopHold = useCallback(() => {
    if (holdFrameRef.current !== null) {
      cancelAnimationFrame(holdFrameRef.current);
      holdFrameRef.current = null;
    }
    if (releaseFrameRef.current !== null) {
      cancelAnimationFrame(releaseFrameRef.current);
      releaseFrameRef.current = null;
    }
    holdStartRef.current = null;
    holdTriggeredRef.current = false;
    const startProgress = progressRef.current;
    if (startProgress <= 0) {
      setHoldProgress(0);
      return;
    }
    const releaseStart = performance.now();
    const releaseTick = (now: number) => {
      const elapsed = now - releaseStart;
      const t = Math.min(elapsed / RELEASE_DURATION_MS, 1);
      const nextProgress = startProgress * (1 - t);
      setHoldProgress(nextProgress);
      if (t >= 1) {
        releaseFrameRef.current = null;
        return;
      }
      releaseFrameRef.current = requestAnimationFrame(releaseTick);
    };
    releaseFrameRef.current = requestAnimationFrame(releaseTick);
  }, []);

  const startHold = useCallback(() => {
    const now = performance.now();
    holdStartRef.current = now;
    holdTriggeredRef.current = false;
    if (releaseFrameRef.current !== null) {
      cancelAnimationFrame(releaseFrameRef.current);
      releaseFrameRef.current = null;
    }
    setHoldProgress(0);

    const tick = (now: number) => {
      if (holdStartRef.current === null) return;
      const elapsed = now - holdStartRef.current;
      let progress = 0;
      if (elapsed <= BOOST_DURATION_MS) {
        progress = (elapsed / BOOST_DURATION_MS) * 0.1;
      } else {
        const remainingElapsed = elapsed - BOOST_DURATION_MS;
        const remainingDuration = HOLD_DURATION_MS - BOOST_DURATION_MS;
        progress = 0.1 + Math.min(remainingElapsed / remainingDuration, 1) * 0.9;
      }
      setHoldProgress(progress);
      if (progress >= 1 && !holdTriggeredRef.current) {
        holdTriggeredRef.current = true;
        onWatchNow();
        stopHold();
        return;
      }
      holdFrameRef.current = requestAnimationFrame(tick);
    };

    holdFrameRef.current = requestAnimationFrame(tick);
  }, [onWatchNow, stopHold]);

  useEffect(() => {
    progressRef.current = holdProgress;
  }, [holdProgress]);

  useEffect(() => {
    if (!isVisible) stopHold();
  }, [isVisible, stopHold]);

  useLayoutEffect(() => {
    if (!isAuthenticated) return;
    const measure = () => {
      const button = buttonRef.current;
      const label = labelRef.current;
      if (!button || !label) return;
      const buttonRect = button.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      setButtonWidth(buttonRect.width);
      setLabelMetrics({
        left: Math.max(0, labelRect.left - buttonRect.left),
        width: labelRect.width
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    if (buttonRef.current) observer.observe(buttonRef.current);
    if (labelRef.current) observer.observe(labelRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isAuthenticated]);

  const currentLevel = Math.floor(metrics.readScore / 400) + 1;
  const levelAfterRead = Math.floor((metrics.readScore + READ_GAIN_SCORE) / 400) + 1;
  const balanceAfterWatch = metrics.watchBalanceMinutes - WATCH_COST_MIN;
  const afterWatchScore = balanceAfterWatch < 0 ? metrics.readScore - SCORE_PENALTY : metrics.readScore;
  const levelAfterPenalty = Math.floor(afterWatchScore / 400) + 1;
  const levelIndicator = levelAfterRead > currentLevel ? '↑' : '=';
  const balanceLabel =
    balanceAfterWatch >= 0 ? `${balanceAfterWatch} min` : `-${Math.abs(balanceAfterWatch)} min`;
  const fillWidth = buttonWidth * holdProgress;
  const labelFillWidth = Math.max(
    0,
    Math.min(labelMetrics.width, fillWidth - labelMetrics.left)
  );
  const labelFillPx = Math.max(0, labelFillWidth);

  return (
    <div className="intent-overlay">
      <div className="intent-overlay__panel">
        <div className="intent-overlay__title">Read First</div>
        <div className="intent-overlay__subtitle">{quote}</div>
        {isAuthenticated ? (
          <div className="intent-overlay__metrics">
          <div className="intent-overlay__metric">
            <span className="intent-overlay__metric-label">Level</span>
            <span className="intent-overlay__metric-value">{currentLevel}</span>
          </div>
          <div className="intent-overlay__metric">
            <span className="intent-overlay__metric-label">Read Score</span>
            <span className="intent-overlay__metric-value">{metrics.readScore}</span>
          </div>
          <div className="intent-overlay__metric">
            <span className="intent-overlay__metric-label">Watch Balance</span>
            <span className="intent-overlay__metric-value">
              {metrics.watchBalanceMinutes} min
            </span>
          </div>
        </div>
        ) : (
          <div className="intent-overlay__auth">
            <div className="intent-overlay__auth-title">Sign in to continue</div>
            <div className="intent-overlay__auth-copy">
              Your score and balance sync to your account. Sign in to proceed.
            </div>
            <button
              className="intent-overlay__auth-button"
              type="button"
              onClick={onLogin}
              disabled={authInProgress}
            >
              {authInProgress ? 'Authenticating…' : 'Sign in with Google'}
            </button>
          </div>
        )}
        {isAuthenticated ? (
          <>
            <div className="intent-overlay__choice">
              <div className="intent-overlay__choice-title">Your Choice</div>
              <div className="intent-overlay__choice-grid">
                <div className="intent-overlay__choice-card">
                  <div className="intent-overlay__choice-header">Read Instead</div>
                  <div className="intent-overlay__choice-chips">
                    <span className="intent-overlay__chip">Score +{READ_GAIN_SCORE}</span>
                    <span className="intent-overlay__chip">Watch Balance +{READ_GAIN_MIN}m</span>
                    <span className="intent-overlay__chip">
                      Level {levelAfterRead} {levelIndicator}
                    </span>
                  </div>
                  <div className="intent-overlay__choice-note">Reading restores progress.</div>
                </div>
                <div className="intent-overlay__choice-card intent-overlay__choice-card--watch">
                  <div className="intent-overlay__choice-header">Watch Now</div>
                  <div className="intent-overlay__choice-chips">
                    <span className="intent-overlay__chip intent-overlay__chip--warn">
                      Watch Balance -{WATCH_COST_MIN}m
                    </span>
                    <span className="intent-overlay__chip">New Watch Balance {balanceLabel}</span>
                  </div>
                  {balanceAfterWatch < 0 ? (
                    <>
                      <div className="intent-overlay__choice-subline">
                        Score penalty -{SCORE_PENALTY} (attention debt)
                      </div>
                      <div className="intent-overlay__choice-subline">
                        Level progress paused while negative
                      </div>
                      {levelAfterPenalty < currentLevel ? (
                        <div className="intent-overlay__choice-warning">
                          ⚠️ Risk: Level down to {levelAfterPenalty}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="intent-overlay__choice-subline">
                      No score penalty (balance stays non-negative)
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="intent-overlay__actions">
              <button
                className="intent-overlay__primary"
                type="button"
                onClick={onReadFirst}
                disabled={isLoading}
              >
                {isLoading ? 'Generating summary…' : 'Read Instead'}
              </button>
              <button
                className="intent-overlay__secondary"
                type="button"
                onPointerDown={startHold}
                onPointerUp={stopHold}
                onPointerLeave={stopHold}
                onPointerCancel={stopHold}
                ref={buttonRef}
              >
                <span
                  className="intent-overlay__hold-fill"
                  style={{ transform: `scaleX(${holdProgress})` }}
                />
                <span className="intent-overlay__button-label intent-overlay__button-label--progress">
                  <span ref={labelRef} className="intent-overlay__button-label-base">
                    Watch Now
                  </span>
                  <span
                    className="intent-overlay__button-label-fill"
                    style={{ ['--label-fill-px' as string]: `${labelFillPx}px` }}
                  >
                    Watch Now
                  </span>
                </span>
              </button>
            </div>
            {isLoading ? (
              <div className="intent-overlay__loading">
                Preparing a focused summary and key points…
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
