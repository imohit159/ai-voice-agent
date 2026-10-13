# Orderline — AI order-confirmation voice agent

Local MVP: choose Gemini Live or Sarvam for the voice conversation; Exotel dials the test recipient and carries bidirectional audio. The provider, models, store name and language are configurable. Orders currently use **static, clearly marked sample data**, as requested.

## Workspace

```text
apps/api/             Fastify API, calls, voice adapters, tests, developer checks
apps/web/             Vite dashboard, browser audio, public microphone worklet
packages/contracts/   Shared schemas, types, domain states, and model choices
```

Install and run commands from the repository root. Each package owns its dependencies and TypeScript configuration. The apps import `@orderline/contracts` through `workspace:*`; its compiled JavaScript and declarations are built before the apps by pnpm's dependency ordering. See [pnpm workspaces](https://pnpm.io/workspaces) and [recursive script ordering](https://pnpm.io/cli/recursive).

The root `.env` belongs to the API. Relative `DATABASE_PATH` values resolve from the repository root, preserving `data/agent.sqlite`. The API serves built frontend files from `apps/web/dist` regardless of its working directory. API output is `apps/api/dist`; contracts output is `packages/contracts/dist`.

API startup lives in `apps/api/src/app.ts`; route handlers live beside their capabilities in `modules/auth`, `modules/workspace`, `modules/calls`, and `modules/voice`. Shared HTTP security lives in `platform/http/security.ts`. In the browser, `main.ts` starts the workspace, `features` owns views and voice-practice handling, and `api/client.ts` owns HTTP requests. Shared request/response types live in `packages/contracts/src/api.ts`. See the [API module guide](apps/api/README.md) and [codebase organization](docs/codebase-design.md) for responsibilities and dependency rules.

## Run locally

Requires Node.js 22.13+ and pnpm. A private `.env` has been created locally with the supplied Gemini key and randomly generated operator/session credentials. It is excluded from source control and readable only by its owner. Never paste this file into chat, logs, or issue reports.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://localhost:3000**. Sign in using `ADMIN_PASSWORD` from your local `.env`. The dashboard offers voice practice, test calling, configurable store/language, call history, transcripts, and Exotel status reconciliation.

**Voice practice** requires microphone access in a current browser on localhost or HTTPS. It uses the selected AI provider and may incur usage charges. It never places a phone call and never changes the sample order's decision. The developer `pnpm check:voice` check uses typed sample speech to exercise the same server session without a microphone.

For development, `pnpm dev` watches the API and shared contracts and serves the latest built UI. For frontend hot reload, set `APP_ORIGIN=http://localhost:5173` in `.env`, restart `pnpm dev`, and run `pnpm dev:web` in a second terminal. Rebuild after frontend changes when using port 3000. Alternatively, after setting `APP_ORIGIN=http://localhost:5173`, `pnpm dev:all` runs the API, frontend, and contracts watchers together. `pnpm dev:api` is an alias for the backend/contract development workflow.

## Choose Gemini or Sarvam

Open **Agent & connections** and select **AI voice provider**. Gemini uses its Live model for the entire audio conversation. Sarvam uses realtime STT → conversation model → TTS, with interruption cancelling pending responses and clearing queued speech. This pipeline can have more turn latency than Gemini Live; benchmark it with representative Hindi/English audio.

Add the corresponding key in the repository-root `.env` and restart:

```dotenv
VOICE_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key
GEMINI_LIVE_MODEL=gemini-3.8-live
SARVAM_API_KEY=your-sarvam-key
SARVAM_MODEL=sarvam-105b-conversations
SARVAM_STT_MODEL=saaras:v4
SARVAM_TTS_MODEL=bulbul:v4-flash
```

Environment model values initialize new workspaces and fill missing settings in older workspaces. Saved dashboard settings take precedence thereafter. Each new call stores a snapshot of provider, models, language and store name. Existing calls keep that snapshot. There is no automatic provider fallback.

