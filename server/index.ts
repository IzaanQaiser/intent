import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { execFile } from 'child_process';
import { createHmac, randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { VertexAI } from '@google-cloud/vertexai';
import { Kafka, Partitioners } from 'kafkajs';

dotenv.config();

const SUPABASE_PROJECT_URL = process.env.SUPABASE_PROJECT_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = Number(process.env.API_PORT || 8787);

if (!SUPABASE_PROJECT_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase env vars. Set SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();
app.use(cors());
app.use(express.json());

const READ_GAIN_SCORE = 40;
const READ_GAIN_MIN = 5;
const WATCH_COST_MIN = 10;
const SCORE_PENALTY = 10;

const computeLevel = (readScore: number) => Math.floor(readScore / 400) + 1;
const TRANSCRIPT_SCRIPT = path.resolve(process.cwd(), 'scripts', 'transcriptgrab.py');
const VERTEX_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_GEMINI_MODEL = process.env.VERTEX_GEMINI_MODEL;
const VERTEX_MODEL_FALLBACKS = [
  'gemini-1.5-flash-001',
  'gemini-1.5-pro-001',
  'gemini-1.0-pro-001'
];
const MAX_TRANSCRIPT_CHARS = 20000;
const CONFLUENT_BOOTSTRAP_SERVERS = process.env.CONFLUENT_BOOTSTRAP_SERVERS;
const CONFLUENT_API_KEY = process.env.CONFLUENT_API_KEY;
const CONFLUENT_API_SECRET = process.env.CONFLUENT_API_SECRET;
const CONFLUENT_TOPIC = process.env.CONFLUENT_TOPIC || 'attention.events.v1';
const CONFLUENT_CLIENT_ID = process.env.CONFLUENT_CLIENT_ID || 'intent-extension';
const EVENT_HASH_SALT = process.env.EVENT_HASH_SALT || 'intent';
const CONFLUENT_ENABLED = Boolean(
  CONFLUENT_BOOTSTRAP_SERVERS && CONFLUENT_API_KEY && CONFLUENT_API_SECRET
);

let confluentProducer: ReturnType<Kafka['producer']> | null = null;

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type PythonCommand = {
  cmd: string;
  extraArgs?: string[];
};

const pythonCandidates: PythonCommand[] =
  process.platform === 'win32'
    ? [
        { cmd: 'py', extraArgs: ['-3'] },
        { cmd: 'python' },
        { cmd: 'python3' }
      ]
    : [{ cmd: 'python3' }, { cmd: 'python' }];

function execFileWithCode(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number };
          if (err.code === 'ENOENT') {
            reject(err);
            return;
          }
          resolve({
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? '')
          });
          return;
        }
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

