import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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
    const userId = typeof req.query.userId === 'string' ? req.query.userId : 'demo';
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
    const { userId, type, data } = req.body || {};
    if (!userId || !type) {
      res.status(400).json({ error: 'Missing userId or type' });
      return;
    }

    let deltaScore = 0;
    let deltaMinutes = 0;

    switch (type) {
      case 'read_completed':
        deltaScore += READ_GAIN_SCORE;
        deltaMinutes += READ_GAIN_MIN;
        break;
      case 'watch_initiated': {
        const minutes = typeof data?.minutes === 'number' ? data.minutes : WATCH_COST_MIN;
        deltaMinutes -= minutes;
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

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
