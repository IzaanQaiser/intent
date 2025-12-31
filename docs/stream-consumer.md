# Stream Consumer (MVP)

This service reads `attention.events.v1` from Confluent and writes derived state + feature windows into Supabase.

## What it writes
- `stream_state`: per-user watch balance, read score, level (stream-derived).
- `feature_windows`: hourly aggregates for analytics and Vertex.
- `user_hash_map`: hashed-to-raw user id map used for RLS filtering.

## Setup
1) Apply the SQL in `docs/analytics-schema.sql` to your Supabase project (includes RLS + user hash map).
2) Ensure `.env` contains:
   - `SUPABASE_PROJECT_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CONFLUENT_BOOTSTRAP_SERVERS`
   - `CONFLUENT_API_KEY`
   - `CONFLUENT_API_SECRET`
   - `CONFLUENT_TOPIC` (optional)
   - `CONFLUENT_GROUP_ID` (optional)

## Run
```
npm run dev:consumer
```

## Notes
- The consumer treats event timestamps as UTC and aggregates into hourly windows.
- `watch_seconds_total` is derived from `watch_progress` deltas and/or `watch_ended` totals.
- `negative_balance_count` increments when the stream-derived balance crosses below 0.
