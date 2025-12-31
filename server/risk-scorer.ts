import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { VertexAI } from '@google-cloud/vertexai';

dotenv.config();

const SUPABASE_PROJECT_URL = process.env.SUPABASE_PROJECT_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RISK_SCORE_LOOKBACK_HOURS = Number(process.env.RISK_SCORE_LOOKBACK_HOURS || 24);
const VERTEX_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_GEMINI_MODEL = process.env.VERTEX_GEMINI_MODEL;
const VERTEX_MODEL_FALLBACKS = [
  'gemini-1.5-flash-001',
  'gemini-1.5-pro-001',
  'gemini-1.0-pro-001'
];

if (!SUPABASE_PROJECT_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase env vars. Set SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

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

type FeatureSnapshot = {
  video_opened_count: number;
  summary_generated_count: number;
  avg_summary_latency_ms: number | null;
  read_completed_count: number;
  avg_read_time_ms: number | null;
  watch_initiated_count: number;
  watch_ended_count: number;
  watch_seconds_total: number;
  avg_watch_seconds: number;
  avg_time_to_watch_ms: number | null;
  watch_to_read_ratio: number;
  negative_balance_count: number;
  negative_balance_rate: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function normalizeModelName(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/models\/([A-Za-z0-9._-]+)/);
  if (match?.[1]) {
    return match[1];
  }
  return trimmed;
}

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function normalizeBulletList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => line.replace(/^[\-\*\d\.\s]+/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function buildFeatureSnapshot(row: FeatureWindowRow): FeatureSnapshot {
  const watchInitiated = row.watch_initiated_count || 0;
  const readCompleted = row.read_completed_count || 0;
  const negativeBalance = row.negative_balance_count || 0;
  const watchEnded = row.watch_ended_count || 0;
  const watchSecondsTotal = row.watch_seconds_total || 0;
  const timeToWatchCount = row.watch_time_since_open_ms_count || 0;
  const timeToWatchTotal = row.watch_time_since_open_ms_total || 0;
  const summaryLatencyCount = row.summary_latency_ms_count || 0;
  const summaryLatencyTotal = row.summary_latency_ms_total || 0;
  const readTimeCount = row.read_time_ms_count || 0;
  const readTimeTotal = row.read_time_ms_total || 0;

  const watchToReadRatio = watchInitiated / Math.max(1, readCompleted);
  const negativeBalanceRate = negativeBalance / Math.max(1, watchInitiated);
  const avgWatchSeconds = watchSecondsTotal / Math.max(1, watchEnded || watchInitiated);

  return {
    video_opened_count: row.video_opened_count || 0,
    summary_generated_count: row.summary_generated_count || 0,
    avg_summary_latency_ms:
      summaryLatencyCount > 0 ? summaryLatencyTotal / summaryLatencyCount : null,
    read_completed_count: readCompleted,
    avg_read_time_ms: readTimeCount > 0 ? readTimeTotal / readTimeCount : null,
    watch_initiated_count: watchInitiated,
    watch_ended_count: watchEnded,
    watch_seconds_total: watchSecondsTotal,
    avg_watch_seconds: avgWatchSeconds,
    avg_time_to_watch_ms: timeToWatchCount > 0 ? timeToWatchTotal / timeToWatchCount : null,
    watch_to_read_ratio: watchToReadRatio,
    negative_balance_count: negativeBalance,
    negative_balance_rate: negativeBalanceRate
  };
}

function computeRisk(row: FeatureWindowRow) {
  const watchInitiated = row.watch_initiated_count || 0;
  const readCompleted = row.read_completed_count || 0;
  const negativeBalance = row.negative_balance_count || 0;
  const watchEnded = row.watch_ended_count || 0;
  const watchSecondsTotal = row.watch_seconds_total || 0;
  const timeToWatchCount = row.watch_time_since_open_ms_count || 0;
  const timeToWatchTotal = row.watch_time_since_open_ms_total || 0;

  const watchToReadRatio = watchInitiated / Math.max(1, readCompleted);
  const negativeBalanceRate = negativeBalance / Math.max(1, watchInitiated);
  const avgWatchSeconds = watchSecondsTotal / Math.max(1, watchEnded || watchInitiated);
  const avgTimeToWatchMs = timeToWatchCount > 0 ? timeToWatchTotal / timeToWatchCount : null;

  const ratioScore = Math.min(1, watchToReadRatio / 2);
  const negativeScore = Math.min(1, negativeBalanceRate * 1.5);
  const fastWatchScore =
    avgTimeToWatchMs === null ? 0 : 1 - Math.min(1, avgTimeToWatchMs / (5 * 60 * 1000));
  const watchLengthScore = Math.min(1, avgWatchSeconds / (10 * 60));

  let risk =
    ratioScore * 0.35 +
    negativeScore * 0.35 +
    fastWatchScore * 0.2 +
    watchLengthScore * 0.1;

  if (readCompleted > 0) {
    risk -= Math.min(0.2, readCompleted * 0.05);
  }

  risk = clamp(risk, 0, 1);

  return {
    riskScore: Number(risk.toFixed(4)),
    factors: {
      watch_to_read_ratio: Number(watchToReadRatio.toFixed(3)),
      negative_balance_rate: Number(negativeBalanceRate.toFixed(3)),
      avg_watch_seconds: Math.round(avgWatchSeconds),
      avg_time_to_watch_ms: avgTimeToWatchMs ? Math.round(avgTimeToWatchMs) : null,
      ratio_score: Number(ratioScore.toFixed(3)),
      negative_score: Number(negativeScore.toFixed(3)),
      fast_watch_score: Number(fastWatchScore.toFixed(3)),
      watch_length_score: Number(watchLengthScore.toFixed(3))
    }
  };
}

function buildPrompt(snapshot: FeatureSnapshot) {
  return [
    'You are an attention risk analyst.',
    'Given the hourly behavior features, estimate relapse risk for the next hour.',
    'Return ONLY valid JSON with the following keys:',
    '- risk_score: number between 0 and 1',
    '- insight_summary: string (1-2 sentences)',
    '- insight_bullets: array of 3 concise strings',
    '- factors: object with 3 numeric factor scores between 0 and 1',
    '',
    'Feature window JSON:',
    JSON.stringify(snapshot, null, 2)
  ].join('\n');
}

async function scoreWithVertex(snapshot: FeatureSnapshot) {
  if (!VERTEX_PROJECT_ID) return null;

  const configuredModel = normalizeModelName(VERTEX_GEMINI_MODEL ?? undefined);
  const modelCandidates = [
    ...(configuredModel ? [configuredModel] : []),
    ...VERTEX_MODEL_FALLBACKS
  ];
  const vertexAI = new VertexAI({ project: VERTEX_PROJECT_ID, location: VERTEX_LOCATION });
  const prompt = buildPrompt(snapshot);
  let lastError: Error | null = null;

  for (const modelName of modelCandidates) {
    try {
      const model = vertexAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.2,
          topP: 0.9,
          responseMimeType: 'application/json'
        }
      });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });
      const text =
        result.response.candidates?.[0]?.content?.parts
          ?.map((part) => ('text' in part ? part.text : ''))
          .join('') || '';

      const jsonText = extractJson(text) ?? '{}';
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        parsed = {};
      }

      const rawRisk = typeof parsed.risk_score === 'number' ? parsed.risk_score : null;
      if (rawRisk === null || Number.isNaN(rawRisk)) {
        throw new Error('Vertex response missing risk_score');
      }
      const riskScore = clamp(rawRisk, 0, 1);
      const insightSummary =
        typeof parsed.insight_summary === 'string' ? parsed.insight_summary.trim() : '';
      const insightBullets = normalizeBulletList(parsed.insight_bullets).slice(0, 3);
      const factors = typeof parsed.factors === 'object' && parsed.factors !== null ? parsed.factors : {};

      return {
        riskScore: Number(riskScore.toFixed(4)),
        insightSummary,
        insightBullets,
        factors,
        model: modelName
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }
  return null;
}

