import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import './app.css';

type FeatureWindowRow = {
  user_id: string;
  user_id_raw: string | null;
  window_start: string;
  window_end: string;
  video_opened_count: number;
  summary_generated_count: number;
  summary_latency_ms_total: number;
  summary_latency_ms_count: number;
  read_completed_count: number;
  read_time_ms_total: number;
  read_time_ms_count: number;
  watch_initiated_count: number;
  watch_ended_count: number;
  watch_seconds_total: number;
  watch_time_since_open_ms_total: number;
  watch_time_since_open_ms_count: number;
  negative_balance_count: number;
};

type StreamStateRow = {
  read_score: number;
  watch_balance_minutes: number;
};

type RiskScoreRow = {
  user_id: string;
  user_id_raw: string | null;
  window_start: string;
  window_end: string;
  risk_score: number;
  factors: Record<string, unknown>;
  insight_summary: string | null;
  insight_bullets: string[] | null;
  risk_source: string | null;
  model: string | null;
  scored_at: string;
};

type ActionEventRow = {
  event_type: string;
  occurred_at: string;
};

type DashboardRow = FeatureWindowRow & {
  risk_score: number | null;
  scored_at: string | null;
  insight_summary: string | null;
  insight_bullets: string[] | null;
  risk_source: string | null;
  model: string | null;
};

type LoadState = {
  loading: boolean;
  error: string | null;
  rows: DashboardRow[];
};

const formatNumber = (value: number, maximumFractionDigits = 1) =>
  new Intl.NumberFormat('en-US', {
    maximumFractionDigits
  }).format(value);

const formatWindowLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  });

const formatMinutes = (seconds: number) => formatNumber(seconds / 60, 1);
const formatSigned = (value: number) => (value > 0 ? `+${value}` : `${value}`);
const READ_GAIN_MIN = 5;
const WATCH_COST_MIN = 10;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const AUTO_REFRESH_MS = 5000;
const riskColor = (value: number) => {
  const hue = 170 - value * 140;
  const light = 86 - value * 22;
  return `hsl(${Math.round(hue)}, 45%, ${Math.round(light)}%)`;
};

const normalizeInsightBullets = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

