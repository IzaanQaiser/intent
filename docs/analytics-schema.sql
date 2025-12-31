-- Stream-derived state for event replay and analytics
create table if not exists stream_state (
  user_id text primary key,
  user_id_raw text,
  read_score integer not null default 0,
  watch_balance_minutes integer not null default 0,
  level integer not null default 1,
  updated_at timestamptz not null default now()
);

-- Aggregated feature windows for Vertex + dashboard
create table if not exists feature_windows (
  user_id text not null,
  user_id_raw text,
  window_start timestamptz not null,
  window_end timestamptz not null,
  video_opened_count integer not null default 0,
  summary_generated_count integer not null default 0,
  summary_latency_ms_total bigint not null default 0,
  summary_latency_ms_count integer not null default 0,
  read_completed_count integer not null default 0,
  read_time_ms_total bigint not null default 0,
  read_time_ms_count integer not null default 0,
  watch_initiated_count integer not null default 0,
  watch_ended_count integer not null default 0,
  watch_seconds_total bigint not null default 0,
  watch_time_since_open_ms_total bigint not null default 0,
  watch_time_since_open_ms_count integer not null default 0,
  negative_balance_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, window_start)
);

create index if not exists feature_windows_user_id_idx on feature_windows(user_id);
create index if not exists feature_windows_window_start_idx on feature_windows(window_start);
create index if not exists feature_windows_user_id_raw_idx on feature_windows(user_id_raw);

-- Risk scores derived from feature windows
create table if not exists risk_scores (
  user_id text not null,
  user_id_raw text,
  window_start timestamptz not null,
  window_end timestamptz not null,
  risk_score numeric not null,
  risk_source text not null default 'vertex',
  model text,
  insight_summary text,
  insight_bullets jsonb not null default '[]'::jsonb,
  feature_snapshot jsonb not null default '{}'::jsonb,
  factors jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now(),
  primary key (user_id, window_start)
);

create index if not exists risk_scores_user_id_idx on risk_scores(user_id);
create index if not exists risk_scores_window_start_idx on risk_scores(window_start);
create index if not exists risk_scores_user_id_raw_idx on risk_scores(user_id_raw);

-- Map hashed user_id to raw Supabase user_id for RLS access control
create table if not exists user_hash_map (
  user_id text primary key,
  user_id_raw text not null,
  created_at timestamptz not null default now()
);

create index if not exists user_hash_map_user_id_raw_idx on user_hash_map(user_id_raw);

-- Action-level events for streak + session log
create table if not exists action_events (
  id bigserial primary key,
  user_id_raw text not null,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists action_events_user_id_raw_idx on action_events(user_id_raw);
create index if not exists action_events_occurred_at_idx on action_events(occurred_at);

alter table if exists risk_scores add column if not exists risk_source text not null default 'vertex';
alter table if exists risk_scores add column if not exists model text;
alter table if exists risk_scores add column if not exists insight_summary text;
alter table if exists risk_scores add column if not exists insight_bullets jsonb not null default '[]'::jsonb;
alter table if exists risk_scores add column if not exists feature_snapshot jsonb not null default '{}'::jsonb;
alter table if exists stream_state add column if not exists user_id_raw text;
alter table if exists feature_windows add column if not exists user_id_raw text;
alter table if exists risk_scores add column if not exists user_id_raw text;

-- Row-level security (read your own rows only)
alter table if exists user_state enable row level security;
alter table if exists action_events enable row level security;
alter table if exists stream_state enable row level security;
alter table if exists feature_windows enable row level security;
alter table if exists risk_scores enable row level security;

drop policy if exists "user_state_read_own" on user_state;
create policy "user_state_read_own"
  on user_state
  for select
  using (user_id = auth.uid()::text);

drop policy if exists "user_state_insert_own" on user_state;
create policy "user_state_insert_own"
  on user_state
  for insert
  with check (user_id = auth.uid()::text);

drop policy if exists "user_state_update_own" on user_state;
create policy "user_state_update_own"
  on user_state
  for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists "action_events_read_own" on action_events;
create policy "action_events_read_own"
  on action_events
  for select
  using (user_id_raw = auth.uid()::text);

drop policy if exists "stream_state_read_own" on stream_state;
create policy "stream_state_read_own"
  on stream_state
  for select
  using (user_id_raw = auth.uid()::text);

drop policy if exists "feature_windows_read_own" on feature_windows;
create policy "feature_windows_read_own"
  on feature_windows
  for select
  using (user_id_raw = auth.uid()::text);

drop policy if exists "risk_scores_read_own" on risk_scores;
create policy "risk_scores_read_own"
  on risk_scores
  for select
  using (user_id_raw = auth.uid()::text);
