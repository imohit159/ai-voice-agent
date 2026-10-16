# Voice agent

Python service that runs the live conversation with [Pipecat](https://docs.pipecat.ai) 1.12. It serves two transports with one bot:

- **Phone calls:** Plivo streams μ-law audio to `/plivo/stream` (WebSocket). The upgrade is verified with Plivo's V3 signature, and the stream's `start` event must carry the attempt ID and session token that the API put in `<Stream extraHeaders>`.
- **Browser practice:** the API forwards the browser's WebRTC offer to `/practice/offer`; media then flows directly between the browser and this service.

The AI stage follows the attempt's snapshotted agent config: **Gemini Live** (speech-to-speech) or **Sarvam** (Saaras STT → `sarvam-105b-conversations` → Bulbul TTS, with Silero VAD).

## Boundary with the API

This service never touches the database. Over the API's internal endpoints (`/internal/v1/voice-sessions/*`, bearer `VOICE_AGENT_INTERNAL_TOKEN`) it:

1. **claims** a session once per answered attempt (the API checks the session token, and for phone calls that the Plivo `CallUUID` matches the answered call),
2. **posts transcript batches** every two seconds,
3. **reports the end** of the session.

The API calls `/internal/status` to learn which AI providers this service has keys for, and does not dial when the configured provider cannot be served. The contract is mirrored from `packages/contracts/src/voice.ts` in `node_client.py`.

## Run

Requires [uv](https://docs.astral.sh/uv/); it installs Python 3.12 on first use. Configuration is read from the environment, falling back to the repository-root `.env`.

```bash
pnpm dev:voice     # from the repository root; listens on VOICE_AGENT_PORT (7860)
pnpm test:voice
pnpm check:voice   # ruff lint and format check
```

Logs default to `INFO`. Pipecat logs conversation text and prompts at `DEBUG`; never run production at `DEBUG`.
