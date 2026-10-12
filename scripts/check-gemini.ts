import { config } from '../server/config.js';

if (!config.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is missing.'); process.exit(1); }
try {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: { 'x-goog-api-key': config.GEMINI_API_KEY }, signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const body = await response.json() as { error?: { status?: string; details?: { reason?: string }[] } };
    const status = body.error?.status || 'REJECTED';
    const reason = body.error?.details?.find(detail => detail.reason)?.reason;
    // Never print upstream messages, request URLs, or credential values.
    console.error(`Gemini verification failed: HTTP ${response.status}, ${status}${reason ? `, ${reason}` : ''}.`);
    process.exit(1);
  }
  const body = await response.json() as { models?: { name: string }[] };
  const available = body.models?.some(model => model.name === `models/${config.GEMINI_LIVE_MODEL}`);
  console.log(`Gemini API key accepted. Configured Live model ${available ? 'is listed' : 'is not listed; verify model access before calling'}.`);
  if (!available) process.exitCode = 1;
} catch {
  console.error('Gemini verification could not reach Google within the timeout. No credential values were logged.'); process.exitCode = 1;
}
