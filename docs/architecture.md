# Architecture (MVP)

## Goal
Convert dopamine-heavy video consumption into intentional reading by intervening on YouTube web, and model user behavior as a real-time stream using Confluent.

## Components
1. **Chrome Extension (TS + React)**
   - Content script intercepts YouTube watch pages and renders the Read-First panel.
   - Tracks user actions (open, summary shown, read progress, watch initiated).
   - Sends events to the backend ingestion endpoint.

2. **API (Google Cloud Run, Node/TS)**
   - `POST /summarize`: fetches transcript (or accepts provided text) and calls Gemini/Vertex to generate the read-first output.
   - `POST /event`: validates and forwards events to Confluent (Kafka).
   - `GET /health`: basic health check for demo.

3. **Confluent Cloud (Kafka)**
   - Topic `attention.events.v1`: append-only stream of behavior events defined in EVENTS.md.
   - (Optional) Topic `attention.state.v1`: computed state updates for demo visibility.

4. **Stream Consumer (Node/TS)**
   - Subscribes to `attention.events.v1`.
   - Computes session/user state: Watch Balance (can go negative) + Read Score + Level.
   - Emits state updates to `attention.state.v1` and/or logs for demo.

## Data Flow (happy path)
1. User opens a YouTube video → extension emits `video_opened`.
2. Extension requests summary → API calls Gemini/Vertex → extension shows text → emits `summary_generated`.
3. User reads → emits `read_progress` → `read_completed`.
4. Consumer applies rules → emits `balance_updated` and `score_updated`.
5. If user watches, extension emits `watch_initiated`; consumer decreases balance (may go negative).