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
  id: number;
  event_type: string;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
};

type DashboardRow = FeatureWindowRow & {
  risk_score: number | null;
  scored_at: string | null;
  insight_summary: string | null;
  insight_bullets: string[] | null;
  risk_source: string | null;
  model: string | null;
};

type InsightCard = {
  title: string;
  evidence: string;
  weakness: string;
  action: string;
};

type FailsafeSetting = {
  label: string;
  value: string;
};

type FailsafeRow = {
  id: string;
  name: string;
  active: boolean;
  enabled: boolean;
  reason: string;
  action: string;
  affects: string;
  effectiveness: string;
  settings: FailsafeSetting[];
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

const formatPercent = (value: number, maximumFractionDigits = 0) =>
  `${formatNumber(value * 100, maximumFractionDigits)}%`;

const formatHourLabel = (hour: number) => {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}${suffix}`;
};

const formatDateShort = (date: Date) =>
  date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });

const formatWindowCount = (count: number) => `${count} window${count === 1 ? '' : 's'}`;

const formatWindowLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  });

const formatEventLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: 'numeric'
  });

const formatMinutes = (seconds: number) => formatNumber(seconds / 60, 1);
const formatSigned = (value: number) => (value > 0 ? `+${value}` : `${value}`);
const READ_GAIN_MIN = 5;
const WATCH_COST_MIN = 10;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const AUTO_REFRESH_MS = 5000;
const MIN_RECOVERY_DAYS = 3;
const MAX_RECOVERY_DAYS = 60;
const DEFAULT_RECOVERY_DAYS = 14;
const TARGET_RECOVERY_BALANCE = 10;
const RECOVERY_TARGET_STEP = 5;
const FALLBACK_READ_MINUTES = 5;
const SESSION_LOG_COUNT = 12;
const FAILSAFE_RISK_THRESHOLD = 0.6;
const HEATMAP_METRIC_LABELS = {
  risk: 'Risk Score',
  bypass: 'Bypass Rate',
  negative: 'Negative Balance'
} as const;
const HEATMAP_METRIC_DEFINITIONS = {
  risk: 'Composite risk score derived from fast time-to-watch, bypass streaks, negative balance hits, and low read completion.',
  bypass: 'Share of windows that went straight to watch instead of read (watch / (watch + read)).',
  negative: 'Debt minutes per window computed as max(0, watch_count × 10 - read_count × 5). Higher means that hour drains balance faster.'
} as const;

const normalizeWhole = (value: number) => {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? Math.ceil(value) : -Math.ceil(Math.abs(value));
};

const getActionLabel = (eventType: string) => {
  if (eventType === 'watch_initiated') return 'Watch initiated';
  if (eventType === 'read_completed') return 'Read completed';
  const normalized = eventType.replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const getActionMinutes = (event: ActionEventRow) => {
  const minutes = event.metadata?.minutes;
  if (typeof minutes === 'number' && Number.isFinite(minutes)) return minutes;
  if (event.event_type === 'read_completed') return READ_GAIN_MIN;
  if (event.event_type === 'watch_initiated') return WATCH_COST_MIN;
  return 0;
};
type HeatmapMetric = keyof typeof HEATMAP_METRIC_LABELS;
type HeatmapCell = { value: number; intensity: number; count: number };
type LiveWindow = {
  dayIndex: number;
  hour: number;
  watchCount: number;
  readCount: number;
};
type HeatmapData = {
  values: HeatmapCell[][];
  max: { value: number; day: number; hour: number; count: number };
  average: number;
  totalCount: number;
};
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const roundToStep = (value: number, step: number) => Math.ceil(value / step) * step;
const riskColor = (value: number) => {
  const clamped = clamp01(value);
  const hue = 170 - clamped * 140;
  const light = 86 - clamped * 22;
  return `hsl(${Math.round(hue)}, 45%, ${Math.round(light)}%)`;
};

const normalizeInsightBullets = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

const extractInsightFields = (bullets: string[] | null | undefined) => {
  const safe = Array.isArray(bullets) ? bullets : [];
  const findByPrefix = (prefix: string) => {
    const match = safe.find((bullet) => bullet.toLowerCase().startsWith(prefix.toLowerCase()));
    return match ? match.replace(new RegExp(`^${prefix}`, 'i'), '').trim() : null;
  };
  return {
    evidence: findByPrefix('Evidence:') ?? safe[0] ?? 'AI insight generated from your behavior stream.',
    weakness: findByPrefix('Weak point:') ?? safe[1] ?? 'Review the top drivers from recent sessions.',
    action: findByPrefix('Next step:') ?? safe[2] ?? 'Keep the read-first path active.'
  };
};

const buildHeatmapData = (
  rows: DashboardRow[],
  metric: HeatmapMetric,
  liveWindow?: LiveWindow | null
): HeatmapData => {
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }))
  );
  let totalSum = 0;
  let totalCount = 0;

  for (const row of rows) {
    const date = new Date(row.window_start);
    const dayIndex = (date.getDay() + 6) % 7;
    const hour = date.getHours();
    let value: number | null = null;

    if (metric === 'risk') {
      if (row.risk_score === null) continue;
      value = row.risk_score;
    } else if (metric === 'bypass') {
      const watch = row.watch_initiated_count || 0;
      const read = row.read_completed_count || 0;
      const denom = watch + read;
      if (denom === 0) continue;
      value = watch / denom;
    } else {
      const watchCount = row.watch_initiated_count || 0;
      const readCount = row.read_completed_count || 0;
      const activity = watchCount + readCount;
      if (activity === 0) continue;
      const debtMinutes = Math.max(0, watchCount * WATCH_COST_MIN - readCount * READ_GAIN_MIN);
      value = debtMinutes;
    }

    const cell = grid[dayIndex][hour];
    cell.sum += value;
    cell.count += 1;
    totalSum += value;
    totalCount += 1;
  }

  if (liveWindow) {
    const watchCount = liveWindow.watchCount;
    const readCount = liveWindow.readCount;
    const total = watchCount + readCount;
    if (total > 0) {
      let liveValue = 0;
      if (metric === 'risk') {
        const ratioScore = Math.min(1, (watchCount / Math.max(1, readCount)) / 2);
        const debtMinutes = Math.max(0, watchCount * WATCH_COST_MIN - readCount * READ_GAIN_MIN);
        const debtScore = Math.min(1, debtMinutes / (WATCH_COST_MIN * 3));
        liveValue = clamp01(ratioScore * 0.65 + debtScore * 0.35);
      } else if (metric === 'bypass') {
        liveValue = watchCount / total;
      } else {
        liveValue = Math.max(0, watchCount * WATCH_COST_MIN - readCount * READ_GAIN_MIN);
      }
      const liveCell = grid[liveWindow.dayIndex][liveWindow.hour];
      liveCell.sum += liveValue;
      liveCell.count += 1;
      totalSum += liveValue;
      totalCount += 1;
    }
  }

  let max = { value: 0, day: 0, hour: 0, count: 0 };
  const values = grid.map((row, day) =>
    row.map((cell, hour) => {
      const value = cell.count ? cell.sum / cell.count : 0;
      if (value > max.value) {
        max = { value, day, hour, count: cell.count };
      }
      return { value, count: cell.count, intensity: 0 };
    })
  );
  const maxValue = max.value;
  const normalized = values.map((row) =>
    row.map((cell) => ({
      ...cell,
      intensity: maxValue > 0 ? cell.value / maxValue : 0
    }))
  );

  return {
    values: normalized,
    max,
    average: totalCount > 0 ? totalSum / totalCount : 0,
    totalCount
  };
};

const formatHeatmapValue = (value: number, metric: HeatmapMetric) => {
  if (metric === 'bypass') {
    return `${Math.round(value * 100)}%`;
  }
  if (metric === 'negative') {
    return `${formatNumber(value, 1)} min`;
  }
  return formatNumber(value, 2);
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
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>('risk');
  const [insightIndex, setInsightIndex] = useState(0);
  const [recoveryDays, setRecoveryDays] = useState(DEFAULT_RECOVERY_DAYS);
  const [recoveryTarget, setRecoveryTarget] = useState(TARGET_RECOVERY_BALANCE);

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
      .select('id, event_type, occurred_at, metadata')
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
  const currentHourStart = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
  }, [state.rows, actionEvents]);
  const currentHourEnd = useMemo(
    () => new Date(currentHourStart.getTime() + 60 * 60 * 1000),
    [currentHourStart]
  );
  const liveWindow = useMemo(() => {
    if (actionEvents.length === 0) return null;
    let watchCount = 0;
    let readCount = 0;
    for (const event of actionEvents) {
      const occurredAt = new Date(event.occurred_at);
      if (occurredAt < currentHourStart || occurredAt >= currentHourEnd) continue;
      if (event.event_type === 'watch_initiated') {
        watchCount += 1;
      } else if (event.event_type === 'read_completed') {
        readCount += 1;
      }
    }
    if (watchCount + readCount === 0) return null;
    return {
      dayIndex: (currentHourStart.getDay() + 6) % 7,
      hour: currentHourStart.getHours(),
      watchCount,
      readCount
    };
  }, [actionEvents, currentHourStart, currentHourEnd]);
  const hasFeatureWindowCurrent = useMemo(() => {
    if (displayRows.length === 0) return false;
    const startMs = currentHourStart.getTime();
    const endMs = currentHourEnd.getTime();
    return displayRows.some((row) => {
      const ts = new Date(row.window_start).getTime();
      return ts >= startMs && ts < endMs;
    });
  }, [displayRows, currentHourStart, currentHourEnd]);
  const liveCell = useMemo(
    () => (liveWindow && !hasFeatureWindowCurrent ? liveWindow : null),
    [liveWindow, hasFeatureWindowCurrent]
  );
  const insightStats = useMemo(() => {
    const recentRows = displayRows.slice(0, 24);
    const totals = {
      videoOpened: 0,
      summaryGenerated: 0,
      summaryLatencyTotal: 0,
      summaryLatencyCount: 0,
      readCompleted: 0,
      readTimeTotal: 0,
      readTimeCount: 0,
      watchInitiated: 0,
      watchEnded: 0,
      watchSecondsTotal: 0,
      watchTimeSinceOpenTotal: 0,
      watchTimeSinceOpenCount: 0,
      negativeBalanceCount: 0
    };

    for (const row of recentRows) {
      totals.videoOpened += row.video_opened_count || 0;
      totals.summaryGenerated += row.summary_generated_count || 0;
      totals.summaryLatencyTotal += row.summary_latency_ms_total || 0;
      totals.summaryLatencyCount += row.summary_latency_ms_count || 0;
      totals.readCompleted += row.read_completed_count || 0;
      totals.readTimeTotal += row.read_time_ms_total || 0;
      totals.readTimeCount += row.read_time_ms_count || 0;
      totals.watchInitiated += row.watch_initiated_count || 0;
      totals.watchEnded += row.watch_ended_count || 0;
      totals.watchSecondsTotal += row.watch_seconds_total || 0;
      totals.watchTimeSinceOpenTotal += row.watch_time_since_open_ms_total || 0;
      totals.watchTimeSinceOpenCount += row.watch_time_since_open_ms_count || 0;
      totals.negativeBalanceCount += row.negative_balance_count || 0;
    }

    const watchCount = totals.watchInitiated;
    const readCount = totals.readCompleted;
    const openCount = totals.videoOpened;
    const summaryCount = totals.summaryGenerated;
    const watchEnded = totals.watchEnded;

    const avgTimeToWatchMs =
      totals.watchTimeSinceOpenCount > 0
        ? totals.watchTimeSinceOpenTotal / totals.watchTimeSinceOpenCount
        : null;
    const avgWatchMinutes =
      totals.watchSecondsTotal > 0
        ? totals.watchSecondsTotal / 60 / Math.max(1, watchEnded || watchCount)
        : null;
    const avgReadMinutes =
      totals.readTimeCount > 0 ? totals.readTimeTotal / totals.readTimeCount / 60000 : null;
    const avgSummaryLatencyMs =
      totals.summaryLatencyCount > 0 ? totals.summaryLatencyTotal / totals.summaryLatencyCount : null;

    const summaryRate = openCount > 0 ? summaryCount / openCount : null;
    const readCompletionRate = summaryCount > 0 ? readCount / summaryCount : null;
    const watchStartRate = openCount > 0 ? watchCount / openCount : null;
    const watchCompletionRate = watchCount > 0 ? watchEnded / watchCount : null;
    const watchToReadRatio = watchCount / Math.max(1, readCount);
    const negativeBalanceRate = watchCount > 0 ? totals.negativeBalanceCount / watchCount : null;

    return {
      windowCount: recentRows.length,
      watchCount,
      readCount,
      openCount,
      summaryCount,
      watchEnded,
      avgTimeToWatchMs,
      avgWatchMinutes,
      avgReadMinutes,
      avgSummaryLatencyMs,
      summaryRate,
      readCompletionRate,
      watchStartRate,
      watchCompletionRate,
      watchToReadRatio,
      negativeBalanceRate,
      negativeBalanceCount: totals.negativeBalanceCount
    };
  }, [displayRows]);

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
  const watchBalance = levelStats.watchBalance;
  const isDebt = watchBalance < 0;
  const targetMin = roundToStep(
    Math.max(watchBalance + RECOVERY_TARGET_STEP, TARGET_RECOVERY_BALANCE),
    RECOVERY_TARGET_STEP
  );
  const targetMax = targetMin + RECOVERY_TARGET_STEP * 20;

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

  const riskHeatmap = useMemo(() => buildHeatmapData(displayRows, 'risk'), [displayRows]);
  const heatmapData = useMemo(
    () => buildHeatmapData(displayRows, heatmapMetric, liveCell),
    [displayRows, heatmapMetric, liveCell]
  );
  const heatmapCoverage = useMemo(() => {
    if (displayRows.length === 0) return null;
    const timestamps = displayRows.map((row) => new Date(row.window_start).getTime());
    const min = new Date(Math.min(...timestamps));
    const max = new Date(Math.max(...timestamps));
    return {
      range: `${formatDateShort(min)}–${formatDateShort(max)}`,
      total: displayRows.length
    };
  }, [displayRows]);

  const heatmapSummary = useMemo(() => {
    const metricLabel = HEATMAP_METRIC_LABELS[heatmapMetric];
    const definition = HEATMAP_METRIC_DEFINITIONS[heatmapMetric];
    const coverage = heatmapCoverage
      ? `Coverage: ${heatmapCoverage.range} (${heatmapCoverage.total} windows, local time).`
      : 'Coverage: awaiting more windows.';
    const liveNote = liveCell
      ? `Live activity included for ${DAY_LABELS[liveCell.dayIndex]} ${formatHourLabel(liveCell.hour)}.`
      : '';
    if (heatmapData.totalCount === 0) {
      return {
        definition,
        coverage: liveNote ? `${coverage} ${liveNote}` : coverage,
        meaning: `No ${metricLabel.toLowerCase()} data yet, so the grid is empty. As soon as a few windows stream in, you will see the time blocks that tend to spike or stay calm.`,
        suggestion:
          'Keep running a few sessions at different times of day so the model can compare patterns. Once data lands, use the highlighted hours to pre-plan a read-first flow or a watch delay.',
        footnote: `No ${metricLabel.toLowerCase()} windows yet.`
      };
    }

    const peakDay = DAY_LABELS[heatmapData.max.day];
    const peakHour = formatHourLabel(heatmapData.max.hour);
    const windowLabel = `${heatmapData.totalCount} window${heatmapData.totalCount === 1 ? '' : 's'}`;
    const averageValue = heatmapData.average;
    const hasPeak = heatmapData.max.value > 0;

    if (heatmapMetric === 'risk') {
      const peakValue = formatNumber(heatmapData.max.value, 2);
      const avgValue = formatNumber(averageValue, 2);
      const meaning = hasPeak
        ? `Based on ${windowLabel}, risk peaks around ${peakDay} ${peakHour} at ${peakValue} (avg ${avgValue}). That time block is where fast watch decisions and balance pressure cluster most often.`
        : `Based on ${windowLabel}, risk stays low across tracked windows (avg ${avgValue}). That suggests your routine is stable and there are no consistent danger hours yet.`;
      let suggestion = 'Keep the read-first flow active during your usual hours. If you want to pressure test, add a short pause before Watch Now to keep choices deliberate.';
      if (hasPeak) {
        if (heatmapData.max.value >= 0.7) {
          suggestion =
            `Plan a read-first block 20 minutes before ${peakDay} ${peakHour} and delay Watch Now. ` +
            'Treat that window as a known hotspot: start with a summary, set a timer, and avoid autoplay until the urge passes.';
        } else if (heatmapData.max.value >= 0.4) {
          suggestion =
            `Set a reminder to start with a summary before ${peakDay} ${peakHour}. ` +
            'The goal is to slow the initial jump so you can choose intentionally instead of sliding into a watch streak.';
        } else {
          suggestion =
            `Add a light guardrail around ${peakDay} ${peakHour} (read-first + timer). ` +
            'You are mostly steady, so small nudges here should be enough to keep balance positive.';
        }
      }
      return {
        definition,
        coverage: liveNote ? `${coverage} ${liveNote}` : coverage,
        meaning,
        suggestion,
        footnote: hasPeak
          ? `Highest risk appears around ${peakDay} ${peakHour}.`
          : 'Risk stays flat across recent windows.'
      };
    }

    if (heatmapMetric === 'bypass') {
      const peakValue = `${Math.round(heatmapData.max.value * 100)}%`;
      const avgValue = `${Math.round(averageValue * 100)}%`;
      const meaning = hasPeak
        ? `Based on ${windowLabel}, bypass rate peaks around ${peakDay} ${peakHour} at ${peakValue} (avg ${avgValue}). That means you are choosing watch over read most often in that slot.`
        : `Based on ${windowLabel}, bypass rate stays low across tracked windows (avg ${avgValue}). You are generally choosing the read-first path before watching.`;
      let suggestion =
        'Keep the read-first step visible when opening content. A short summary or checklist at the entry point helps preserve the habit even on busy days.';
      if (hasPeak) {
        if (heatmapData.max.value >= 0.6) {
          suggestion =
            `Require a read or summary before watch around ${peakDay} ${peakHour}. ` +
            'If you still want to watch, set a small rule: one read first, then decide if the watch is still worth it.';
        } else if (heatmapData.max.value >= 0.35) {
          suggestion =
            `Add a quick prompt before watch near ${peakDay} ${peakHour} to slow the jump. ` +
            'Even a 10-second pause helps you notice the impulse and choose a read-first path instead.';
        } else {
          suggestion =
            `Maintain a light prompt around ${peakDay} ${peakHour} to avoid auto-bypasses. ` +
            'You are close to balanced, so a single nudge is usually enough.';
        }
      }
      return {
        definition,
        coverage: liveNote ? `${coverage} ${liveNote}` : coverage,
        meaning,
        suggestion,
        footnote: hasPeak
          ? `Highest bypass rate appears around ${peakDay} ${peakHour}.`
          : 'Bypass stays flat across recent windows.'
      };
    }

    const peakValue = formatNumber(heatmapData.max.value, 1);
    const avgValue = formatNumber(averageValue, 1);
    const meaning = hasPeak
      ? `Based on ${windowLabel}, debt minutes spike around ${peakDay} ${peakHour} at ${peakValue} min per window (avg ${avgValue}). That hour is where watch sessions outpace reads the most.`
      : `Based on ${windowLabel}, debt minutes stay near zero (avg ${avgValue}). Your read and watch habits are balanced across recent windows.`;
    let suggestion =
      'Balance looks stable; keep your current read cadence. If you want extra buffer, add a short read before longer watch sessions.';
    if (hasPeak) {
      if (heatmapData.max.value >= 1.5) {
        suggestion =
          `Bank extra reads earlier on ${peakDay} to offset the ${peakHour} debt spike. ` +
          'Aim for two short reads before your typical watch window so the balance does not dip below zero.';
      } else if (heatmapData.max.value >= 0.5) {
        suggestion =
          `Schedule a read-first block before ${peakDay} ${peakHour} to prevent balance dips. ` +
          'That buffer makes it harder to spiral into debt once the watch session starts.';
      } else {
        suggestion =
          `Add a short read before ${peakDay} ${peakHour} to stay in surplus. ` +
          'You are close to balance, so a small pre-read keeps the window neutral.';
      }
    }
    return {
      definition,
      coverage: liveNote ? `${coverage} ${liveNote}` : coverage,
      meaning,
      suggestion,
      footnote: hasPeak
        ? `Highest negative balance appears around ${peakDay} ${peakHour}.`
        : 'Negative balance stays flat across recent windows.'
    };
  }, [heatmapData, heatmapMetric, heatmapCoverage, liveCell]);

  const latestInsight = useMemo(() => {
    for (const row of displayRows) {
      if (row.insight_summary || (row.insight_bullets && row.insight_bullets.length > 0)) {
        return row;
      }
    }
    return null;
  }, [displayRows]);

  const insightCards = useMemo<InsightCard[]>(() => {
    const cards: InsightCard[] = [];
    const windowLabel = insightStats.windowCount > 0 ? `last ${insightStats.windowCount}h` : 'recent';
    const watchCount = insightStats.watchCount;
    const readCount = insightStats.readCount;
    const openCount = insightStats.openCount;
    const summaryCount = insightStats.summaryCount;
    const watchToReadRatio = insightStats.watchToReadRatio;
    const watchToReadLabel = formatNumber(watchToReadRatio, 2);
    const watchStartRateLabel =
      insightStats.watchStartRate !== null ? formatPercent(insightStats.watchStartRate, 0) : 'n/a';
    const negativeBalanceRateLabel =
      insightStats.negativeBalanceRate !== null
        ? formatPercent(insightStats.negativeBalanceRate, 0)
        : 'n/a';
    const avgWatchMinutesLabel =
      insightStats.avgWatchMinutes !== null ? `${formatNumber(insightStats.avgWatchMinutes, 1)} min` : 'n/a';
    const avgReadMinutesLabel =
      insightStats.avgReadMinutes !== null ? `${formatNumber(insightStats.avgReadMinutes, 1)} min` : 'n/a';
    const avgSummaryLatencyLabel =
      insightStats.avgSummaryLatencyMs !== null
        ? `${formatNumber(insightStats.avgSummaryLatencyMs / 1000, 1)}s`
        : 'n/a';
    const balanceDebt = levelStats.watchBalance;
    const readsNeeded =
      balanceDebt < 0 ? Math.ceil(Math.abs(balanceDebt) / READ_GAIN_MIN) : 0;
    const readGap = Math.max(0, watchCount - readCount);
    const balanceHeadline =
      balanceDebt < 0
        ? `Current watch balance is ${formatSigned(balanceDebt)} minutes, and it would take ${readsNeeded} read${
            readsNeeded === 1 ? '' : 's'
          } to return to zero at your current pacing. `
        : `Current watch balance is ${formatSigned(balanceDebt)} minutes, which gives you a surplus buffer before debt. `;
    const balanceEvidence =
      balanceHeadline +
      `Over the ${windowLabel}, you logged ${openCount} opens, ${watchCount} watch starts, and ${readCount} completed reads ` +
      `(watch-to-read ratio ${watchToReadLabel}:1, watch start rate ${watchStartRateLabel}). ` +
      (insightStats.negativeBalanceCount > 0
        ? `Negative balance was triggered ${insightStats.negativeBalanceCount} times (${negativeBalanceRateLabel} of watch starts).`
        : 'No negative balance triggers were recorded in this window.');
    const balanceWeakness =
      balanceDebt < 0 || insightStats.watchToReadRatio > 1.2
        ? `Watch starts are outpacing reads (${watchCount} vs ${readCount}), which is why the watch-to-read ratio is ${watchToReadLabel}:1. ` +
          (insightStats.negativeBalanceCount > 0
            ? `That imbalance shows up as attention debt and ${insightStats.negativeBalanceCount} negative balance triggers in the same window.`
            : 'That imbalance is enough to push balance negative even before triggers appear.')
        : `Reads are keeping pace with watch starts (${readCount} reads for ${watchCount} watches), which keeps the ratio near ${watchToReadLabel}:1. ` +
          `Debt pressure is contained because the cadence matches your recent volume.`;
    const balanceAction =
      balanceDebt < 0
        ? `Complete ${readsNeeded} read${readsNeeded === 1 ? '' : 's'} to return to zero, then hold a 1:1 read-to-watch buffer. ` +
          `If your next ${windowLabel} looks like the last one (${watchCount} watch starts), matching that with ${watchCount} reads keeps you positive.`
        : insightStats.watchToReadRatio > 1.2
          ? `Reduce the gap by adding about ${readGap || 1} extra reads across your next few sessions to bring the ratio back toward 1:1. ` +
            `That single change offsets the current watch volume without needing new product features.`
          : `Keep the read-first cadence and add one extra read before any long watch. ` +
            `Your recent ratio of ${watchToReadLabel}:1 shows the balance is stable, so the goal is to sustain it.`;
    cards.push({
      title: balanceDebt < 0 ? 'Watch balance in debt' : 'Watch balance in surplus',
      evidence: balanceEvidence,
      weakness: balanceWeakness,
      action: balanceAction
    });

    const summaryRate = insightStats.summaryRate;
    const readCompletionRate = insightStats.readCompletionRate;
    let summaryTitle = 'Summary habits forming';
    let summaryWeakness = 'Not enough summary activity to judge follow-through.';
    let summaryAction = 'Generate a summary on your next open to build signal.';
    if (insightStats.openCount > 0 && summaryRate !== null) {
      if (summaryRate < 0.4) {
        summaryTitle = 'Summary step skipped';
        summaryWeakness =
          `Only ${summaryCount} of ${openCount} opens generated a summary (${formatPercent(summaryRate)}), so most sessions skip the read gate. ` +
          `That makes it harder to slow down a watch impulse with data.`;
        summaryAction =
          `Aim to generate summaries on at least 60% of opens; with your recent volume, that means ${Math.max(
            1,
            Math.ceil(openCount * 0.6) - summaryCount
          )} more summaries in the next ${windowLabel}. ` +
          `This keeps the decision point earlier without changing any settings.`;
      } else if (readCompletionRate !== null && readCompletionRate < 0.5) {
        summaryTitle = 'Summary reads drop off';
        summaryWeakness =
          `Summaries are generated (${summaryCount}), but only ${readCount} were completed (${formatPercent(
            readCompletionRate
          )}). ` +
          `That drop-off means the read step is being started but not finished.`;
        summaryAction =
          `Commit to finishing one summary before Watch Now on your next few sessions. ` +
          `Pushing completion to 60% would mean about ${Math.max(
            1,
            Math.ceil(summaryCount * 0.6) - readCount
          )} more completed reads at your current summary volume.`;
      } else {
        summaryTitle = 'Summary follow-through is strong';
        summaryWeakness =
          `Read completion is holding at ${formatPercent(readCompletionRate ?? 0)} (${readCount} of ${summaryCount}). ` +
          `The remaining opportunity is to scale this across more opens.`;
        const summaryCoverageGap = Math.max(0, Math.ceil(openCount * 0.6) - summaryCount);
        summaryAction =
          summaryCoverageGap > 0
            ? `Keep Read First as your default gate and expand coverage to more opens. ` +
              `If you add ${summaryCoverageGap} more summaries, the same completion rate keeps reads high.`
            : `Keep Read First as your default gate; summary coverage is already above 60% of opens. ` +
              `Focus on sustaining completion so the read habit stays strong.`;
      }
    }
    const summaryEvidence =
      insightStats.openCount > 0 && summaryRate !== null
        ? `In the ${windowLabel}, you opened ${openCount} videos and generated ${summaryCount} summaries (${formatPercent(
            summaryRate
          )} of opens). ` +
          `Read completion is ${readCompletionRate !== null ? formatPercent(readCompletionRate) : 'n/a'} with an average read time of ${avgReadMinutesLabel}, and summary latency averages ${avgSummaryLatencyLabel}.`
        : 'No summary activity recorded in the selected window.';
    cards.push({
      title: summaryTitle,
      evidence: summaryEvidence,
      weakness: summaryWeakness,
      action: summaryAction
    });

    const impulseTotal = impulseStats.buckets.reduce((sum, count) => sum + count, 0);
    const fastImpulseRate = impulseTotal > 0 ? impulseStats.buckets[0] / impulseTotal : null;
    const avgTimeToWatchSec =
      insightStats.avgTimeToWatchMs !== null ? Math.round(insightStats.avgTimeToWatchMs / 1000) : null;
    let impulseTitle = 'Impulse timing forming';
    let impulseWeakness = 'Not enough watch timing data yet.';
    let impulseAction = 'Log a few watch sessions to unlock timing insights.';
    if (avgTimeToWatchSec !== null) {
      if (avgTimeToWatchSec < 15) {
        impulseTitle = 'Fast watch pivot';
        impulseWeakness =
          `Watch starts are happening quickly (avg ${avgTimeToWatchSec}s), which leaves little time for a summary check. ` +
          `Fast starts under 5s account for ${fastImpulseRate !== null ? formatPercent(fastImpulseRate) : 'n/a'} of watch starts.`;
        impulseAction =
          `When the impulse hits under 15s, open the summary first and commit to a 2-minute read. ` +
          `Raising time-to-watch above 30s will lower the fast-start share and reduce impulsive pivots.`;
      } else if (avgTimeToWatchSec < 30) {
        impulseTitle = 'Moderate watch pivot';
        impulseWeakness =
          `There is some pause (avg ${avgTimeToWatchSec}s), but watch still starts relatively quickly. ` +
          `You still see ${fastImpulseRate !== null ? formatPercent(fastImpulseRate) : 'n/a'} of watch starts under 5s.`;
        impulseAction =
          `Use the summary as a decision gate on every open before Watch Now. ` +
          `Try to keep time-to-watch above 30s on your next few sessions to push the average up.`;
      } else {
        impulseTitle = 'Deliberate watch starts';
        impulseWeakness =
          `You are already pausing before watch (avg ${avgTimeToWatchSec}s), which reduces impulsive pivots. ` +
          `Fast starts under 5s are limited to ${fastImpulseRate !== null ? formatPercent(fastImpulseRate) : 'n/a'} of sessions.`;
        impulseAction =
          `Keep the pre-watch pause and make Read First the default on high-risk hours. ` +
          `This keeps time-to-watch elevated while you maintain your current watch volume.`;
      }
    }
    const impulseEvidence =
      avgTimeToWatchSec !== null
        ? `Average time from open to watch is ${avgTimeToWatchSec}s across ${watchCount} watch starts in the ${windowLabel}. ` +
          `Fast starts under 5s account for ${fastImpulseRate !== null ? formatPercent(fastImpulseRate) : 'n/a'}, and watch completion is ${
            insightStats.watchCompletionRate !== null ? formatPercent(insightStats.watchCompletionRate) : 'n/a'
          }.`
        : 'Waiting for watch timing data.';
    cards.push({
      title: impulseTitle,
      evidence: impulseEvidence,
      weakness: impulseWeakness,
      action: impulseAction
    });

    const peakHour = riskHeatmap.max.value > 0 ? riskHeatmap.max.hour : null;
    const peakDay = riskHeatmap.max.value > 0 ? DAY_LABELS[riskHeatmap.max.day] : null;
    const riskBaseline = riskHeatmap.totalCount > 0 ? formatNumber(riskHeatmap.average, 2) : 'n/a';
    const riskDelta = formatNumber(Math.max(0, riskHeatmap.max.value - riskHeatmap.average), 2);
    cards.push({
      title: peakHour !== null ? `Peak risk window: ${peakDay} ${formatHourLabel(peakHour)}` : 'Risk window forming',
      evidence:
        peakHour !== null
          ? `Highest risk averages ${formatNumber(riskHeatmap.max.value, 2)} across ${riskHeatmap.max.count} windows. ` +
            `Baseline risk across ${riskHeatmap.totalCount} scored windows is ${riskBaseline}, so this window sits ${riskDelta} above average.`
          : 'Collecting more scored windows for timing. Once risk scores land, this will highlight the highest-risk hour.',
      weakness:
        peakHour !== null
          ? `That hour shows the most consistent risk spikes relative to your baseline. ` +
            `Even when overall risk is stable, this slot remains the peak in the last ${windowLabel}.`
          : 'Need more scored windows to detect timing risk. Keep streaming events to build the hourly pattern.',
      action:
        peakHour !== null
          ? `Schedule a read-first block 30-60 minutes before ${formatHourLabel(peakHour)} and avoid watch-first in that window. ` +
            `If you expect to watch, complete one read beforehand to offset the peak-risk slot.`
          : 'Keep streaming events to sharpen timing insights and populate this window.'
    });

    if (latestInsight?.insight_summary) {
      const aiFields = extractInsightFields(latestInsight.insight_bullets);
      const aiRiskLabel =
        typeof latestInsight.risk_score === 'number'
          ? `Latest scored risk is ${formatNumber(latestInsight.risk_score, 2)}. `
          : '';
      const aiDataCitation =
        openCount > 0
          ? `Data used: ${openCount} opens, ${summaryCount} summaries, ${readCount} reads, and ${watchCount} watch starts over the ${windowLabel}. ` +
            `Average read time is ${avgReadMinutesLabel} and average watch session is ${avgWatchMinutesLabel}.`
          : 'Data volume is thin in this window, so insights are directional.';
      cards.push({
        title: latestInsight.insight_summary,
        evidence: `${aiFields.evidence} ${aiRiskLabel}${aiDataCitation}`,
        weakness:
          `${aiFields.weakness} ` +
          `This aligns with a watch-to-read ratio of ${watchToReadLabel}:1 and ${insightStats.negativeBalanceCount} negative balance triggers in the ${windowLabel}.`,
        action:
          `${aiFields.action} ` +
          `Given your recent volume (${watchCount} watches vs ${readCount} reads), a 1:1 ratio is the fastest lever to pull.`
      });
    } else {
      cards.push({
        title: 'AI insight incoming',
        evidence:
          `No Vertex insight has been generated yet. Data in the ${windowLabel} includes ${openCount} opens, ` +
          `${summaryCount} summaries, ${readCount} reads, and ${watchCount} watches, which will feed the model once scored.`,
        weakness:
          'No Vertex insights are available yet, so weakpoints are inferred from aggregates only. ' +
          'Run the scorer to turn these events into a personalized narrative.',
        action:
          'Keep streaming events and run the scorer to unlock long-form insights. ' +
          'Once scored, the AI card will include evidence, weakpoint, and next-step guidance.'
      });
    }

    return cards;
  }, [
    impulseStats.buckets,
    insightStats,
    latestInsight,
    levelStats.watchBalance,
    riskHeatmap.average,
    riskHeatmap.max,
    riskHeatmap.totalCount
  ]);

  const insightCount = insightCards.length;
  const activeInsightIndex = Math.min(insightIndex, Math.max(0, insightCount - 1));

  useEffect(() => {
    if (activeInsightIndex !== insightIndex) {
      setInsightIndex(activeInsightIndex);
    }
  }, [activeInsightIndex, insightIndex]);

  const handleInsightPrev = useCallback(() => {
    setInsightIndex((prev) => {
      if (insightCount <= 1) return 0;
      return (prev - 1 + insightCount) % insightCount;
    });
  }, [insightCount]);

  const handleInsightNext = useCallback(() => {
    setInsightIndex((prev) => {
      if (insightCount <= 1) return 0;
      return (prev + 1) % insightCount;
    });
  }, [insightCount]);

  const avgReadMinutes = useMemo(() => {
    let totalReadMs = 0;
    let totalCount = 0;
    for (const row of displayRows) {
      totalReadMs += row.read_time_ms_total || 0;
      totalCount += row.read_time_ms_count || 0;
    }
    return totalCount > 0 ? totalReadMs / totalCount / 60000 : null;
  }, [displayRows]);

  useEffect(() => {
    setRecoveryTarget((prev) => {
      if (prev < targetMin) return targetMin;
      if (prev > targetMax) return targetMax;
      return prev;
    });
  }, [targetMin, targetMax]);

  const sessionRows = useMemo(() => {
    return actionEvents.slice(0, SESSION_LOG_COUNT).map((event) => {
      const minutes = getActionMinutes(event);
      const balanceDelta = normalizeWhole(
        event.event_type === 'read_completed'
          ? minutes
          : event.event_type === 'watch_initiated'
            ? -minutes
            : 0
      );
      const outcome =
        balanceDelta > 0 ? 'Intentional' : balanceDelta < 0 ? 'Impulsive' : 'Mixed';
      const outcomeKey = outcome.toLowerCase();
      return {
        id: event.id,
        time: formatEventLabel(event.occurred_at),
        action: getActionLabel(event.event_type),
        balanceDelta,
        balanceLabel: formatSigned(balanceDelta),
        outcome,
        outcomeKey
      };
    });
  }, [actionEvents]);

  const watchBalanceClass =
    levelStats.watchBalance < 0 ? 'card stat-card stat-card--balance stat-card--debt' : 'card stat-card stat-card--balance';
  const levelPercentLabel = Math.round(levelStats.levelPercent);
  const targetBalance = isDebt
    ? TARGET_RECOVERY_BALANCE
    : Math.min(Math.max(recoveryTarget, targetMin), targetMax);
  const balanceGap = Math.max(0, targetBalance - watchBalance);
  const minutesPerRead = avgReadMinutes ?? FALLBACK_READ_MINUTES;
  const dailyReadMinutes = recoveryDays > 0 ? balanceGap / recoveryDays : 0;
  const dailyReads = minutesPerRead > 0 ? dailyReadMinutes / minutesPerRead : 0;
  const recoveryHint = isDebt
    ? 'Target fixed at +10 min while in debt.'
    : 'Choose a higher target to grow your buffer.';
  const avgReadLabel = avgReadMinutes
    ? `Average read length: ${formatNumber(avgReadMinutes, 1)} min.`
    : `Assumes ${FALLBACK_READ_MINUTES} min/read until more data arrives.`;
  const latestRiskScore = useMemo(() => {
    for (const row of displayRows) {
      if (row.risk_score !== null) return row.risk_score;
    }
    return null;
  }, [displayRows]);
  const negativeBalanceStreak = useMemo(() => {
    let streak = 0;
    for (const row of displayRows) {
      if (row.negative_balance_count > 0) {
        streak += 1;
      } else {
        break;
      }
    }
    return streak;
  }, [displayRows]);
  const bypassStreak = useMemo(() => {
    let streak = 0;
    for (const row of displayRows) {
      const watch = row.watch_initiated_count || 0;
      const read = row.read_completed_count || 0;
      if (watch > read) {
        streak += 1;
      } else {
        break;
      }
    }
    return streak;
  }, [displayRows]);
  const riskScoreLabel = latestRiskScore !== null ? formatNumber(latestRiskScore, 2) : '--';
  const timeToWatchLabel = impulseStats.avgMs !== null ? `${Math.round(impulseStats.avgMs / 1000)}s` : '--';
  const pageTypeLabel = displayRows[0]
    ? displayRows[0].watch_initiated_count > 0
      ? 'watch'
      : 'search'
    : '--';
  const hourLabel = formatHourLabel(new Date().getHours());
  const isVulnerable = latestRiskScore !== null && latestRiskScore >= FAILSAFE_RISK_THRESHOLD;
  const statusBadgeLabel = isVulnerable ? 'High risk detected' : 'Low risk';
  const decisionDelayReason = isVulnerable
    ? `Active because risk score is ${riskScoreLabel}${
        timeToWatchLabel !== '--' ? ` and watch starts around ${timeToWatchLabel}` : ''
      }.`
    : 'Arms when risk score spikes or watch starts are fast.';
  const readFirstReason = isVulnerable
    ? `Active because risk score is ${riskScoreLabel}${
        negativeBalanceStreak > 0 ? ` and balance dipped for ${formatWindowCount(negativeBalanceStreak)}` : ''
      }.`
    : 'Arms when risk is high or balance turns negative.';
  const autoplayReason = isVulnerable
    ? `Active because risk is high${
        bypassStreak > 0 ? ` and bypass streak hit ${formatWindowCount(bypassStreak)}` : ''
      }.`
    : 'Arms when autoplay drives most recent debt sessions.';
  const failsafeRows: FailsafeRow[] = [
    {
      id: 'decision-delay',
      name: 'Decision Delay',
      active: isVulnerable,
      enabled: true,
      reason: decisionDelayReason,
      action: 'Insert a temporary delay with a read-first countdown prompt.',
      affects: 'Watch button, Autoplay start',
      effectiveness: 'Prevented debt in 74% of recent activations',
      settings: [
        { label: 'Delay length', value: '10s' },
        { label: 'Scope', value: 'High-risk windows only' },
        { label: 'Applies to', value: 'All videos' }
      ]
    },
    {
      id: 'read-first',
      name: 'Read-First Default',
      active: isVulnerable,
      enabled: true,
      reason: readFirstReason,
      action: 'Open read-first panel by default while watch stays available.',
      affects: 'Initial UI state only',
      effectiveness: 'Reading first is 3x more effective late at night',
      settings: [
        { label: 'Apply to', value: 'Shorts + recommended' },
        { label: 'Minimum read time', value: '20s before Watch is highlighted' },
        { label: 'Mode', value: 'Soft default, no delay' }
      ]
    },
    {
      id: 'autoplay-guard',
      name: 'Autoplay Guard',
      active: isVulnerable,
      enabled: true,
      reason: autoplayReason,
      action: 'Pause autoplay during vulnerable windows with a neutral message.',
      affects: 'Autoplay continuation only',
      effectiveness: 'Most debt sessions start from autoplay for you',
      settings: [
        { label: 'Time rule', value: 'After 11 PM' },
        { label: 'Context', value: 'Shorts + watch page' },
        { label: 'Auto-resume', value: 'Off during high-risk windows' }
      ]
    }
  ];

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

      <section className="section-heading section-heading--insights">
        <div className="section-heading__row">
          <div>
            <h2>AI Insights</h2>
            <p>Data-backed guidance, no judgment</p>
          </div>
          <div className="insight-counter">
            {insightCount > 0 ? `${activeInsightIndex + 1} of ${insightCount}` : '0 of 0'}
          </div>
        </div>
      </section>

      <section className="insight-carousel" aria-label="AI insights carousel">
        <div
          className="insight-track"
          style={{ transform: `translateX(-${activeInsightIndex * 100}%)` }}
        >
          {insightCards.map((card, index) => (
            <div key={`insight-${index}`} className="insight-slide">
              <div className="card insight-tile">
                <h3>{card.title}</h3>
                <div className="insight-block">
                  <span>Evidence</span>
                  <p>{card.evidence}</p>
                </div>
                <div className="insight-block insight-block--weakness">
                  <span>Weak point</span>
                  <p>{card.weakness}</p>
                </div>
                <div className="insight-block insight-block--action">
                  <span>Next step</span>
                  <p>{card.action}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="insight-nav">
          <button
            type="button"
            className="insight-arrow"
            onClick={handleInsightPrev}
            aria-label="Previous insight"
            disabled={insightCount <= 1}
          >
            ‹
          </button>
          <div className="insight-dots" role="tablist" aria-label="Insight slides">
            {insightCards.map((_card, index) => (
              <button
                key={`insight-dot-${index}`}
                type="button"
                className={`insight-dot ${index === activeInsightIndex ? 'insight-dot--active' : ''}`}
                onClick={() => setInsightIndex(index)}
                aria-label={`Go to insight ${index + 1}`}
                aria-pressed={index === activeInsightIndex}
              />
            ))}
          </div>
          <button
            type="button"
            className="insight-arrow"
            onClick={handleInsightNext}
            aria-label="Next insight"
            disabled={insightCount <= 1}
          >
            ›
          </button>
        </div>
      </section>

      <section className="section-heading">
        <h2>Risk &amp; Pattern Analysis</h2>
        <p>Hour of day x day of week analysis</p>
      </section>

      <section className="card section-card">
        <div className="panel-header">
          <div />
          <div className="heatmap-controls">
            <div className="toggle-group">
              <button
                className={`toggle ${heatmapMetric === 'risk' ? 'toggle--active' : ''}`}
                type="button"
                onClick={() => setHeatmapMetric('risk')}
                aria-pressed={heatmapMetric === 'risk'}
              >
                Risk Score
              </button>
              <button
                className={`toggle ${heatmapMetric === 'bypass' ? 'toggle--active' : ''}`}
                type="button"
                onClick={() => setHeatmapMetric('bypass')}
                aria-pressed={heatmapMetric === 'bypass'}
              >
                Bypass Rate
              </button>
              <button
                className={`toggle ${heatmapMetric === 'negative' ? 'toggle--active' : ''}`}
                type="button"
                onClick={() => setHeatmapMetric('negative')}
                aria-pressed={heatmapMetric === 'negative'}
              >
                Negative Balance
              </button>
            </div>
            <div className="heatmap-legend">
              <span>Low</span>
              <div className="heatmap-legend__bar" />
              <span>High</span>
            </div>
            <div className="heatmap-legend__note">Darker = more extreme</div>
          </div>
        </div>
        <div className="heatmap-layout">
          <div>
            <div className="heatmap">
              <div className="heatmap-header">
                <span />
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={`hour-${hour}`}>{formatHourLabel(hour)}</span>
                ))}
              </div>
              {DAY_LABELS.map((label, dayIndex) => (
                <div key={label} className="heatmap-row">
                  <span className="heatmap-day">{label}</span>
                  {heatmapData.values[dayIndex].map((cell, hour) => {
                    const valueLabel = formatHeatmapValue(cell.value, heatmapMetric);
                    const countLabel = cell.count
                      ? ` (${cell.count} window${cell.count === 1 ? '' : 's'})`
                      : '';
                    const metricLabel = HEATMAP_METRIC_LABELS[heatmapMetric].toLowerCase();
                    const isEmpty = cell.count === 0;
                    const isLive =
                      liveCell?.dayIndex === dayIndex && liveCell?.hour === hour;
                    return (
                      <span
                        key={`${label}-${hour}`}
                        className={`heatmap-cell${isEmpty ? ' heatmap-cell--empty' : ''}${isLive ? ' heatmap-cell--live' : ''}`}
                        style={{ backgroundColor: isEmpty ? undefined : riskColor(cell.intensity) }}
                        title={
                          isEmpty
                            ? `${label} ${formatHourLabel(hour)} - no data`
                            : `${label} ${formatHourLabel(hour)} - ${metricLabel} ${valueLabel}${countLabel}${isLive ? ' (live activity)' : ''}`
                        }
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="heatmap-footnote">{heatmapSummary.footnote}</div>
          </div>
          <aside className="heatmap-panel">
            <div className="heatmap-panel__section">
              <div className="heatmap-panel__title">Metric definition</div>
              <p>{heatmapSummary.definition}</p>
            </div>
            <div className="heatmap-panel__section">
              <div className="heatmap-panel__title">What this means</div>
              <p>{heatmapSummary.meaning}</p>
            </div>
            <div className="heatmap-panel__section heatmap-panel__section--accent">
              <div className="heatmap-panel__title">AI suggestion</div>
              <p>{heatmapSummary.suggestion}</p>
            </div>
            <div className="heatmap-panel__footnote">{heatmapSummary.coverage}</div>
          </aside>
        </div>
      </section>

      <section className="section-heading">
        <h2>Addiction Mechanics</h2>
        <p>Making the habit visible and explainable</p>
      </section>

      <section className="grid-two">
        <div className="card panel failsafe-panel">
          <div className="panel-header failsafe-header">
            <div>
              <h3>Vulnerability Failsafes</h3>
              <span className="panel-subtitle">Protective actions during high-risk moments</span>
            </div>
            <span
              className={`status-badge${isVulnerable ? ' status-badge--alert' : ' status-badge--calm'}`}
            >
              {statusBadgeLabel}
            </span>
          </div>
          <p className="failsafe-summary">
            A user-controlled safety system that activates soft, reversible protections when vulnerability rises. It does
            not block content or auto-decide; it simply biases the environment so you can choose better in the moment.
          </p>
          <div className="failsafe-signal-card">
            <div className="failsafe-signal-header">
              <span>Signals in play</span>
              <span className="failsafe-signal-note">Computed, not raw events</span>
            </div>
            <div className="failsafe-chip-row">
              <span className="chip">risk_score</span>
              <span className="chip">time_to_watch_ms</span>
              <span className="chip">negative_balance_streak</span>
              <span className="chip">bypass_streak</span>
              <span className="chip">page_type</span>
              <span className="chip">hour_of_day</span>
            </div>
            <div className="failsafe-signal-grid">
              <div className="failsafe-signal">
                <span>Risk score</span>
                <strong>{riskScoreLabel}</strong>
              </div>
              <div className="failsafe-signal">
                <span>Time to watch</span>
                <strong>{timeToWatchLabel}</strong>
              </div>
              <div className="failsafe-signal">
                <span>Negative balance streak</span>
                <strong>{formatWindowCount(negativeBalanceStreak)}</strong>
              </div>
              <div className="failsafe-signal">
                <span>Bypass streak</span>
                <strong>{formatWindowCount(bypassStreak)}</strong>
              </div>
              <div className="failsafe-signal">
                <span>Page type</span>
                <strong>{pageTypeLabel}</strong>
              </div>
              <div className="failsafe-signal">
                <span>Hour of day</span>
                <strong>{hourLabel}</strong>
              </div>
            </div>
            <div className="failsafe-signal-footnote">Logic fires first. The LLM only explains after activation.</div>
          </div>
          {!isVulnerable ? (
            <div className="failsafe-collapsed">No failsafes needed right now.</div>
          ) : (
            <>
              <div className="failsafe-list">
                {failsafeRows.map((failsafe) => (
                  <div
                    key={failsafe.id}
                    className={`failsafe-row${failsafe.active ? ' failsafe-row--active' : ''}`}
                  >
                    <div className="failsafe-row__top">
                      <div>
                        <h4>{failsafe.name}</h4>
                        <span
                          className={`failsafe-status${failsafe.active ? ' failsafe-status--active' : ''}`}
                        >
                          {failsafe.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <label className="failsafe-switch" aria-label={`${failsafe.name} toggle`}>
                        <input type="checkbox" checked={failsafe.enabled} readOnly />
                        <span className="failsafe-slider" />
                      </label>
                    </div>
                    <p className="failsafe-reason">{failsafe.reason}</p>
                    <div className="failsafe-meta">
                      <div>
                        <span>Action</span>
                        <strong>{failsafe.action}</strong>
                      </div>
                      <div>
                        <span>Affects</span>
                        <strong>{failsafe.affects}</strong>
                      </div>
                      <div>
                        <span>Effectiveness</span>
                        <strong>{failsafe.effectiveness}</strong>
                      </div>
                    </div>
                    <details className="failsafe-settings">
                      <summary>Settings</summary>
                      <div className="failsafe-settings__grid">
                        {failsafe.settings.map((setting) => (
                          <div key={`${failsafe.id}-${setting.label}`}>
                            <span>{setting.label}</span>
                            <strong>{setting.value}</strong>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                ))}
              </div>
              <div className="failsafe-stack">
                <div className="failsafe-section-title">Failsafe stacking</div>
                <div className="failsafe-stack__body">
                  <ol>
                    <li>Decision Delay</li>
                    <li>Read-First Default</li>
                    <li>Autoplay Guard</li>
                  </ol>
                  <p>Delay + read-first can coexist. Autoplay guard is independent.</p>
                </div>
              </div>
              <div className="failsafe-events">
                <div className="failsafe-section-title">Events emitted</div>
                <div className="failsafe-chip-row">
                  <span className="chip chip--event">failsafe_armed</span>
                  <span className="chip chip--event">failsafe_triggered</span>
                  <span className="chip chip--event">failsafe_dismissed</span>
                  <span className="chip chip--event">failsafe_effective</span>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="grid-two__stack">
          <div className="card panel recovery-card">
            <div className="panel-header">
              <h3>Recovery Profile</h3>
              <span className="panel-meta">How quickly you can bounce back</span>
            </div>
            <div className="recovery-plan">
              <div className="recovery-status">
                <div className="recovery-stat">
                  <span>Current balance</span>
                  <strong>{formatSigned(watchBalance)} min</strong>
                </div>
                <div className="recovery-stat">
                  <span>Target balance</span>
                  <strong>{formatSigned(targetBalance)} min</strong>
                </div>
                <div className="recovery-stat">
                  <span>Balance gap</span>
                  <strong>{formatNumber(balanceGap, 1)} min</strong>
                </div>
              </div>
              <div className="recovery-controls">
                <label className="range-field">
                  <div className="range-title">
                    <span>Days to recover</span>
                    <strong>{recoveryDays} days</strong>
                  </div>
                  <input
                    type="range"
                    min={MIN_RECOVERY_DAYS}
                    max={MAX_RECOVERY_DAYS}
                    value={recoveryDays}
                    onChange={(event) => setRecoveryDays(Number(event.target.value))}
                  />
                </label>
                {!isDebt ? (
                  <label className="range-field">
                    <div className="range-title">
                      <span>Target watch balance</span>
                      <strong>{formatSigned(targetBalance)} min</strong>
                    </div>
                    <input
                      type="range"
                      min={targetMin}
                      max={targetMax}
                      step={RECOVERY_TARGET_STEP}
                      value={recoveryTarget}
                      onChange={(event) => setRecoveryTarget(Number(event.target.value))}
                    />
                  </label>
                ) : null}
              </div>
              <div className="recovery-note">
                <strong>
                  Read about {formatNumber(dailyReadMinutes, 1)} min/day for {recoveryDays} days.
                </strong>
                <span>
                  About {formatNumber(dailyReads, 1)} reads/day at ~{formatNumber(minutesPerRead, 1)} min/read.
                </span>
                <span>{avgReadLabel}</span>
                <span>{recoveryHint}</span>
              </div>
            </div>
          </div>

          <section className="card table-card session-log-card">
            <div className="panel-header">
              <h3>Session Log</h3>
              <span className="panel-meta">Last {SESSION_LOG_COUNT} actions with exact timestamps</span>
            </div>
            <div className="table session-table">
              <div className="table-row header">
                <span>Time</span>
                <span>Action</span>
                <span>Balance +/-</span>
                <span>Analysis</span>
              </div>
              {sessionRows.map((row) => (
                <div className="table-row" key={`session-${row.id}`}>
                  <span>{row.time}</span>
                  <span>{row.action}</span>
                  <span className={row.balanceDelta < 0 ? 'negative' : 'positive'}>{row.balanceLabel}</span>
                  <span className={`pill outcome outcome-${row.outcomeKey}`}>{row.outcome}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
