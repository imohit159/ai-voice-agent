# Implementation decisions

Decisions taken on 16 October 2026 for migrating the current codebase to the
[customer care voice agent architecture](customer-care-voice-agent-architecture.md).
Change a decision here before changing the code that depends on it.

## Approach

| #   | Decision        | Choice                                                                                                                                                                                       |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Migration       | Evolve this repository in stages; no greenfield rewrite.                                                                                                                                     |
| 2   | API framework   | Keep Fastify.                                                                                                                                                                                |
| 3   | AI approach     | Both, selectable: Gemini Live (speech-to-speech) and Sarvam STT → `sarvam-105b-conversations` → Sarvam TTS (cascaded). `sarvam-m` was replaced in stage 4: Pipecat 1.12 does not support it. |
| 4   | Practice mode   | Keep, served by Pipecat's WebRTC transport running the same bot as phone calls. Test-only call mode.                                                                                         |
| 5   | Business system | Not yet available. Define contracts from the architecture brief and ship a mock business system for E2E.                                                                                     |
| 6   | First use case  | Order confirmation.                                                                                                                                                                          |

## Infrastructure

| #   | Decision         | Choice                                                                                                                                                     |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Persistence      | SQLite (WAL). The Node API is the only writer.                                                                                                             |
| 8   | Runtime          | Docker Compose: `api`, `voice-agent`, Caddy (TLS reverse proxy). Same topology in dev and production.                                                      |
| 9   | Node ↔ Pipecat   | Pipecat fetches call context from, and posts tool calls and transcript events to, a private Node API. Shared service token on the internal Docker network. |
| 10  | Dashboard        | Rewrite in React + Vite; Pipecat React client for practice calls.                                                                                          |
| 11  | Dashboard access | Multiple users with `admin` and `viewer` roles; hashed passwords; audit log of transcript access.                                                          |
| 12  | Business auth    | HMAC-SHA256 over timestamp + body in both directions; 5-minute replay window.                                                                              |

## Policy

| #   | Decision       | Choice                                                                                                                                                        |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | Calling policy | Default window 10:00–19:00 IST; 3 attempts; unanswered/busy retried after 30 min, then 2 h. Requests may narrow, never widen, these bounds.                   |
| 14  | Outcomes       | `confirmed`, `cancel_requested`, `change_requested`, `callback_requested`, `wrong_person`, `needs_follow_up`. v1 records requests; it does not apply changes. |
| 15  | Identity check | Confirm the customer's name before disclosing order details. No or unclear answer → `wrong_person`, nothing disclosed.                                        |
| 16  | Data policy    | Text transcripts kept 90 days, then deleted. No call audio recording. Phone numbers masked in logs.                                                           |
| 17  | Capacity       | Up to 10 simultaneous live calls. Excess attempts wait in the schedule within their calling window.                                                           |

## Constraints that follow from these decisions

- The AI provider configuration is snapshotted on each attempt and never changes during a call.
- The two AI pipelines share one bot: transport, turn handling, tools and transcript capture. Only the model stage differs.
- A model tool call is a request. The Node API validates every action against the request's allowed actions before recording it.
- Unanswered-call retries and result-delivery retries are separate state machines. Exhausted delivery never triggers a new customer call.

## Build stages

Each table is added in the stage that first uses it.

