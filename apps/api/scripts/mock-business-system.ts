// Development stand-in for the client's business system: sends a signed
// order-confirmation call request exactly as the integration contract requires.
// Usage: pnpm mock:business [--phone +91XXXXXXXXXX] [--order ORD-123] [--attempts 1-3]
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  SIGNATURE_HEADER,
  callRequestSchema,
} from '@orderline/contracts/integration';
import { config } from '../src/config/index.js';
import { signBody } from '../src/platform/security/signatures.js';

const { values } = parseArgs({
  options: {
    phone: { type: 'string', default: config.TEST_PHONE_NUMBER },
    order: { type: 'string', default: `ORD-${Date.now()}` },
    attempts: { type: 'string', default: '3' },
  },
});

if (!config.INTEGRATION_INBOUND_SECRET) {
  console.error('Set INTEGRATION_INBOUND_SECRET in .env first.');
  process.exit(1);
}

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
      [SIGNATURE_HEADER]: signBody(config.INTEGRATION_INBOUND_SECRET, body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  },
);
console.log(response.status, await response.text());
process.exitCode = response.ok ? 0 : 1;
