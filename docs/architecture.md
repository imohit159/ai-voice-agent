# Requirements and architecture

## 1. Requirements summary

Build an AI customer-care voice agent that calls to confirm an order. Use selectable Gemini or Sarvam for conversation and Exotel for telephony. BOSS requested configurable test branding and static order data initially. Support explicit confirmation, decline, and follow-up decisions, with transcript review. The supplied mobile number is configured as the test recipient, not assumed to be a supported caller ID.

## 2. Assumptions

One local operator and one process; no automatic campaign or real order-system writes. “Demo Store” and one clearly marked test order are defaults. Hindi/English selection is configurable; both is the initial setting. No latency SLA, daily call volume, hosting budget, real cancellation policy, or production contact rules have been supplied. These remain open before production rollout.

## 3. Architecture options

A modular monolith shares one deployment and reuses the same conversation implementation for browser and phone transports. Separate media, campaign, and order services increase deployment and consistency complexity; current test requirements do not justify them. A managed voice-agent platform reduces audio-integration work but introduces another provider and pricing layer in addition to telephony and model usage.

## 4. Recommended architecture

A TypeScript modular monolith using explicit module boundaries and a small browser dashboard. Exotel streams customer audio to the backend; the backend holds AI credentials and handles validated model outcomes. Real outcomes pass server-side validation and persist atomically. Browser practice uses the same agent but does not change order outcomes.

## 5. Technology decisions

pnpm; Fastify for HTTP, cookies, rate limits, and WebSockets; Zod for configuration/external-input validation; Google's official GenAI SDK; Node's built-in SQLite for bounded local persistence; Vite for a small TypeScript/CSS dashboard. No multi-package workspace, tRPC, Redis, PostgreSQL, Docker, third-party authentication provider, or separate queue at this stage. `pnpm-workspace.yaml` only configures dependency install-script policy. No external fonts, UI CDN, audio pipeline framework, or React dependency is needed.

## 6. Module boundaries

`shared/domain.ts`: finite states, contracts, and schemas. `server/config.ts`: centralized validated environment configuration. `server/store.ts`: persistence and atomic outcome writes. `server/agent`: conversation instructions, Gemini/Sarvam lifecycle, PCM framing/conversion, and transport handling. `server/integrations/exotel.ts`: provider HTTP requests. `server/app.ts`: operator APIs, callback authentication, call admission, and route registration. `web`: presentation and browser microphone/playback. Transport controllers do not interpret customer decisions.

## 7. Data flow

Operator → authenticated call request → validated call admission → persisted attempt → Exotel outbound API → signed WSS connection → selected Gemini Live or Sarvam voice session. PCM audio flows both ways; barge-in clears queued playback. Model outcome → schema and customer-quote validation → atomic call/order persistence → dashboard. Provider status callback → signed token and call-ID checks → transport status update. Practice follows the same voice flow through a signed browser socket and writes only its own attempt outcome.

## 8. API strategy

REST JSON APIs for session, settings, dashboard state, call creation/history, test-order reset, and provider reconciliation. Idempotency keys are required for calls. Exotel callbacks accept URL-encoded or JSON status fields. Each media/callback URL contains a purpose-bound, expiring signed token; browser media also requires an operator session and permitted origin.

## 9. Asynchronous processing strategy

The active voice session is an asynchronous WebSocket workload. Bounded audio-frame conversion uses small PCM chunks; no whole-recording processing occurs in handlers. Queues are not justified for individual operator-triggered test calls. No blind retries on a non-idempotent provider dial. Stale unconnected browser attempts expire; interrupted phone attempts remain uncertain until provider reconciliation. Durable scheduling, retry policy, dead-letter handling, and consent-aware bulk admission belong to a future campaign requirement.

## 10. Deployment architecture

Local backend on loopback port 3000 serves built UI and REST/WSS endpoints. For Exotel testing, publish a secure tunnel to that port. Production needs HTTPS/WSS reverse proxy support, a persistent writable database volume, controlled secrets, and one backend replica initially. `APP_ORIGIN` is the canonical operator URL and drives CSRF checks/cookie security. Static build and server compile are separate artifacts in `dist/` and `build/`.

## 11. Observability strategy

Structured events include local call ID, channel, dial uncertainty, and provider status. Framework request logs are disabled to avoid signed URL exposure; credentials, complete upstream errors, and customer audio are not logged. Transcripts are reviewable local application data, not log fields. Production needs metrics for connection failure, active sessions, time to first audio, no-answer rates, and uncertain calls, plus alerting and retention controls.

## 12. Security considerations

Centralized secrets in ignored owner-readable `.env`; operator password checks, HttpOnly/SameSite cookies, canonical-origin mutation checks, host checks, rate limits, signed single-use stream admission, callback identity validation, body/frame bounds, and escaped browser rendering. Provider destination hosts are fixed per selected region. No arbitrary outbound URL fetches. No recording, OTP, card, or password collection. Proxy query-string logging must be disabled. Session revocation and a production identity provider are outside the local MVP.

## 13. Scalability considerations

Two concurrent active/uncertain sessions by default, with a hard configurable cap of five. Indexed local SQLite queries are small and bounded. One process owns admission and media sessions; there is no claim of multi-replica safety. At demonstrated higher demand, add shared persistence, distributed concurrency controls, durable campaign scheduling, and a tested anti-aliasing media conversion pipeline. Tune against measured latency, provider limits, and call budget.

## 14. Implementation phases

1. Complete the local dashboard, static sample order, settings, authenticated APIs, browser practice, and protected Exotel integration.
2. Verify security/reliability invariants, build, and Gemini practice with sample input.
3. Configure BOSS's Exotel account and public URL, then validate a billable test call to the configured test recipient.
4. Define actual order integration, customer-contact policy, business outcome rules, retention, observability, hosting, load, and budget before production customer calls.

## Configurable voice providers

`agent/voice.ts` defines the single transport-facing interface: 16 kHz PCM input, 24 kHz PCM output, transcripts, interruption and outcome events. `agent/live.ts` chooses the Gemini or Sarvam adapter from the call's saved settings. Gemini uses a Live session; Sarvam owns realtime STT and cancellable chat/TTS requests. Transport handlers have no provider-specific branches. Both adapters use `agent/outcome.ts` to require a quote from actual customer speech before persisting a decision.

Provider/model settings are validated in `shared/domain.ts`, initialized from centralized server configuration and persisted in SQLite. Existing settings are merged with defaults on startup. Calls snapshot the complete settings at creation. No key is stored in settings or returned by API state. Missing credentials block call creation without silently switching providers.

Sarvam limits transcription payloads, conversation history, HTTP response sizes and synthesis length; request timeouts and abort signals discard stale replies on barge-in and shutdown. Synthesized WAV headers are validated before paced PCM playback. The MVP does not retry external AI calls automatically. Mock protocol tests verify recognition → conversation → synthesis, outcome evidence, duplicate transcript handling and interruption; live entitlement and voice latency require account-level testing.
