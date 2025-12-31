import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { Kafka } from 'kafkajs';

dotenv.config();

const SUPABASE_PROJECT_URL = process.env.SUPABASE_PROJECT_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONFLUENT_BOOTSTRAP_SERVERS = process.env.CONFLUENT_BOOTSTRAP_SERVERS;
const CONFLUENT_API_KEY = process.env.CONFLUENT_API_KEY;
const CONFLUENT_API_SECRET = process.env.CONFLUENT_API_SECRET;
const CONFLUENT_TOPIC = process.env.CONFLUENT_TOPIC || 'attention.events.v1';
const CONFLUENT_CLIENT_ID = process.env.CONFLUENT_CLIENT_ID || 'intent-consumer';
const CONFLUENT_GROUP_ID = process.env.CONFLUENT_GROUP_ID || 'intent-analytics-v1';

const READ_GAIN_SCORE = 40;
const READ_GAIN_MIN = 5;
const WATCH_COST_MIN = 10;
const SCORE_PENALTY = 10;

const STREAM_STATE_TABLE = 'stream_state';
const FEATURE_WINDOW_TABLE = 'feature_windows';
const USER_HASH_TABLE = 'user_hash_map';

if (!SUPABASE_PROJECT_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase env vars. Set SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

if (!CONFLUENT_BOOTSTRAP_SERVERS || !CONFLUENT_API_KEY || !CONFLUENT_API_SECRET) {
  throw new Error('Missing Confluent env vars. Set CONFLUENT_BOOTSTRAP_SERVERS, CONFLUENT_API_KEY, CONFLUENT_API_SECRET.');
}

const supabase = createClient(SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

type StreamEvent = {
  event_id: string;
  event_type: string;
  timestamp?: string;
  user_id: string;
  session_id?: string;
  video_id?: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

type StreamState = {
  userId: string;
  userIdRaw: string | null;
  readScore: number;
  watchBalanceMinutes: number;
};

type FeatureWindow = {
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
  updated_at: string;
};

type SessionWatchState = {
  lastTotalSeconds: number;
  lastUpdatedAt: number;
};

const sessionWatchCache = new Map<string, SessionWatchState>();
const userHashCache = new Map<string, { rawId: string | null; fetchedAt: number }>();
const USER_HASH_TTL_MS = 10 * 60 * 1000;

const computeLevel = (readScore: number) => Math.floor(readScore / 400) + 1;
const normalizeWhole = (value: number) => {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? Math.ceil(value) : -Math.ceil(Math.abs(value));
};

const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const toWindowStart = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), 0, 0, 0));

const toWindowEnd = (windowStart: Date) => new Date(windowStart.getTime() + 60 * 60 * 1000);

