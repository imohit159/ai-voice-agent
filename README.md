# Orderline — customer care voice agent

An outbound voice agent that calls customers from an Indian number, speaks Hindi and English, and returns a structured result to the client's business system. The target design is in the [architecture brief](docs/architecture/customer-care-voice-agent-architecture.md); the agreed decisions and build stages are in [implementation decisions](docs/architecture/implementation-decisions.md).

**Current state (stage 3 of 7):** the business system can request calls through a signed API; the server schedules them within calling hours, dials through **Plivo**, tracks each attempt through signed Plivo callbacks, retries unanswered calls, and delivers signed results. The live conversation moves to a **Pipecat** service in stage 4. Until then, answered Plivo calls are handed to `VOICE_AGENT_STREAM_URL`, and browser voice practice still uses the legacy Node voice pipeline.

## Workspace

```text
apps/api/             Fastify API: call management, integrations, legacy practice, tests
apps/web/             Vite dashboard (replaced by a React dashboard in stage 6)
packages/contracts/   Shared schemas, types and domain values, including the integration contract
```

Install and run commands from the repository root. The root `.env` belongs to the API; relative `DATABASE_PATH` values resolve from the repository root. See the [API module guide](apps/api/README.md) for modules and dependency rules.

## Run locally

Requires Node.js 22.13+ and pnpm. Copy `.env.example` to `.env` and fill in the secrets. Never paste `.env` into chat, logs or issue reports.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

For development without placing real calls, set `TELEPHONY_PROVIDER=simulated`. The server refuses to start with `TELEPHONY_PROVIDER=plivo` (the default) unless every Plivo setting is present, so a misconfigured server never silently simulates calls.

`pnpm dev` watches the API and contracts and serves the latest built UI on port 3000. For frontend hot reload, set `APP_ORIGIN=http://localhost:5173`, then run `pnpm dev:all`.

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
VOICE_AGENT_STREAM_URL=wss://your-public-origin.example/voice/plivo
```

1. Use a client-owned Plivo account with KYC completed, an approved Indian caller ID, and outbound bidirectional audio streaming enabled.
2. Plivo must reach `PUBLIC_BASE_URL` over HTTPS. Each dial registers per-attempt callback URLs under `/hooks/plivo/{ring,answer,hangup}`; every callback is verified with Plivo's V3 signature against the public URL, so the reverse proxy or tunnel must forward paths and query strings unchanged.
3. On answer, the API returns `<Stream>` XML pointing Plivo at `VOICE_AGENT_STREAM_URL`, with the attempt ID and a short-lived session token in `extraHeaders` for the voice agent to present.

For local testing, a temporary tunnel works:

```bash
cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3000
```

Copy the generated HTTPS origin into `PUBLIC_BASE_URL` and restart. Quick tunnels change URL on restart; see [Cloudflare's instructions](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Reliability

- **Idempotent intake.** A replayed `requestId` returns the original receipt; one open request per order is enforced in code and by a database constraint.
- **Calling policy.** Attempts start only within `CALLING_HOURS_START`–`CALLING_HOURS_END` IST and the request's window. Unanswered, busy or failed attempts retry after `CALL_RETRY_DELAYS_MINUTES`, up to 3 attempts. At most `MAX_CONCURRENT_CALLS` calls are live at once.
- **No duplicate calls.** Dial requests are never retried automatically. If a dial outcome is uncertain (timeout, 5xx, or a restart mid-dial) the attempt becomes `unknown` and blocks redialling until reconciliation with Plivo settles it.
- **Out-of-order events.** Late or duplicate provider events never move an attempt backwards; an answered call that drops still counts as answered.
- **Result delivery.** Each finished attempt writes its result in the same transaction. Delivery is signed, refuses redirects, and retries with backoff for about 10.5 hours before being marked failed for manual recovery.

## AI providers (browser practice)

Until stage 4, browser practice uses the legacy Node pipeline. Open **Agent & connections** and choose Gemini Live (speech-to-speech) or Sarvam (STT → conversation model → TTS). Add the matching keys to `.env`:

```dotenv
VOICE_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key
GEMINI_LIVE_MODEL=gemini-3.8-live
SARVAM_API_KEY=your-sarvam-key
SARVAM_MODEL=sarvam-105b-conversations
SARVAM_STT_MODEL=saaras:v4
SARVAM_TTS_MODEL=bulbul:v4-flash
```

Each attempt stores a snapshot of the AI configuration it started with. There is no automatic provider fallback. Use a **Model APIs subscription key** from [Sarvam key management](https://dashboard.sarvam.ai/key-management) for `SARVAM_API_KEY`; the Voice Agents key (`SARVAM_VOICE_AGENTS_API_KEY`) is separate.

## Sarvam Voice Agents MCP

The project includes `.cursor/mcp.json` with the official remote server `https://mcp.sarvam.ai/voice-agents`. It manages agents on Sarvam's hosted platform and is separate from this application. See [Sarvam's MCP documentation](https://docs.sarvam.ai/voice-agents/mcp).

## Verification

```bash
pnpm check   # module boundaries and types
pnpm test
pnpm build
```

Tests cover intake signing and idempotency, calling hours and retry policy, capacity, uncertain dials, restart recovery, reconciliation, Plivo V3 signatures (against vectors from Plivo's reference implementation), callback identity, result delivery and migrations.

## Before production

Planned in later stages: the Pipecat voice agent (4), the order-confirmation conversation with backend action validation (5), the role-based dashboard with transcript audit (6), and Docker Compose deployment with TLS, retention jobs and backups (7). Agree transcript retention, calling permissions and the business system's real endpoints before handling customer data.

## Reference documentation

- [Plivo: make a call](https://www.plivo.com/docs/voice/api/call/make-a-call)
- [Plivo: audio streaming](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide)
- [Plivo: signature validation](https://www.plivo.com/docs/voice/concepts/signature-validation)
- [Plivo: hangup causes](https://www.plivo.com/docs/voice/troubleshooting/hangup-causes)
- [Pipecat Plivo serializer](https://docs.pipecat.ai/api-reference/server/services/serializers/plivo)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
- [Sarvam API reference](https://docs.sarvam.ai/api-reference)

See the [documentation index](docs/README.md) for the architecture brief and background concepts.
