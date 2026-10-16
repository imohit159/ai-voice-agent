# Orderline — customer care voice agent

An outbound voice agent that calls customers from an Indian number, speaks Hindi and English, and returns a structured result to the client's business system. The target design is in the [architecture brief](docs/architecture/customer-care-voice-agent-architecture.md); the agreed decisions and build stages are in [implementation decisions](docs/architecture/implementation-decisions.md).

**Current state (stage 4 of 7):** the business system requests calls through a signed API; the API schedules them within calling hours, dials through **Plivo**, and retries unanswered calls. When a customer answers, Plivo streams the audio to the **Pipecat voice agent**, which holds the conversation with Gemini Live or Sarvam and reports the transcript back. Browser practice uses the same bot over WebRTC. Outcome recording, end-of-call handling and backend action validation arrive in stage 5.

## Workspace

```text
apps/api/               Fastify API: call management, integrations, dashboard API, tests
apps/web/               Vite dashboard (replaced by a React dashboard in stage 6)
packages/contracts/     Shared schemas and types: integration and voice-session contracts
services/voice-agent/   Python Pipecat service: Plivo stream, WebRTC practice, AI pipelines
```

The API is the only database writer; the voice agent talks to it over a private, token-authenticated internal API. See the [API module guide](apps/api/README.md) and the [voice agent guide](services/voice-agent/README.md).

## Run locally

Requires Node.js 22.13+, pnpm and [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 for the voice agent). Copy `.env.example` to `.env` and fill in the secrets. Never paste `.env` into chat, logs or issue reports.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start        # API and dashboard on :3000
pnpm dev:voice    # voice agent on :7860, in a second terminal
```

Both processes read the repository-root `.env`. `VOICE_AGENT_INTERNAL_TOKEN` must be the same for both.

For development without placing real calls, set `TELEPHONY_PROVIDER=simulated`. The API refuses to start with `TELEPHONY_PROVIDER=plivo` (the default) unless every Plivo setting is present, so a misconfigured server never silently simulates calls.

`pnpm dev` watches the API and contracts and serves the latest built UI on port 3000. For frontend hot reload, set `APP_ORIGIN=http://localhost:5173`, then run `pnpm dev:all`.

## Voice practice

**Agent & connections** selects the AI approach: Gemini Live (speech-to-speech) or Sarvam (Saaras STT → `sarvam-105b-conversations` → Bulbul TTS). The keys live only with the voice agent:

```dotenv
GEMINI_API_KEY=your-gemini-key
SARVAM_API_KEY=your-sarvam-model-api-key
```

On **Orders**, **Start voice practice** connects your microphone to the voice agent over WebRTC using the sample order. It never places a phone call, and its result is never sent to the business system. Each attempt stores a snapshot of the AI configuration it started with; there is no automatic provider fallback. If the voice agent is not running, or lacks the key for the selected provider, practice is unavailable and scheduled calls wait rather than dial.