function parseEventTimestamp(event: StreamEvent, fallbackMs: string | null) {
  if (event.timestamp) {
    const parsed = new Date(event.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (fallbackMs) {
    const fallback = new Date(Number(fallbackMs));
    if (!Number.isNaN(fallback.getTime())) {
      return fallback;
    }
  }
  return new Date();
}

async function resolveRawUserId(hashedUserId: string): Promise<string | null> {
  const cached = userHashCache.get(hashedUserId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < USER_HASH_TTL_MS) {
    return cached.rawId;
  }

  const { data, error } = await supabase
    .from(USER_HASH_TABLE)
    .select('user_id_raw')
    .eq('user_id', hashedUserId)
    .maybeSingle();

  if (error) {
    console.warn('[consumer] Failed to resolve user hash map', error.message);
    return cached?.rawId ?? null;
  }

  const rawId = data?.user_id_raw ?? null;
  userHashCache.set(hashedUserId, { rawId, fetchedAt: now });
  return rawId;
}

async function getOrCreateStreamState(userId: string, userIdRaw: string | null): Promise<StreamState> {
  const { data: existing, error } = await supabase
    .from(STREAM_STATE_TABLE)
    .select('user_id, user_id_raw, read_score, watch_balance_minutes')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  if (existing) {
    if (userIdRaw && existing.user_id_raw !== userIdRaw) {
      const { error: updateError } = await supabase
        .from(STREAM_STATE_TABLE)
        .update({ user_id_raw: userIdRaw })
        .eq('user_id', userId);
      if (updateError) {
        console.warn('[consumer] Failed to update stream_state user_id_raw', updateError.message);
      }
    }
    return {
      userId: existing.user_id,
      userIdRaw: existing.user_id_raw ?? null,
      readScore: existing.read_score,
      watchBalanceMinutes: existing.watch_balance_minutes
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from(STREAM_STATE_TABLE)
    .insert({ user_id: userId, user_id_raw: userIdRaw, read_score: 0, watch_balance_minutes: 0 })
    .select('user_id, user_id_raw, read_score, watch_balance_minutes')
    .single();

  if (insertError) throw insertError;
  return {
    userId: inserted.user_id,
    userIdRaw: inserted.user_id_raw ?? null,
    readScore: inserted.read_score,
    watchBalanceMinutes: inserted.watch_balance_minutes
  };
}

async function updateStreamState(userId: string, userIdRaw: string | null, deltaScore: number, deltaMinutes: number) {
  const state = await getOrCreateStreamState(userId, userIdRaw);
  const nextScore = state.readScore + deltaScore;
  const nextBalance = state.watchBalanceMinutes + deltaMinutes;
  const negativeBalanceTriggered = state.watchBalanceMinutes >= 0 && nextBalance < 0;

  if (deltaScore !== 0 || deltaMinutes !== 0) {
    const { error } = await supabase
      .from(STREAM_STATE_TABLE)
      .update({
        read_score: nextScore,
        watch_balance_minutes: nextBalance,
        user_id_raw: userIdRaw,
        level: computeLevel(nextScore),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) throw error;
  }

  return {
    previous: state,
    next: {
      userId,
      userIdRaw,
      readScore: nextScore,
      watchBalanceMinutes: nextBalance
    },
    negativeBalanceTriggered
  };
}

async function getFeatureWindow(
  userId: string,
  userIdRaw: string | null,
  windowStart: Date,
  windowEnd: Date
): Promise<FeatureWindow> {
  const windowStartIso = windowStart.toISOString();
  const { data: existing, error } = await supabase
    .from(FEATURE_WINDOW_TABLE)
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
        'negative_balance_count',
        'updated_at'
      ].join(',')
    )
    .eq('user_id', userId)
    .eq('window_start', windowStartIso)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    return existing as FeatureWindow;
  }

  const empty: FeatureWindow = {
    user_id: userId,
    user_id_raw: userIdRaw,
    window_start: windowStartIso,
    window_end: windowEnd.toISOString(),
    video_opened_count: 0,
    summary_generated_count: 0,
    summary_latency_ms_total: 0,
    summary_latency_ms_count: 0,
    read_completed_count: 0,
    read_time_ms_total: 0,
    read_time_ms_count: 0,
    watch_initiated_count: 0,
    watch_ended_count: 0,
    watch_seconds_total: 0,
    watch_time_since_open_ms_total: 0,
    watch_time_since_open_ms_count: 0,
    negative_balance_count: 0,
    updated_at: new Date().toISOString()
  };

  const { error: insertError } = await supabase.from(FEATURE_WINDOW_TABLE).insert(empty);
  if (insertError) throw insertError;
  return empty;
}

async function upsertFeatureWindow(next: FeatureWindow) {
  const { error } = await supabase.from(FEATURE_WINDOW_TABLE).upsert(next, {
    onConflict: 'user_id,window_start'
  });
  if (error) throw error;
}

function cleanupSessionCache(nowMs: number) {
  if (sessionWatchCache.size < 500) return;
  const cutoff = nowMs - 4 * 60 * 60 * 1000;
  for (const [sessionId, entry] of sessionWatchCache) {
    if (entry.lastUpdatedAt < cutoff) {
      sessionWatchCache.delete(sessionId);
    }
  }
}

function computeWatchSecondsDelta(
  event: StreamEvent,
  data: Record<string, unknown>,
  nowMs: number
): number {
  const delta = asNumber(data.watch_seconds_delta);
  const totalSeconds =
    asNumber(data.watch_seconds_total) ?? asNumber(data.total_watch_seconds);
  const sessionId = typeof event.session_id === 'string' ? event.session_id : null;

  if (sessionId && totalSeconds !== null) {
    const existing = sessionWatchCache.get(sessionId);
    const last = existing?.lastTotalSeconds ?? 0;
    const next = Math.max(last, totalSeconds);
    sessionWatchCache.set(sessionId, { lastTotalSeconds: next, lastUpdatedAt: nowMs });
    const computedDelta = Math.max(0, totalSeconds - last);
    if (event.event_type === 'watch_ended') {
      sessionWatchCache.delete(sessionId);
    }
    return computedDelta;
  }

  if (delta !== null && delta > 0) {
    return delta;
  }

  if (totalSeconds !== null && totalSeconds > 0) {
    return totalSeconds;
  }

  return 0;
}

async function processEvent(event: StreamEvent, messageTimestamp: string | null) {
  if (!event.user_id || !event.event_type) return;

  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const now = new Date();
  const eventTime = parseEventTimestamp(event, messageTimestamp);
  const windowStart = toWindowStart(eventTime);
  const windowEnd = toWindowEnd(windowStart);
  const userIdRaw = await resolveRawUserId(event.user_id);

  let deltaScore = 0;
  let deltaMinutes = 0;
  let negativeBalanceTriggered = false;

  switch (event.event_type) {
    case 'read_completed':
      deltaScore += asNumber(data.score) ?? READ_GAIN_SCORE;
      deltaMinutes += asNumber(data.minutes) ?? READ_GAIN_MIN;
      break;
    case 'watch_initiated':
      deltaMinutes -= asNumber(data.minutes) ?? WATCH_COST_MIN;
      deltaScore -= asNumber(data.score) ?? 0;
      break;
    case 'session_end': {
      const state = await getOrCreateStreamState(event.user_id, userIdRaw);
      if (state.watchBalanceMinutes < 0) {
        deltaScore -= SCORE_PENALTY;
      }
      break;
    }
    default:
      break;
  }

  deltaScore = normalizeWhole(deltaScore);
  deltaMinutes = normalizeWhole(deltaMinutes);

  if (deltaScore !== 0 || deltaMinutes !== 0 || event.event_type === 'session_end') {
    const stateUpdate = await updateStreamState(event.user_id, userIdRaw, deltaScore, deltaMinutes);
    negativeBalanceTriggered = stateUpdate.negativeBalanceTriggered;
  }

  const currentWindow = await getFeatureWindow(event.user_id, userIdRaw, windowStart, windowEnd);
  const nextWindow: FeatureWindow = {
    ...currentWindow,
    user_id_raw: userIdRaw,
    updated_at: now.toISOString()
  };

  const watchSecondsDelta = computeWatchSecondsDelta(event, data, now.getTime());

  switch (event.event_type) {
    case 'video_opened':
      nextWindow.video_opened_count += 1;
      break;
    case 'summary_generated': {
      nextWindow.summary_generated_count += 1;
      const latency = asNumber(data.latency_ms);
      if (latency !== null) {
        nextWindow.summary_latency_ms_total += Math.round(latency);
        nextWindow.summary_latency_ms_count += 1;
      }
      break;
    }
    case 'read_completed': {
      nextWindow.read_completed_count += 1;
      const readTime = asNumber(data.read_time_ms);
      if (readTime !== null) {
        nextWindow.read_time_ms_total += Math.round(readTime);
        nextWindow.read_time_ms_count += 1;
      }
      break;
    }
    case 'watch_initiated': {
      nextWindow.watch_initiated_count += 1;
      const timeSinceOpen = asNumber(data.time_since_open_ms);
      if (timeSinceOpen !== null) {
        nextWindow.watch_time_since_open_ms_total += Math.round(timeSinceOpen);
        nextWindow.watch_time_since_open_ms_count += 1;
      }
      break;
    }
    case 'watch_progress':
      if (watchSecondsDelta > 0) {
        nextWindow.watch_seconds_total += Math.round(watchSecondsDelta);
      }
      break;
    case 'watch_ended':
      nextWindow.watch_ended_count += 1;
      if (watchSecondsDelta > 0) {
        nextWindow.watch_seconds_total += Math.round(watchSecondsDelta);
      }
      break;
    default:
      break;
  }

  if (negativeBalanceTriggered) {
    nextWindow.negative_balance_count += 1;
  }

  await upsertFeatureWindow(nextWindow);
  cleanupSessionCache(now.getTime());
}

async function runConsumer() {
  const brokers =
    CONFLUENT_BOOTSTRAP_SERVERS?.split(',').map((broker) => broker.trim()).filter(Boolean) ?? [];
  if (brokers.length === 0) {
    throw new Error('No Confluent brokers configured.');
  }

  const kafka = new Kafka({
    clientId: CONFLUENT_CLIENT_ID,
    brokers,
    ssl: true,
    sasl: {
      mechanism: 'plain',
      username: CONFLUENT_API_KEY ?? '',
      password: CONFLUENT_API_SECRET ?? ''
    }
  });

  const consumer = kafka.consumer({ groupId: CONFLUENT_GROUP_ID });
  await consumer.connect();
  await consumer.subscribe({ topic: CONFLUENT_TOPIC, fromBeginning: false });

  console.log(`[consumer] Connected to ${CONFLUENT_TOPIC} as ${CONFLUENT_GROUP_ID}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      const rawValue = message.value?.toString();
      if (!rawValue) return;
      let parsed: StreamEvent | null = null;
      try {
        parsed = JSON.parse(rawValue) as StreamEvent;
      } catch (error) {
        console.warn('[consumer] Invalid JSON payload', error);
        return;
      }
      try {
        await processEvent(parsed, message.timestamp);
      } catch (error) {
        console.error('[consumer] Failed to process event', error);
      }
    }
  });
}

runConsumer().catch((error) => {
  console.error('[consumer] Fatal error', error);
  process.exit(1);
});
