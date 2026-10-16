// Development stand-in for the client's business system, following the
// integration contract exactly.
//   pnpm mock:business send [--phone +91XXXXXXXXXX] [--order ORD-123] [--attempts 1-3]
//   pnpm mock:business serve [--port 4010]   receives signed results at /results
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  callRequestSchema,
  callResultSchema,
} from '@orderline/contracts/integration';
import { config } from '../src/config/index.js';
import {
  signBody,
  verifySignature,
} from '../src/platform/security/signatures.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phone: { type: 'string', default: config.TEST_PHONE_NUMBER },
    order: { type: 'string', default: `ORD-${Date.now()}` },
    attempts: { type: 'string', default: '3' },
    port: { type: 'string', default: '4010' },
  },
});

function requireSecret(name: string, value: string): string {
  if (!value) {
    console.error(`Set ${name} in .env first.`);
    process.exit(1);
  }
  return value;
}

async function send() {
  const secret = requireSecret(
    'INTEGRATION_INBOUND_SECRET',
    config.INTEGRATION_INBOUND_SECRET,
  );
  const request = callRequestSchema.parse({
    requestId: randomUUID(),
    useCase: 'order_confirmation',
    customer: {
      reference: 'mock-customer-1',
      name: 'Test Customer',
      phone: values.phone,
    },
    order: {
      id: values.order,
      items: [{ name: 'Wireless headphones', quantity: 1 }],
      total: { amountMinor: 149900, currency: 'INR' },
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Indiranagar, Bengaluru 560038',
    },
    schedule: { maxAttempts: Number(values.attempts) },
    metadata: { source: 'mock_business_system' },
  });
  const body = JSON.stringify(request);
  const response = await fetch(
    `http://127.0.0.1:${config.PORT}/integrations/v1/call-requests`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signBody(secret, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    },
  );
  console.log(response.status, await response.text());
  process.exitCode = response.ok ? 0 : 1;
}

function serve() {
  const secret = requireSecret(
    'INTEGRATION_RESULT_SECRET',
    config.INTEGRATION_RESULT_SECRET,
  );
  const seen = new Set<string>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/results') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const signature = request.headers[SIGNATURE_HEADER];
    if (
      !verifySignature(
        secret,
        typeof signature === 'string' ? signature : undefined,
        body,
        SIGNATURE_TOLERANCE_SECONDS,
      )
    ) {
      console.warn('Rejected result: invalid signature');
      response.writeHead(401).end();
      return;
    }
    const parsed = callResultSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      console.warn('Rejected result: contract violation', parsed.error.issues);
      response.writeHead(400).end();
      return;
    }
    const result = parsed.data;
    // Deduplicate by eventId, as a real receiver must.
    const duplicate = seen.has(result.eventId);
    seen.add(result.eventId);
    console.log(
      `${duplicate ? '(duplicate) ' : ''}${result.requestId} → ${result.requestStatus}`,
      result.attempt
        ? `attempt ${result.attempt.number}: ${result.attempt.result}`
        : 'no attempt',
      result.outcome ? `outcome: ${result.outcome.code}` : '',
    );
    response.writeHead(204).end();
  });
  server.listen(Number(values.port), '127.0.0.1', () =>
    console.log(
      `Mock business system receiving results at http://127.0.0.1:${values.port}/results`,
    ),
  );
}

const command = positionals[0] ?? 'send';
if (command === 'send') await send();
else if (command === 'serve') serve();
else {
  console.error(`Unknown command: ${command}. Use "send" or "serve".`);
  process.exitCode = 1;
}