async function runTranscriptGrab(target: string, lang: string) {
  const args = [TRANSCRIPT_SCRIPT, target, '--lang', lang, '--format', 'json'];
  let lastError: Error | null = null;

  for (const candidate of pythonCandidates) {
    const fullArgs = [...(candidate.extraArgs ?? []), ...args];
    try {
      return await execFileWithCode(candidate.cmd, fullArgs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Python executable not found (tried ${pythonCandidates.map((c) => c.cmd).join(', ')})${
      lastError ? `: ${lastError.message}` : ''
    }`
  );
}

type TranscriptResult = {
  transcript: string;
  language?: string;
  source?: string;
};

type SummaryResult = {
  title: string;
  summary: string;
  keyPoints: string[];
  readingTimeMinutes: number;
};

type StreamEvent = {
  event_id: string;
  event_type: string;
  timestamp: string;
  user_id: string;
  session_id?: string;
  video_id?: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

function hashUserId(userId: string) {
  return createHmac('sha256', EVENT_HASH_SALT).update(userId).digest('hex');
}

async function getConfluentProducer() {
  if (!CONFLUENT_ENABLED) return null;
  if (confluentProducer) return confluentProducer;
  const brokers = CONFLUENT_BOOTSTRAP_SERVERS?.split(',').map((broker) => broker.trim()).filter(Boolean) ?? [];
  if (brokers.length === 0) return null;
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
  const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
  try {
    await producer.connect();
  } catch (error) {
    await producer.disconnect().catch(() => undefined);
    throw error;
  }
  confluentProducer = producer;
  return producer;
}

async function publishStreamEvent(event: StreamEvent) {
  if (!CONFLUENT_ENABLED) {
    return { ok: false, skipped: true } as const;
  }
  const sendEvent = async () => {
    const producer = await getConfluentProducer();
    if (!producer) {
      return { ok: false, skipped: true } as const;
    }
    await producer.send({
      topic: CONFLUENT_TOPIC,
      messages: [
        {
          key: event.user_id,
          value: JSON.stringify(event)
        }
      ]
    });
    return { ok: true } as const;
  };

  try {
    return await sendEvent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('producer is disconnected')) {
      if (confluentProducer) {
        await confluentProducer.disconnect().catch(() => undefined);
        confluentProducer = null;
      }
      return await sendEvent();
    }
    throw error;
  }
}

function normalizeModelName(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/models\/([A-Za-z0-9._-]+)/);
  if (match?.[1]) {
    return match[1];
  }
  return trimmed;
}

function parseTranscriptPayload(raw: string): TranscriptResult | null {
  try {
    const payload = JSON.parse(raw);
    if (!payload?.transcript || typeof payload.transcript !== 'string') {
      return null;
    }
    return {
      transcript: payload.transcript,
      language: typeof payload.language === 'string' ? payload.language : undefined,
      source: typeof payload.source === 'string' ? payload.source : undefined
    };
  } catch {
    return null;
  }
}

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function normalizeKeyPoints(value: unknown): string[] {
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

function estimateReadingTimeMinutes(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return minutes;
}

async function fetchTranscriptText(target: string, lang: string) {
  const result = await runTranscriptGrab(target, lang);
  if (result.code === 0) {
    return parseTranscriptPayload(result.stdout);
  }
  if (result.code === 2) {
    return null;
  }
  throw new Error(result.stderr || 'Failed to fetch transcript');
}

function buildSummaryPrompt(params: {
  title: string;
  durationSeconds?: number | null;
  transcript: string;
}) {
  const durationMinutes =
    typeof params.durationSeconds === 'number' && Number.isFinite(params.durationSeconds)
      ? Math.max(1, Math.round(params.durationSeconds / 60))
      : null;
  const durationLabel = durationMinutes ? `${durationMinutes} minutes` : 'Unknown';
  const transcript =
    params.transcript.length > MAX_TRANSCRIPT_CHARS
      ? `${params.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated]`
      : params.transcript;

  return `You are generating a \"Read First\" brief from a YouTube transcript.\n\n` +
    `Return ONLY valid JSON with the following keys:\n` +
    `- title: string\n` +
    `- summary: string (5-8 sentences, faithful to the transcript)\n` +
    `- key_points: array of 5 concise bullet strings\n` +
    `- reading_time_minutes: integer\n\n` +
    `Title: ${params.title}\n` +
    `Video length: ${durationLabel}\n` +
    `Transcript:\n${transcript}\n`;
}

async function generateSummary(params: {
  title: string;
  durationSeconds?: number | null;
  transcript: string;
}): Promise<SummaryResult> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI.');
  }
  const configuredModel = normalizeModelName(VERTEX_GEMINI_MODEL ?? undefined);
  const modelCandidates = [
    ...(configuredModel ? [configuredModel] : []),
    ...VERTEX_MODEL_FALLBACKS
  ];
  const vertexAI = new VertexAI({ project: VERTEX_PROJECT_ID, location: VERTEX_LOCATION });
  const prompt = buildSummaryPrompt(params);
  let lastError: Error | null = null;

  for (const modelName of modelCandidates) {
    console.log('[summarize] Vertex config', {
      project: VERTEX_PROJECT_ID,
      location: VERTEX_LOCATION,
      model: modelName,
      configuredModel: configuredModel || undefined,
      configuredModelRaw: VERTEX_GEMINI_MODEL || undefined
    });
    try {
      const model = vertexAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: 1024,
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

      const summaryText = typeof parsed.summary === 'string' ? parsed.summary.trim() : text.trim();
      const keyPoints = normalizeKeyPoints(parsed.key_points);
      const readingTime = estimateReadingTimeMinutes(
        [summaryText, ...keyPoints].join(' ')
      );
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : params.title;

      return {
        title: title || 'Read First Brief',
        summary: summaryText,
        keyPoints,
        readingTimeMinutes: readingTime
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn('[summarize] Vertex model failed', modelName, lastError.message);
    }
  }

  throw lastError || new Error('Vertex model failed');
}

async function getOrCreateState(userId: string) {
  const { data: existing, error } = await supabase
    .from('user_state')
    .select('user_id, read_score, watch_balance_minutes')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    return {
      userId: existing.user_id,
      readScore: existing.read_score,
      watchBalanceMinutes: existing.watch_balance_minutes
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('user_state')
    .insert({ user_id: userId, read_score: 0, watch_balance_minutes: 0 })
    .select('user_id, read_score, watch_balance_minutes')
    .single();

  if (insertError) throw insertError;

  return {
    userId: inserted.user_id,
    readScore: inserted.read_score,
    watchBalanceMinutes: inserted.watch_balance_minutes
  };
}

async function updateState(userId: string, deltaScore: number, deltaMinutes: number) {
  const state = await getOrCreateState(userId);
  const nextScore = state.readScore + deltaScore;
  const nextBalance = state.watchBalanceMinutes + deltaMinutes;

  const { error } = await supabase
    .from('user_state')
    .update({
      read_score: nextScore,
      watch_balance_minutes: nextBalance,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);

  if (error) throw error;

  return {
    userId,
    readScore: nextScore,
    watchBalanceMinutes: nextBalance,
    level: computeLevel(nextScore)
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/state', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }
    const userId = data.user.id;
    const state = await getOrCreateState(userId);
    res.json({
      userId: state.userId,
      readScore: state.readScore,
      watchBalanceMinutes: state.watchBalanceMinutes,
      level: computeLevel(state.readScore)
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/stream', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }
    const userId = authData.user.id;
    const { type, videoId, sessionId, data, context } = req.body || {};
    if (!type) {
      res.status(400).json({ error: 'Missing type' });
      return;
    }

    const event: StreamEvent = {
      event_id: randomUUID(),
      event_type: String(type),
      timestamp: new Date().toISOString(),
      user_id: hashUserId(userId),
      session_id: typeof sessionId === 'string' ? sessionId : undefined,
      video_id: typeof videoId === 'string' ? videoId : undefined,
      data: data && typeof data === 'object' ? data : undefined,
      context: context && typeof context === 'object' ? context : undefined
    };

    try {
      const result = await publishStreamEvent(event);
      if (result.ok || result.skipped) {
        res.json({ ok: true, streamed: result.ok });
        return;
      }
      res.json({ ok: false, error: 'Failed to publish event' });
    } catch (error) {
      console.error('[stream] Publish failed', error);
      res.json({ ok: false, error: String(error) });
    }
  } catch (error) {
    console.error('[stream] Error', error);
    res.json({ ok: false, error: String(error) });
  }
});

app.post('/event', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }
    const userId = authData.user.id;
    const { type, data } = req.body || {};
    if (!type) {
      res.status(400).json({ error: 'Missing type' });
      return;
    }

    let deltaScore = 0;
    let deltaMinutes = 0;

    switch (type) {
      case 'read_completed': {
        const minutes = typeof data?.minutes === 'number' ? data.minutes : READ_GAIN_MIN;
        const score = typeof data?.score === 'number' ? data.score : READ_GAIN_SCORE;
        deltaScore += score;
        deltaMinutes += minutes;
        break;
      }
      case 'watch_initiated': {
        const minutes = typeof data?.minutes === 'number' ? data.minutes : WATCH_COST_MIN;
        deltaMinutes -= minutes;
        const score = typeof data?.score === 'number' ? data.score : 0;
        deltaScore -= score;
        break;
      }
      case 'session_end': {
        const state = await getOrCreateState(userId);
        if (state.watchBalanceMinutes < 0) {
          deltaScore -= SCORE_PENALTY;
        }
        break;
      }
      default:
        break;
    }

    const updated = await updateState(userId, deltaScore, deltaMinutes);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/summarize', async (req, res) => {
  try {
    const { videoId, url, title, durationSeconds, lang } = req.body || {};
    const target =
      typeof url === 'string' && url.trim()
        ? url.trim()
        : typeof videoId === 'string' && videoId.trim()
          ? `https://www.youtube.com/watch?v=${videoId.trim()}`
          : '';
    if (!target) {
      res.status(400).json({ error: 'Missing videoId or url' });
      return;
    }
    const language = typeof lang === 'string' && lang.trim() ? lang.trim() : 'en';
    console.log('[summarize] Request', {
      target,
      language,
      titleLength: typeof title === 'string' ? title.length : 0,
      durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : null
    });
    const transcriptPayload = await fetchTranscriptText(target, language);
    if (!transcriptPayload?.transcript) {
      console.warn('[summarize] Transcript missing');
      res.status(404).json({ error: 'No transcript available for this video' });
      return;
    }
    console.log('[summarize] Transcript loaded', {
      length: transcriptPayload.transcript.length,
      source: transcriptPayload.source,
      language: transcriptPayload.language
    });
    const summary = await generateSummary({
      title: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled video',
      durationSeconds:
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? durationSeconds
          : null,
      transcript: transcriptPayload.transcript
    });
    res.json({
      ...summary,
      source: transcriptPayload.source,
      language: transcriptPayload.language
    });
  } catch (error) {
    console.error('[summarize] Error', error);
    res.status(500).json({ error: String(error) });
  }
});

app.post('/transcript', async (req, res) => {
  try {
    const { videoId, url, lang } = req.body || {};
    const target =
      typeof url === 'string' && url.trim()
        ? url.trim()
        : typeof videoId === 'string' && videoId.trim()
          ? `https://www.youtube.com/watch?v=${videoId.trim()}`
          : '';
    if (!target) {
      res.status(400).json({ error: 'Missing videoId or url' });
      return;
    }
    const language = typeof lang === 'string' && lang.trim() ? lang.trim() : 'en';
    const result = await runTranscriptGrab(target, language);
    if (result.code === 0) {
      const payload = JSON.parse(result.stdout);
      if (!payload?.transcript) {
        res.status(404).json({ error: 'No transcript available for this video' });
        return;
      }
      res.json(payload);
      return;
    }
    if (result.code === 2) {
      res.status(404).json({ error: 'No transcript available for this video' });
      return;
    }
    res.status(500).json({ error: result.stderr || 'Failed to fetch transcript' });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
