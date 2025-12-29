# Streaming + Vertex Plan (Draft)

## Goal
Keep the current product flow and Supabase state as-is, but mirror every user action into Confluent to unlock real-time analytics and Vertex-powered risk predictions. The UI stays fast and simple, while the stream becomes the behavioral source of truth and the dashboard becomes the insight layer.

## Why this plan
- Supabase remains the low-friction state store for the extension UI.
- Confluent provides a complete, ordered event log (auditable + replayable).
- Vertex adds predictive power: “when is this user likely to fold?”
- A user-facing dashboard can show trends and risk windows without changing the core UX.

## Data flow (high level)
1. Extension + API emit events → `attention.events.v1` (Confluent).
2. Stream consumer derives features + aggregates.
3. Vertex model scores risk windows from those features.
4. Dashboard reads:
   - raw aggregates (Confluent → DB)
   - risk scores (Vertex output)

## Events to stream (MVP)
- `video_opened`
- `summary_requested`
- `summary_generated`
- `read_progress`
- `read_completed`
- `watch_initiated`
- `watch_time`
- `session_end`

All events should include at least:
- `user_id` (hashed)
- `video_id`
- `timestamp`
- `session_id`
- `context` (device, page type)

## Feature examples for Vertex
- Time of day / day of week
- Watch balance trend over last N sessions
- Ratio: read_completed / video_opened
- Average watch_time per session
- Frequency of negative balance
- Time-to-watch after video_opened

## Outputs (for dashboard)
- Risk score (0–1) per user + time window
- “High risk hours” heatmap
- Streak of intentional sessions
- Relapse likelihood curve

## Storage
- Supabase: current state (read score, balance, level)
- Analytics DB (or Supabase): aggregated features
- Confluent: event log + optional `attention.state.v1`

## Privacy
- Do not stream transcript content.
- Keep IDs hashed.
- Store only metadata (timestamps, durations, deltas).

## Next steps (implementation)
1. Add event schema + event publisher to backend.
2. Publish all extension events to Confluent.
3. Build a small consumer that writes features to DB.
4. Create a Vertex model stub + scoring job.
5. Add a lightweight dashboard that visualizes risk + history.