Use a **Model APIs subscription key** from [Sarvam key management](https://dashboard.sarvam.ai/key-management) for `SARVAM_API_KEY`.

## Business system integration

The business system sends signed call requests and receives a signed result after every attempt. The [integration contract](docs/architecture/integration-contract.md) is the reference for the client's developers.

A mock business system is included for end-to-end testing:

```bash
pnpm mock:business serve                       # receives results at http://127.0.0.1:4010/results
pnpm mock:business send --phone +91XXXXXXXXXX  # sends a signed order-confirmation request
```

Set `INTEGRATION_INBOUND_SECRET`, `INTEGRATION_RESULT_SECRET` and `INTEGRATION_RESULT_URL=http://127.0.0.1:4010/results` first. With the simulated provider, the phone number's last digit picks the scenario: `0` no answer, `1` busy, `2` failed, anything else answered.

## Connect Plivo

```dotenv
TELEPHONY_PROVIDER=plivo
PLIVO_AUTH_ID=your-auth-id
PLIVO_AUTH_TOKEN=your-auth-token
PLIVO_FROM_NUMBER=+91XXXXXXXXXX
PUBLIC_BASE_URL=https://your-public-origin.example
VOICE_AGENT_STREAM_URL=wss://your-public-origin.example/plivo/stream
```

1. Use a client-owned Plivo account with KYC completed, an approved Indian caller ID, and outbound bidirectional audio streaming enabled.
2. Plivo must reach the API at `PUBLIC_BASE_URL` (callbacks under `/hooks/plivo/{ring,answer,hangup}`) and the voice agent at `VOICE_AGENT_STREAM_URL`. Route `/plivo/stream` to the voice agent and everything else to the API. Both verify Plivo's V3 signature against the public URL, so the proxy must forward paths and query strings unchanged.
3. Never expose `/internal/*` or `/practice/*` publicly; only the API calls them.

For local testing, a temporary tunnel works:

```bash
cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3000
```

Quick tunnels forward to one port; to test real calls end to end you need a proxy that routes `/plivo/stream` to port 7860 (stage 7 adds Caddy for this). See [Cloudflare's instructions](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Reliability

- **Idempotent intake.** A replayed `requestId` returns the original receipt; one open request per order is enforced in code and by a database constraint.
- **Calling policy.** Attempts start only within `CALLING_HOURS_START`–`CALLING_HOURS_END` IST and the request's window, and only while the voice agent can serve the configured AI provider. Unanswered, busy or failed attempts retry after `CALL_RETRY_DELAYS_MINUTES`, up to 3 attempts. At most `MAX_CONCURRENT_CALLS` conversations (calls and practice) run at once.
- **No duplicate calls.** Dial requests are never retried automatically. If a dial outcome is uncertain (timeout, 5xx, or a restart mid-dial) the attempt becomes `unknown` and blocks redialling until reconciliation with Plivo settles it.
- **One agent per call.** The voice agent claims a session once; the API checks the session token and, for phone calls, that the stream belongs to the answered Plivo call leg.
- **Out-of-order events.** Late or duplicate provider events never move an attempt backwards; an answered call that drops still counts as answered.
- **Result delivery.** Each finished attempt writes its result in the same transaction. Delivery is signed, refuses redirects, and retries with backoff for about 10.5 hours before being marked failed for manual recovery.

## Verification

```bash
pnpm check         # module boundaries and types
pnpm test          # API tests
pnpm build
pnpm check:voice   # voice agent lint and format
pnpm test:voice    # voice agent tests
```

API tests cover intake signing and idempotency, calling hours and retry policy, capacity, uncertain dials, restart recovery, reconciliation, Plivo V3 signatures (against vectors from Plivo's reference implementation), callback identity, voice-session claims, practice sessions, result delivery and migrations. Voice agent tests cover stream admission and signatures, the session contract, transcript batching and pipeline assembly.

## Sarvam Voice Agents MCP

The project includes `.cursor/mcp.json` with the official remote server `https://mcp.sarvam.ai/voice-agents`. It manages agents on Sarvam's hosted platform and is separate from this application. See [Sarvam's MCP documentation](https://docs.sarvam.ai/voice-agents/mcp).

## Before production

Planned in later stages: the order-confirmation conversation with outcomes, end-of-call and backend action validation (5), the role-based dashboard with transcript audit (6), and Docker Compose deployment with Caddy, TLS, retention jobs and backups (7). Agree transcript retention, calling permissions and the business system's real endpoints before handling customer data.

## Reference documentation

- [Pipecat](https://docs.pipecat.ai) and its [Plivo serializer](https://docs.pipecat.ai/api-reference/server/services/serializers/plivo)
- [Plivo: make a call](https://www.plivo.com/docs/voice/api/call/make-a-call)
- [Plivo: audio streaming](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide)
- [Plivo: signature validation](https://www.plivo.com/docs/voice/concepts/signature-validation)
- [Plivo: hangup causes](https://www.plivo.com/docs/voice/troubleshooting/hangup-causes)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
- [Sarvam API reference](https://docs.sarvam.ai/api-reference)

See the [documentation index](docs/README.md) for the architecture brief and background concepts.