1. **Contracts and intake.** ✅ Call request/result contracts ([integration contract](integration-contract.md)), HMAC signing, versioned SQLite migrations, `call_requests` table, signed intake endpoint, mock business system (sender).
2. **Call management.** ✅ `call_attempts` and `result_deliveries` tables; `call-management` module (scheduler with calling hours, retry backoff, concurrency limit, restart recovery, reconciliation) behind a telephony port with a simulated provider; transactional result outbox with signed, retried delivery; mock business system result receiver.
3. **Plivo.** ✅ Plivo telephony adapter (dial, V3-signed ring/answer/hangup callbacks, hangup-cause mapping, call-record reconciliation), `<Stream>` answer XML with a short-lived voice-session token, Plivo as the default provider with startup validation. Exotel removed; the legacy voice module now serves browser practice only.
4. **Pipecat service.** ✅ Python service (`services/voice-agent`, Pipecat 1.12) with the Plivo stream (V3-verified) and WebRTC practice, both AI stages sharing one bot, internal session API (claim once, transcript batches, end) with Node as sole writer, `transcript_entries` table, voice-agent readiness gating for dialling. Legacy Node voice module, calls module and browser worklet removed; AI keys moved to the voice agent only.
5. **Order confirmation.** ✅ Conversation plan (AI disclosure, identity check before any order detail, read-back, decision), `record_outcome` and `end_call` tools, API validation of every reported outcome (allowed for the use case, callback time only for `callback_requested` and within 7 days, one immutable outcome per attempt), outcome delivered in the result, guaranteed spoken goodbye before the cascade hangs up.
6. **Dashboard.** ✅ React dashboard (feature folders, one API client, TanStack Query for server state) with practice, call activity and transcripts, result delivery with manual retry, agent settings, and team access. `users` (admin/viewer, scrypt passwords, per-user session versions so disabling or changing a user signs them out everywhere) and `audit_events` (sign-ins, customer transcript views, settings, user changes, delivery retries). Kept the existing design system instead of shadcn/ui (that would need a Tailwind migration); practice keeps the API-proxied browser WebRTC client instead of Pipecat's React client, so the session token never reaches the browser.
7. **Deployment.** Docker Compose, Caddy, secrets, retention job, backups, end-to-end and concurrency tests.

## Response delay requirement

Agreed 16 October 2026: from the customer stopping speaking to the agent's voice starting, **median ≤ 1.0 s and 95% of turns ≤ 1.5 s, measured on real Plivo calls**, for both AI approaches. Current measurements (below) do not meet it. Before go-live: instrument each stage (end-of-turn, STT, model, TTS, network) with metrics validated against client-measured audio, then tune the largest contributor first.

## Stage 5 acceptance results (16 October 2026)

Scripted practice conversations over WebRTC with synthesized Hindi customer speech, against the real providers. Response delay is measured from the end of the customer's audio to the agent's first audio, as received by the client.

| Scenario                     | Gemini Live (`gemini-3.8-live`)                | Sarvam cascade (`sarvam-105b-conversations`)  |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------- |
| Confirm                      | ✅ `confirmed`, goodbye, hung up (4 of 4 runs) | ✅ `confirmed`, goodbye, hung up              |
| Wrong number                 | ✅ `wrong_person`, no order details disclosed  | ✅ `wrong_person`, no order details disclosed |
| Call back "kal shaam 6 baje" | ✅ `callback_requested`, 17 Oct 18:00 IST      | ✅ `callback_requested`, 17 Oct 18:00 IST     |
| Response delay               | 1.6–3.2 s                                      | 1.1–1.9 s when the reply is one turn          |

Not yet verified: the same flow over a real Plivo call, including the agent-initiated hang-up through Plivo's API.

## Known issues

- **Sarvam speech segmentation.** A pause inside a short reply ("हाँ जी, बोलिए") often splits it into two turns, and once the opening "हाँ जी" was not transcribed, so the agent re-asked for identity. The conversation still reached the right outcome, but it adds a turn. Tune Sarvam STT segmentation (`first_turn_min_speech_frames`, `negative_frames_count`) and the turn strategy against recorded customer audio, with Sarvam's guidance. Gemini Live handled the same audio as one turn.
- **No trustworthy server-side latency metric yet.** Pipecat's `UserBotLatencyObserver` reported 3–4× the delay customers actually heard when replies split into fragments, and enabling local VAD for Gemini (which it needs) broke Gemini's turn handling in testing. Do not add local VAD to the Gemini pipeline. Server-side latency observability moves to stage 7 and must be validated against client-measured audio.
- **Slow teardown mid-reply.** Hanging up while Gemini is generating can delay the session end by up to ~30 s while Pipecat waits for the in-flight response. Phone attempts finish from Plivo's hangup callback regardless; practice attempts finish late.
- **Customer hangs up before a decision.** The attempt is `answered` with no outcome; the business system should treat that as follow-up.