Use a **Model APIs subscription key** from [Sarvam key management](https://dashboard.sarvam.ai/key-management) for `SARVAM_API_KEY`. A managed Voice Agents key is stored separately as `SARVAM_VOICE_AGENTS_API_KEY`; it does not configure this local STT/chat/TTS adapter. If the Model APIs reject a key, keep Gemini selected until a working model key is supplied.

Calls announce “You are speaking with Gemini” or “You are speaking with Sarvam” in the introduction, following the call's saved provider selection and language. Sarvam synthesizes a scripted introduction; Gemini Live receives the same exact introduction as an instruction. The `TEMPORARY MODEL ANNOUNCEMENT` comment in `apps/api/src/modules/voice/prompt.ts` marks the provider text to remove later. Keep the AI assistant and test-call disclosure when removing the provider name.

Sarvam's conversation, STT and TTS models can be selected separately. Synthesis uses the selected model's default voice and emits mono PCM16 at 24 kHz through the same browser/Exotel transport. STT uses 16 kHz PCM and server VAD. All credentials remain on the server. A configured key does not guarantee entitlement or quota: use voice practice to verify access. Sarvam integration tests mock the official protocol; live Sarvam verification requires your key and access to its realtime endpoint.

## Sarvam Voice Agents MCP

The project includes `.cursor/mcp.json` with the official remote server `https://mcp.sarvam.ai/voice-agents`. Open Cursor's MCP settings and complete its Sarvam SSO sign-in. Codex can register the same server with:

```bash
codex mcp add sarvam-voice-agents --url https://mcp.sarvam.ai/voice-agents
codex mcp login sarvam-voice-agents
```

This MCP manages agents on Sarvam's hosted platform; it is separate from our local voice adapter and from API-key authentication. No API key belongs in the MCP configuration. After authentication, reload the client session to discover tools and start with a read-only agent listing. Configuring this connector does not deploy an agent or place a call. See [Sarvam's MCP documentation](https://docs.sarvam.ai/voice-agents/mcp).

## Connect Exotel

Set these in the **repository-root `.env`** using credentials from your Exotel dashboard:

```dotenv
EXOTEL_ACCOUNT_SID=your-account-sid
EXOTEL_API_KEY=your-api-key
EXOTEL_API_TOKEN=your-api-token
EXOTEL_CALLER_ID=your-exophone
EXOTEL_REGION=in
PUBLIC_BASE_URL=https://your-public-origin.example
ENABLE_PHONE_CALLS=true
```

Use `EXOTEL_REGION=in` for dashboard API hostname `api.in.exotel.com`, or `sg` for `api.exotel.com`. Match the hostname shown in Developer Settings; the recipient’s country does not determine this setting.

1. Ensure your account has **Connect Voice AI / bidirectional AgentStream** access. If your account requires the older App Bazaar flow instead, it needs a flow-specific adapter; this build uses the documented direct Connect Voice AI API.
2. Exotel must reach this server at the public HTTPS origin and upgrade `/ws/exotel` to WSS. Forward that origin to port 3000 with a secure tunnel for local testing, or deploy on a host supporting long-lived WebSockets. Keep `APP_ORIGIN` pointed at the URL you use for the operator dashboard; if accessing the dashboard remotely, set it to the public HTTPS origin.
3. Preserve signed query parameters in `StreamUrl` and `StatusCallback`; disable query-string logging at your reverse proxy/tunnel. The generated stream URL requests 16 kHz audio.
4. Restart the server. The Connections screen shows remaining configuration. Credentials are never returned to the browser.
5. On Orders, **Call test number** dials the configured `TEST_PHONE_NUMBER` (initially the supplied phone number). This places a real, billable phone call using sample order data. No calls are made automatically.

The caller ID is your **Exotel ExoPhone/business number**; the personal mobile number is the test recipient. Audio recording is disabled. Transcripts and sample outcomes are stored locally in `data/agent.sqlite`.

For a temporary local tunnel, use the official `cloudflared` binary:

```bash
cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3000
```

Copy the generated HTTPS origin into `PUBLIC_BASE_URL` and restart the server. Leave `APP_ORIGIN=http://localhost:3000` when using the local dashboard. Keep both processes running. Restarting a quick tunnel generates a new URL, so update `.env` and restart the server again. Quick tunnels are for testing; see [Cloudflare's instructions](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Check streaming capacity using Exotel's authenticated, read-only `GET /v1/Accounts/{AccountSid}/ActiveStreams`. A successful dial does not prove audio streaming is available. If `ThrottleLimit` is zero, ask Exotel to enable bidirectional AgentStream / Connect Voice AI and confirm the appropriate API hostname. Keep `ENABLE_PHONE_CALLS=false` until capacity is confirmed. The local investigation and support details are in `docs/exotel-streaming-check.md`.

The agent introduces itself as an AI assistant on a test call, checks whether it is speaking with the test customer, reads the sample order, and asks for explicit confirmation. It records `confirmed`, `declined`, or `needs_follow_up` with a quote from the customer. Declining does not cancel an external order. Change requests do not modify the order. There is no real order-system integration or human transfer yet.

## Reliability and recovery

- Call creation uses request idempotency keys and a database constraint blocking simultaneous phone attempts for the same order.
- A completed call is a transport event, not an order confirmation.
- Dial POSTs are never automatically retried. A timeout/5xx may mean Exotel accepted the call; the attempt becomes `unknown` and blocks duplicate dialing.
- Use **Check status with Exotel** in call details when a provider call ID is available. Signed callbacks also reconcile the attempt. Late active/queued events cannot regress a terminal status.
- If no provider ID or callback arrives after an uncertain POST, investigate Exotel logs using the local attempt ID in `CustomField`. There is deliberately no one-click redial override that might place a duplicate call. Operator recovery for this rare case is a remaining production requirement.
- Calls have a 180-second provider time limit by default. Audio disconnection waits for the provider's terminal status; closing the stream alone does not prove the phone call ended.
- Maximum two active/uncertain sessions by default. Adjust validated limits in `.env`. The MVP has no automatic campaigns, scheduled retries, or bulk calling.

## Verification

```bash
pnpm test
pnpm check
pnpm build
pnpm check:gemini
# Run while the server is running; uses the selected provider’s billable audio, never Exotel:
pnpm check:voice
```

Tests cover authentication, origin/host validation, secret exposure, idempotent dialing, uncertain attempts, callback identity, single-use voice-session tokens, outcome persistence, late status events, audio continuity, and Exotel framing.

## Scope before production

This is a single-operator, single-process test MVP. Keep test disclosure while static data is used. Before real customer campaigns, establish order-system integration and business approval rules, contact permissions/calling windows, transcript retention and deletion, backups, monitored error alerts, session revocation, and a human follow-up process. LLM outcome interpretation still requires representative Hindi/English audio testing; evidence validation verifies that the quote was actually spoken but does not prove its meaning. SQLite fits this local workload; multi-instance operation needs shared persistence and distributed admission control. PCM conversion uses bounded linear interpolation suitable for the MVP; high-fidelity production telephony may warrant a streaming resampler with anti-alias filtering.

Rotate the Gemini key shared in chat before production use.

## Reference documentation

- [Exotel Connect Voice AI](https://developer.exotel.com/docs/agentstream/connect-voice-ai)
- [Exotel AgentStream WebSocket protocol](https://developer.exotel.com/docs/agentstream/websocket-protocol)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
- [Sarvam realtime STT](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws)
- [Sarvam conversation API](https://docs.sarvam.ai/api-reference/chat/chat-completions-v1)
- [Sarvam TTS](https://docs.sarvam.ai/api-reference/text-to-speech/convert)
- [Gemini Live tool use](https://ai.google.dev/gemini-api/docs/live-api/tools)

See [architecture and requirements](docs/architecture.md) for module boundaries and deployment decisions.
