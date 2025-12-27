# CONFLUENT.md — Role of Confluent in the “Read First” System (MVP)

## What Confluent is doing (1 sentence)
Confluent is the **real-time backbone** that turns user attention into a live event stream so the product can compute gamification state (Watch Balance, Read Score, Level) **immediately** and consistently across sessions/devices later.

---

## Why Confluent is not “just Kafka for compliance”
Most hackathon projects bolt Kafka on as a queue. In this product, streaming is the point:
- The core product promise is **intervention + immediate feedback** (tradeoffs shown instantly).
- That requires a system that treats user behavior as **data in motion**, not batch logs.
- Confluent provides managed Kafka topics, connectors, and stream processing primitives to make this reliable and demoable.

---

## Core idea: Attention as a stream
Every meaningful action is modeled as an **event** (a JSON message) published to Kafka.  
This creates a timeline of user behavior that can be processed in real time.

Examples of actions that become events:
- user opens a video
- summary is generated
- user reads enough to “complete”
- user starts watching
- watch time accumulates
- session ends

This is the same pattern used in real event-driven systems (fraud detection, anomaly detection, personalization), except here the “domain” is **attention control**.

---

## What we stream (MVP event types)
All events are defined in `EVENTS.md`. The MVP should keep the stream small and stable.

### Primary events
- `video_opened`  
  *Starts an intent session.*
- `summary_requested` / `summary_generated`  
  *Measures AI latency + ensures the “read option” is observable.*
- `read_progress` (sampled) / `read_completed`  
  *Detects intentional reading and triggers rewards.*
- `watch_initiated`  
  *Marks the pivot into high-stimulus mode.*
- `balance_updated`  
  *Explicitly records the Watch Balance delta.*
- `score_updated`  
  *Explicitly records Read Score + Level changes.*
- `session_end`  
  *Summarizes outcome and applies end-of-session penalties if needed.*

---

## Topics (how data is organized)
For MVP simplicity:

### Topic 1 — `attention.events.v1`
- Append-only stream of raw user behavior events.
- Produced by:
  - Extension (client-side events)
  - API (summary_generated, etc.)
- Consumed by:
  - Stream consumer/state engine

### (Optional) Topic 2 — `attention.state.v1`
- Stream of **computed state updates** (what the UI should show).
- Produced by:
  - Stream consumer/state engine
- Consumed by:
  - Demo dashboard / logs / (later) extension to sync state

This optional topic makes the hackathon demo extremely clear:  
**events go in → state comes out** in real time.

---

## How Confluent powers the gamification
The gamification system has 3 metrics:
- **Watch Balance (minutes)**: can go negative (attention debt)
- **Read Score**: long-term cumulative
- **Level**: derived from Read Score

Confluent’s role is to ensure these values are computed consistently as events arrive.

### Real-time state computation loop
1. An event hits `attention.events.v1` (e.g., `read_completed`).
2. A consumer reads it instantly.
3. Consumer applies deterministic rules (same rules every time).
4. Consumer emits derived events:
   - `balance_updated`
   - `score_updated`
   - optionally publishes a full state snapshot to `attention.state.v1`
5. UI can reflect the new values immediately.

### Why streaming matters for gamification
Gamification only works if feedback is:
- immediate
- consistent
- auditable (you can show exactly why the state changed)

Streaming gives you:
- a chronological source of truth (event log)
- reproducible state (replay events → recompute)
- the ability to run detection logic live

---

## Gamification logic in streaming terms
Below are the MVP rules in event-driven form.

### Watch Balance rules
- On `read_completed`:
  - emit `balance_updated` with `delta_minutes = +5`
- On watch time (tracked periodically or at end):
  - emit `balance_updated` with `delta_minutes = -watch_minutes`

Balance can go **negative**. That negative value is “attention debt.”

### Read Score + Level rules
- On `read_completed`:
  - emit `score_updated` with `delta_score = +40`
- On `session_end`:
  - if current Watch Balance < 0:
    - emit `score_updated` with `delta_score = -10`

Level is derived:
- `level = floor(readScore / 400) + 1`

The consumer is the “referee” that applies these rules.

---

## What we monitor (and why judges care)
Streaming is valuable because it lets you measure both:
- **system health** (is the app working?)
- **behavior outcomes** (is it changing usage?)

### System/AI metrics (from events)
- Summary latency (`summary_generated.latency_ms`)
- Failure rates (missing transcript, model errors)
- Throughput (# events/sec)
- End-to-end pipeline timing (video_opened → summary_generated)

### Behavior outcomes (from computed state)
- Read completion rate (`read_completed / video_opened`)
- Average watch balance over time
- Frequency of negative balance (attention debt)
- Ratio of “read-first” sessions vs watch-first sessions
- Time saved proxy: sessions with read_completed and minimal watch time

This is what makes the project compelling: it’s not only “AI summarization.”  
It’s measurable, real-time behavior shaping.

---

## Demo story (what to show live)
A clean Confluent demo is:

1. Open a YouTube video → show `video_opened` event appear in the topic
2. Generate summary → show `summary_generated`
3. Click “Read First” (simulate read completion) → show:
   - `read_completed`
   - `balance_updated (+5)`
   - `score_updated (+40)`
4. Click “Watch Now” (simulate watch cost) → show:
   - `watch_initiated`
   - `balance_updated (-X)`
5. Push the balance negative → show:
   - debt visible in UI
   - at `session_end`, `score_updated (-10)` emitted

Judges see the “data in motion” driving UI state and product behavior.

---

## Security + privacy notes (MVP)
For MVP, do NOT stream personal content.
- Stream metadata + interaction signals (video_id, timestamps, durations)
- Summary text should not be logged to Kafka (or keep it optional for demo)

Later:
- add user auth
- encrypt or hash identifiers
- define retention policies

---

## Why Confluent gives this product real scale later
When you expand to mobile / other platforms:
- Every client emits the same event types
- The same stream processors compute the same state
- New clients automatically inherit gamification logic
- You can add more real-time logic without rewriting everything:
  - relapse detection
  - personalized nudges
  - adaptive costs/rewards
  - cohort analytics

Confluent makes the product universal because the “truth” is the event stream.

---

## MVP takeaway
Confluent is used to:
- model attention as real-time data
- compute gamification state deterministically
- provide immediate feedback loops
- make the demo undeniable: **events → stream → state → behavior**

It’s not a bolt-on; it is the backbone.