function buildFallbackInsight(snapshot: FeatureSnapshot, riskScore: number) {
  const bullets = [
    `Watch-to-read ratio at ${snapshot.watch_to_read_ratio.toFixed(2)}.`,
    `Negative balance events: ${snapshot.negative_balance_count}.`,
    snapshot.avg_time_to_watch_ms === null
      ? 'No watch-to-open timing recorded.'
      : `Average time to watch: ${Math.round(snapshot.avg_time_to_watch_ms / 1000)}s.`
  ];
  return {
    insightSummary: `Heuristic risk score ${riskScore.toFixed(2)} based on recent watch vs read behavior.`,
    insightBullets: bullets
  };
}

async function fetchFeatureWindows(sinceIso: string) {
  const { data, error } = await supabase
    .from('feature_windows')
    .select(
      [
        'user_id',
        'user_id_raw',
        'window_start',
        'window_end',
        'video_opened_count',
        'summary_generated_count',
        'summary_latency_ms_total',
        'summary_latency_ms_count',
        'read_completed_count',
        'read_time_ms_total',
        'read_time_ms_count',
        'watch_initiated_count',
        'watch_ended_count',
        'watch_seconds_total',
        'watch_time_since_open_ms_total',
        'watch_time_since_open_ms_count',
        'negative_balance_count'
      ].join(',')
    )
    .gte('window_end', sinceIso);

  if (error) throw error;
  return (data || []) as FeatureWindowRow[];
}

