# Exotel streaming investigation — 12 October 2026

The public Cloudflare HTTPS/WSS tunnel reached the local server. Health returned 200, operator state without a session returned 401, and invalid callback and stream tokens returned 403. The dashboard remains protected by operator authentication.

One authorized test call was placed at 22:59 IST. Exotel accepted it and the recipient reported answering to silence. The application recorded no WebSocket stream claim and no transcript. Exotel's dashboard reported “Client hung-up before connecting to any user,” zero talk time, and a completed call. Its call duration was 32 seconds; call duration includes time outside the conversation. The attempt was reconciled against Exotel before any further dialing.

The authenticated read-only ActiveStreams endpoint on `api.exotel.com` returned HTTP 200 with `ActiveStreamCount=0` and `ThrottleLimit=0`. The alternate hostname in Exotel's starter, `api-stream.exotel.com`, returned HTTP 503 for this read-only check. Zero capacity suggests an account enablement or routing issue; a working conversation has not been verified.

The adapter now sends multipart form data, matching the documented streaming example, and explicitly requests JSON. It retains the `.json` response suffix shown in Exotel's official starter. This request-format correction is covered by a mocked regression test and is not claimed as a verified fix for the live silence. Dial requests are never automatically retried.

Further calls are disabled with `ENABLE_PHONE_CALLS=false` until streaming capacity and the correct hostname are confirmed. The server and temporary tunnel may remain running; a new quick tunnel requires updating `PUBLIC_BASE_URL` and restarting the server.

## Support request to send yourself

Please enable bidirectional AgentStream / Connect Voice AI on account `zevnixai1` and confirm the correct API hostname. `GET /v1/Accounts/zevnixai1/ActiveStreams` on `api.exotel.com` returns `ThrottleLimit=0`. Test call `dc27234783ff20d1acd74b1493a51aac`, placed on 12 October 2026 at 22:59 IST from ExoPhone `01140847529`, rang the test recipient, but answering produced silence and no WebSocket connection reached our publicly reachable server. Please confirm whether the trial supports direct StreamUrl calls and whether a flow or different streaming hostname is required.

No support message has been sent by this application or assistant. Do not include API keys, API tokens, `.env`, or signed stream URLs when sharing this request.

## References

- https://developer.exotel.com/docs/agentstream/connect-voice-ai
- https://developer.exotel.com/docs/agentstream/wss-errors-monitoring
- https://github.com/exotel/voicebot-quick-starter
