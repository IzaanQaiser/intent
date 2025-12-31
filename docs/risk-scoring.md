# Risk Scoring (MVP)

This job reads `feature_windows` and writes a per-user, per-hour risk score + AI insights to `risk_scores`.

## Setup
1) Apply the SQL in `docs/analytics-schema.sql` (includes `risk_scores` + insight columns).
2) Ensure `.env` contains:
   - `SUPABASE_PROJECT_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

Optional:
- `RISK_SCORE_LOOKBACK_HOURS` (default: 24)
- `VERTEX_GEMINI_MODEL` (default: uses the configured Vertex model)

If you already created `risk_scores`, re-run the SQL file to add the new columns.

RLS note: the analytics tables now include `user_id_raw` and policies restrict reads to the signed-in user.

## Run
```
npm run dev:scorer
```

## Output
Each row in `risk_scores` has:
- `risk_score` in the range 0–1
- `insight_summary` + `insight_bullets`
- `factors` + `feature_snapshot` for debugging
