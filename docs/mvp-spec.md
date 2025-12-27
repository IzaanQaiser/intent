# MVP Spec — Intent

## Problem

Information is abundant, but modern platforms (YouTube, Instagram, TikTok) are psychologically optimized to hijack attention through short-form, dopamine-spiking content. People who genuinely want to learn are routinely pulled into doomscrolling, losing focus, time, and cognitive control.

This product is for people who want to **extract knowledge from online media without sacrificing their attention, discipline, or ability to think critically**.

## Existing Solutions

- App blockers and timers (punitive, remove access)
- Summarizers (optimize speed, not behavior, not intuitive/a solution you use daily)
- Digital wellbeing tools (reduce usage, don’t preserve value)

None directly **convert dopamine-heavy media into low-stimulus, intentional knowledge consumption**.

## Core Insight (Why This Works)

Intervening at the **moment of intent (when a user opens a video)** introduces a read-first alternative that preserves informational value while avoiding passive dopamine loops. Users are free to watch at any time, but watching without sufficient watch hours places them into a **negative balance** that directly reduces their Read Score and slows level progression. Reading is the only way to recover this attention debt. This creates a clear incentive structure where impulsive watching carries an immediate, visible cost, while reading reinforces active cognition, improves retention and self-regulation, and steadily restores progress—shaping intentional behavior without removing user agency or enforcing hard restrictions.

## MVP User Flow

1. User opens a YouTube video
2. Extension intercepts and presents a **Read-First panel** alongside the option to watch
3. AI generates a faithful text version (summary + key points)
4. If the user reads, they increase their **Read Score** and earn **Watch Credits**
5. If the user watches without sufficient credits, they enter a **negative watch balance** that reduces score progression
6. User exits or continues, with progress and balance updated in real time

## MVP Features

- YouTube web interception (Chrome extension)
- Read-First panel with AI-generated textual knowledge output
- **Read Score** based on reading completion and consistency
- **Watch Balance** system:
    - Reading increases balance
    - Watching decreases balance
    - Balance goes negative and impacts score if no watch hours remain
- Real-time feedback showing current balance and score impact
- Minimal session history (local or backend)

## Gamification (MVP only)

- **Read Score:** cumulative indicator of intentional, low-stimulus consumption
- **Watch Balance:** reflects attention surplus or debt (can go negative)
- **Soft friction:** watching is always allowed, but creates visible cost when done impulsively
- **Loss-aware progression:** negative balance slows or pauses score/level growth
- No streaks, no hard blocks, no shame or punitive lockouts

## Data in Motion (Role of Confluent)

User attention is modeled as a **real-time stream of behavioral events**.

- Every meaningful action emits an event:

  - `video_opened`
  - `summary_generated`
  - `read_completed`
  - `balance_increased`
  - `watch_initiated`
  - `balance_decreased`
  - `session_end`

- Events are streamed through **Confluent** topics

- Streaming consumers compute live state:

  - Read Score changes
  - Watch Balance (including negative debt)
  - Session outcome classification (intentional vs impulsive)

- UI reacts in real time to streaming decisions, making the cost of actions immediately visible

Confluent is used **as the behavioral backbone** of the system, enabling real-time intervention and feedback rather than offline analytics.