async function upsertRiskScore(
  row: FeatureWindowRow,
  riskScore: number,
  factors: Record<string, unknown>,
  featureSnapshot: FeatureSnapshot,
  insightSummary: string,
  insightBullets: string[],
  riskSource: string,
  model: string | null
) {
  const { error } = await supabase.from('risk_scores').upsert(
    {
      user_id: row.user_id,
      user_id_raw: row.user_id_raw,
      window_start: row.window_start,
      window_end: row.window_end,
      risk_score: riskScore,
      risk_source: riskSource,
      model,
      insight_summary: insightSummary || null,
      insight_bullets: insightBullets,
      feature_snapshot: featureSnapshot,
      factors,
      scored_at: new Date().toISOString()
    },
    { onConflict: 'user_id,window_start' }
  );
  if (error) throw error;
}

async function runScorer() {
  const since = new Date(Date.now() - RISK_SCORE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const windows = await fetchFeatureWindows(since);
  if (windows.length === 0) {
    console.log('[risk-scorer] No feature windows found');
    return;
  }

  for (const window of windows) {
    const snapshot = buildFeatureSnapshot(window);
    try {
      const vertexScore = await scoreWithVertex(snapshot);
      if (vertexScore) {
        await upsertRiskScore(
          window,
          vertexScore.riskScore,
          vertexScore.factors,
          snapshot,
          vertexScore.insightSummary,
          vertexScore.insightBullets,
          'vertex',
          vertexScore.model
        );
        continue;
      }
    } catch (error) {
      console.warn('[risk-scorer] Vertex scoring failed, falling back', error);
    }

    const { riskScore, factors } = computeRisk(window);
    const fallback = buildFallbackInsight(snapshot, riskScore);
    await upsertRiskScore(
      window,
      riskScore,
      factors,
      snapshot,
      fallback.insightSummary,
      fallback.insightBullets,
      'heuristic',
      null
    );
  }

  console.log(`[risk-scorer] Scored ${windows.length} windows`);
}

runScorer().catch((error) => {
  console.error('[risk-scorer] Fatal error', error);
  process.exit(1);
});
