import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { execFile } from 'child_process';
import { createClient } from '@supabase/supabase-js';

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

app.post('/summarize', async (_req, res) => {
  res.json({
    summary: 'Summary generation is not wired yet. This is a placeholder response.'
  });
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
