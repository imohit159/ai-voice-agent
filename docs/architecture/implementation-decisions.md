# Implementation decisions

Decisions taken on 16 October 2026 for migrating the current codebase to the
[customer care voice agent architecture](customer-care-voice-agent-architecture.md).
Change a decision here before changing the code that depends on it.

## Approach

| #   | Decision        | Choice                                                                                                   |
| --- | --------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Migration       | Evolve this repository in stages; no greenfield rewrite.                                                 |
| 2   | API framework   | Keep Fastify.                                                                                            |
| 3   | AI approach     | Both, selectable: Gemini Live (speech-to-speech) and Sarvam STT → `sarvam-m` → Sarvam TTS (cascaded).    |
| 4   | Practice mode   | Keep, served by Pipecat's WebRTC transport running the same bot as phone calls. Test-only call mode.     |
| 5   | Business system | Not yet available. Define contracts from the architecture brief and ship a mock business system for E2E. |
| 6   | First use case  | Order confirmation.                                                                                      |

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
4. **Pipecat service.** Python service with Plivo serializer and WebRTC transport, both model stages, internal API client, `transcript_entries` table. Remove the Node `voice` module.
5. **Order confirmation.** Conversation plan, identity check, outcome tool, backend action validation.
6. **Dashboard.** `users` and `audit_events` tables; React app with roles, call history, transcripts, delivery status, practice calls.
7. **Deployment.** Docker Compose, Caddy, secrets, retention job, backups, end-to-end and concurrency tests.