export default function App() {
  const [state, setState] = useState<LoadState>({
    loading: true,
    error: null,
    rows: []
  });
  const [streamState, setStreamState] = useState<StreamStateRow | null>(null);
  const [actionEvents, setActionEvents] = useState<ActionEventRow[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const loadData = useCallback(async () => {
    if (!supabase) {
      setState({
        loading: false,
        error: 'Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
        rows: []
      });
      return;
    }
    if (!authReady) {
      setState((prev) => ({ ...prev, loading: true }));
      return;
    }
    if (!session?.user) {
      setState({
        loading: false,
        error: 'Sign in to view your dashboard.',
        rows: []
      });
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));

    const { data: streamData, error: streamError } = await supabase
      .from('user_state')
      .select('read_score, watch_balance_minutes')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (streamError) {
      console.warn('[dashboard] Failed to load stream_state', streamError.message);
    }
    setStreamState(streamData ?? null);

    const { data: featureData, error: featureError } = await supabase
      .from('feature_windows')
      .select('*')
      .eq('user_id_raw', session.user.id)
      .order('window_start', { ascending: false })
      .limit(200);

    if (featureError) {
      setState({ loading: false, error: featureError.message, rows: [] });
      return;
    }

    const { data: riskData, error: riskError } = await supabase
      .from('risk_scores')
      .select('*')
      .eq('user_id_raw', session.user.id)
      .order('window_start', { ascending: false })
      .limit(200);

    if (riskError) {
      setState({ loading: false, error: riskError.message, rows: [] });
      return;
    }

    const { data: actionData, error: actionError } = await supabase
      .from('action_events')
      .select('event_type, occurred_at')
      .eq('user_id_raw', session.user.id)
      .order('occurred_at', { ascending: false })
      .limit(200);

    if (actionError) {
      console.warn('[dashboard] Failed to load action_events', actionError.message);
      setActionEvents([]);
    } else {
      setActionEvents((actionData as ActionEventRow[] | null) ?? []);
    }

    const riskMap = new Map<string, RiskScoreRow>();
    (riskData as RiskScoreRow[] | null)?.forEach((row) => {
      riskMap.set(`${row.user_id}|${row.window_start}`, row);
    });

    const merged = (featureData as FeatureWindowRow[] | null)?.map((row) => {
      const key = `${row.user_id}|${row.window_start}`;
      const risk = riskMap.get(key);
      return {
        ...row,
        risk_score: risk?.risk_score ?? null,
        scored_at: risk?.scored_at ?? null,
        insight_summary: risk?.insight_summary ?? null,
        insight_bullets: normalizeInsightBullets(risk?.insight_bullets),
        risk_source: risk?.risk_source ?? null,
        model: risk?.model ?? null
      };
    }) ?? [];

    setState({ loading: false, error: null, rows: merged });
  }, [authReady, session]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        void loadData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadData]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadData();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const displayRows = useMemo(() => state.rows, [state.rows]);

  const levelStats = useMemo(() => {
    const readScore = streamState?.read_score ?? 0;
    const level = Math.floor(readScore / 400) + 1;
    const watchBalance = streamState?.watch_balance_minutes ?? 0;
    const levelBase = (level - 1) * 400;
    const levelProgress = Math.max(0, readScore - levelBase);
    const levelPercent = Math.min(100, (levelProgress / 400) * 100);
    const scoreToNext = Math.max(0, level * 400 - readScore);
    return {
      readScore,
      level,
      watchBalance,
      levelProgress,
      levelPercent,
      scoreToNext
    };
  }, [streamState]);

  const currentStreak = useMemo(() => {
    let streak = 0;
    for (const event of actionEvents) {
      if (event.event_type === 'watch_initiated') {
        break;
      }
      if (event.event_type === 'read_completed') {
        streak += 1;
      }
    }
    return streak;
  }, [actionEvents]);

  const sparkBars = useMemo(() => {
    const slice = displayRows.slice(0, 7).reverse();
    const values = slice.map((row) => row.read_completed_count);
    const max = Math.max(1, ...values);
    return values.map((value) => Math.max(10, (value / max) * 100));
  }, [displayRows]);

  const impulseStats = useMemo(() => {
    let totalMs = 0;
    let totalCount = 0;
    const buckets = [0, 0, 0, 0];
    for (const row of displayRows) {
      const count = row.watch_time_since_open_ms_count || 0;
      if (!count) continue;
      const avg = row.watch_time_since_open_ms_total / count;
      totalMs += row.watch_time_since_open_ms_total;
      totalCount += count;
      if (avg < 5000) buckets[0] += count;
      else if (avg < 15000) buckets[1] += count;
      else if (avg < 30000) buckets[2] += count;
      else buckets[3] += count;
    }
    const avgMs = totalCount > 0 ? totalMs / totalCount : null;
    return {
      avgMs,
      buckets
    };
  }, [displayRows]);

  const impulseBuckets = useMemo(() => {
    const labels = ['<5s', '5-15s', '15-30s', '>30s'];
    const max = Math.max(1, ...impulseStats.buckets);
    return labels.map((label, index) => ({
      label,
      count: impulseStats.buckets[index],
      height: Math.max(8, (impulseStats.buckets[index] / max) * 100)
    }));
  }, [impulseStats.buckets]);

  const riskHeatmap = useMemo(() => {
    const grid = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }))
    );
    for (const row of displayRows) {
      if (row.risk_score === null) continue;
      const date = new Date(row.window_start);
      const dayIndex = (date.getUTCDay() + 6) % 7;
      const hour = date.getUTCHours();
      grid[dayIndex][hour].sum += row.risk_score;
      grid[dayIndex][hour].count += 1;
    }
    let max = { value: 0, day: 0, hour: 0 };
    const values = grid.map((row, day) =>
      row.map((cell, hour) => {
        const value = cell.count ? cell.sum / cell.count : 0;
        if (value > max.value) {
          max = { value, day, hour };
        }
        return value;
      })
    );
    return { values, max };
  }, [displayRows]);

  const heatmapFootnote = useMemo(() => {
    if (riskHeatmap.max.value <= 0) {
      return 'Collecting more data to highlight high-risk hours.';
    }
    const dayLabel = DAY_LABELS[riskHeatmap.max.day];
    const hourLabel = `${riskHeatmap.max.hour}:00`;
    return `Highest risk appears around ${dayLabel} ${hourLabel}.`;
  }, [riskHeatmap.max]);

  const latestInsight = useMemo(() => {
    for (const row of displayRows) {
      if (row.insight_summary || (row.insight_bullets && row.insight_bullets.length > 0)) {
        return row;
      }
    }
    return null;
  }, [displayRows]);

  const insightCards = useMemo(() => {
    const cards = [];
    const avgImpulseSeconds = impulseStats.avgMs ? Math.round(impulseStats.avgMs / 1000) : null;
    const peakHour = riskHeatmap.max.value > 0 ? riskHeatmap.max.hour : null;
    const peakDay = riskHeatmap.max.value > 0 ? DAY_LABELS[riskHeatmap.max.day] : null;

    cards.push({
      title: peakHour !== null ? `Peak risk around ${peakDay} ${peakHour}:00` : 'High-risk windows forming',
      evidence: peakHour !== null ? `Highest risk average: ${formatNumber(riskHeatmap.max.value, 2)}.` : 'Collecting more hourly data.',
      suggestion: peakHour !== null ? `Plan a read-first block before ${peakHour}:00.` : 'Run more sessions to calibrate.'
    });
    cards.push({
      title: avgImpulseSeconds !== null ? 'Impulse speed is trending fast' : 'Impulse speed is forming',
      evidence: avgImpulseSeconds !== null ? `Average time to watch: ${avgImpulseSeconds}s.` : 'Waiting for watch timing data.',
      suggestion: 'Add a 10-second pause before Watch Now.'
    });
    cards.push({
      title: 'Balance pressure check-in',
      evidence: `Current watch balance: ${formatSigned(levelStats.watchBalance)} min.`,
      suggestion: 'Complete a read to restore balance.'
    });

    if (latestInsight?.insight_summary) {
      const bullets = latestInsight.insight_bullets ?? [];
      cards.push({
        title: latestInsight.insight_summary,
        evidence: bullets[0] ?? 'AI insight generated from your behavior stream.',
        suggestion: bullets[1] ?? 'Keep the read-first path active.'
      });
    } else {
      cards.push({
        title: 'AI insight incoming',
        evidence: 'Run the scorer to generate personalized insight.',
        suggestion: 'Keep streaming events for richer signals.'
      });
    }

    return cards;
  }, [impulseStats.avgMs, latestInsight, levelStats.watchBalance, riskHeatmap.max]);

  const relapseStats = useMemo(() => {
    const avgOpenToWatch = impulseStats.avgMs ? Math.round(impulseStats.avgMs / 1000) : null;
    const totalWatchMinutes = displayRows.reduce((sum, row) => sum + row.watch_seconds_total / 60, 0);
    const watchSessions = displayRows.reduce((sum, row) => sum + row.watch_initiated_count, 0);
    const avgWatchMinutes = watchSessions > 0 ? totalWatchMinutes / watchSessions : null;
    return { avgOpenToWatch, avgWatchMinutes };
  }, [displayRows, impulseStats.avgMs]);

  const recoveryStats = useMemo(() => {
    let totalReadMs = 0;
    let totalCount = 0;
    for (const row of displayRows) {
      totalReadMs += row.read_time_ms_total;
      totalCount += row.read_time_ms_count;
    }
    const avgHours = totalCount > 0 ? totalReadMs / totalCount / 3600000 : null;
    return { avgHours };
  }, [displayRows]);

  const sessionRows = useMemo(() => {
    return displayRows.slice(0, 5).map((row) => {
      const balanceDelta = row.read_completed_count * READ_GAIN_MIN - row.watch_initiated_count * WATCH_COST_MIN;
      const outcome =
        balanceDelta > 0 ? 'Intentional' : balanceDelta < 0 ? 'Impulsive' : 'Mixed';
      const outcomeKey = outcome.toLowerCase();
      return {
        time: formatWindowLabel(row.window_start),
        context: row.watch_initiated_count > 0 ? 'Watch page' : 'Read-first',
        read: row.read_completed_count > 0 ? 'Yes' : 'No',
        watchMinutes: Math.round(row.watch_seconds_total / 60),
        balanceDelta,
        balanceLabel: formatSigned(balanceDelta),
        outcome,
        outcomeKey
      };
    });
  }, [displayRows]);

  const watchBalanceClass =
    levelStats.watchBalance < 0 ? 'card stat-card stat-card--balance stat-card--debt' : 'card stat-card stat-card--balance';
  const levelPercentLabel = Math.round(levelStats.levelPercent);
  const avgImpulseSeconds = impulseStats.avgMs ? Math.round(impulseStats.avgMs / 1000) : null;
  const recoveryHoursLabel = recoveryStats.avgHours ? formatNumber(recoveryStats.avgHours, 1) : '--';

  return (
    <div className="app">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Intent Analytics</p>
          <h1>Attention, scored in real time.</h1>
          <p className="subtitle">
            Stream events into Confluent, transform them into behavior signals, then score risk
            windows for the dashboard.
          </p>
        </div>
      </header>

      {state.error ? (
        <div className="card error-card">
          <h3>Dashboard offline</h3>
          <p>{state.error}</p>
        </div>
      ) : null}

      <section className="stat-row">
        <div className="card stat-card stat-card--level">
          <div className="stat-header">
            <div className="stat-level-row">
              <div className="stat-stack">
                <p className="stat-label">Level</p>
                <div className="stat-value">{levelStats.level}</div>
              </div>
              <div
                className="stat-ring"
                style={{ '--progress': `${levelStats.levelPercent}` } as React.CSSProperties}
              >
                <span>{levelPercentLabel}%</span>
              </div>
            </div>
            <div className="level-progress">
              <div className="level-progress__title">
                Progress to Level {levelStats.level + 1}
              </div>
              <div className="level-progress__bar">
                <span style={{ width: `${levelStats.levelPercent}%` }} />
              </div>
              <div className="level-progress__meta">
                {levelStats.levelProgress} / 400 points
              </div>
            </div>
          </div>
        </div>
        <div className="card stat-card stat-card--read">
          <p className="stat-label">Read Score</p>
          <div className="stat-value">{levelStats.readScore}</div>
          <div className="stat-spark">
            {sparkBars.map((height, index) => (
              <span key={`spark-${index}`} style={{ height: `${height}%` }} />
            ))}
          </div>
          <div className="read-callout">
            <div className="read-callout__title">Keep Reading to Level Up!</div>
            <div className="read-callout__body">
              Only {levelStats.scoreToNext} more points needed. Read more articles to boost your
              score and unlock new achievements.
            </div>
          </div>
        </div>
        <div className={watchBalanceClass}>
          <p className="stat-label">Watch Balance</p>
          <div className="stat-value">{formatSigned(levelStats.watchBalance)} min</div>
          <p className="stat-meta">{levelStats.watchBalance < 0 ? 'In debt' : 'In surplus'}</p>
        </div>
        <div className="card stat-card">
          <p className="stat-label">Current Read Streak</p>
          <div className="stat-value">{currentStreak}</div>
          <p className="stat-meta">Consecutive reads build your streak, watches break it.</p>
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-header">
          <div>
            <h3>Impulse Speed Distribution</h3>
            <span className="panel-meta">Time from open to watch decision</span>
          </div>
        </div>
        <div className="impulse-grid">
          <div className="impulse-chart">
            {impulseBuckets.map((bucket) => (
              <div key={bucket.label} className="impulse-bar">
                <div style={{ height: `${bucket.height}%` }} />
                <span>{bucket.label}</span>
              </div>
            ))}
          </div>
          <div className="impulse-note">
            Most watch decisions happen in{' '}
            <strong>{avgImpulseSeconds !== null ? `${avgImpulseSeconds}s` : '--'}</strong>
          </div>
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-header">
          <div>
            <h3>Risk &amp; Pattern Analysis</h3>
            <span className="panel-meta">Hour of day x day of week analysis</span>
          </div>
          <div className="toggle-group">
            <button className="toggle toggle--active" type="button">Risk Score</button>
            <button className="toggle" type="button" disabled>Bypass Rate</button>
            <button className="toggle" type="button" disabled>Negative Balance</button>
          </div>
        </div>
        <div className="heatmap">
          <div className="heatmap-header">
            <span />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={`hour-${hour}`}>{hour}</span>
            ))}
          </div>
          {DAY_LABELS.map((label, dayIndex) => (
            <div key={label} className="heatmap-row">
              <span className="heatmap-day">{label}</span>
              {riskHeatmap.values[dayIndex].map((value, hour) => (
                <span
                  key={`${label}-${hour}`}
                  className="heatmap-cell"
                  style={{ backgroundColor: riskColor(value) }}
                  title={`${label} ${hour}:00 - risk ${formatNumber(value, 2)}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="heatmap-footnote">{heatmapFootnote}</div>
      </section>

      <section className="section-heading">
        <h2>Addiction Mechanics</h2>
        <p>Making the habit visible and explainable</p>
      </section>

      <section className="grid-two">
        <div className="card panel">
          <div className="panel-header">
            <h3>Relapse Pattern</h3>
            <span className="panel-meta">What happens when you slip</span>
          </div>
          <div className="flow">
            <div className="flow-step">Video Opened</div>
            <div className="flow-connector">&gt;</div>
            <div className="flow-step">Watch Intent</div>
            <div className="flow-connector">&gt;</div>
            <div className="flow-step flow-step--alert">Negative Balance</div>
          </div>
          <div className="flow-metrics">
            <div className="flow-metric">
              <span>Open -&gt; Watch</span>
              <strong>{relapseStats.avgOpenToWatch !== null ? `${relapseStats.avgOpenToWatch}s` : '--'}</strong>
            </div>
            <div className="flow-metric">
              <span>Watch -&gt; Debt</span>
              <strong>
                {relapseStats.avgWatchMinutes !== null ? `${formatNumber(relapseStats.avgWatchMinutes, 1)} min` : '--'}
              </strong>
            </div>
          </div>
          <p className="panel-footnote">
            Median timing across sessions where watch intent precedes debt.
          </p>
        </div>
        <div className="card panel">
          <div className="panel-header">
            <h3>Recovery Profile</h3>
            <span className="panel-meta">How quickly you bounce back</span>
          </div>
          <div className="recovery-chart">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((label) => (
              <div key={label} className="recovery-column">
                <span />
                <small>{label}</small>
              </div>
            ))}
          </div>
          <div className="recovery-note">
            <strong>Median Recovery: {recoveryHoursLabel} hours</strong>
            <span>Estimated time to restore balance after debt.</span>
          </div>
        </div>
      </section>

      <section className="section-heading">
        <h2>Insights</h2>
        <p>Data-backed guidance, no judgment</p>
      </section>

      <section className="insight-grid">
        {insightCards.map((card, index) => (
          <div key={`insight-${index}`} className="card insight-tile">
            <h3>{card.title}</h3>
            <div className="insight-block">
              <span>Evidence</span>
              <p>{card.evidence}</p>
            </div>
            <div className="insight-block insight-block--suggestion">
              <span>Suggestion</span>
              <p>{card.suggestion}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="card table-card">
        <div className="panel-header">
          <h3>Session Log</h3>
          <span className="panel-meta">Last 5 sessions with detailed metrics</span>
        </div>
        <div className="table session-table">
          <div className="table-row header">
            <span>Time</span>
            <span>Context</span>
            <span>Read</span>
            <span>Watch (min)</span>
            <span>Balance +/-</span>
            <span>Outcome</span>
          </div>
          {sessionRows.map((row) => (
            <div className="table-row" key={`session-${row.time}`}>
              <span>{row.time}</span>
              <span>{row.context}</span>
              <span>{row.read}</span>
              <span>{row.watchMinutes}</span>
              <span className={row.balanceDelta < 0 ? 'negative' : 'positive'}>{row.balanceLabel}</span>
              <span className={`pill outcome outcome-${row.outcomeKey}`}>{row.outcome}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
