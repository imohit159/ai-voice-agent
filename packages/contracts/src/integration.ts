import { z } from 'zod';

// Business-system integration contract, v1. Changing a field here changes what
// the client's system must send or accept; update docs/architecture/integration-contract.md too.

export const USE_CASES = ['order_confirmation'] as const;
export const CALL_OUTCOMES = [
  'confirmed',
  'cancel_requested',
  'change_requested',
  'callback_requested',
  'wrong_person',
  'needs_follow_up',
] as const;
export const CALL_REQUEST_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'exhausted',
  'expired',
] as const;
export const OPEN_CALL_REQUEST_STATUSES = [
  'pending',
  'in_progress',
] as const satisfies readonly CallRequestStatus[];
export const LIVE_ATTEMPT_STATUSES = [
  'dialing',
  'ringing',
  'in_progress',
  'unknown',
] as const;
export const FINAL_ATTEMPT_STATUSES = [
  'completed',
  'no_answer',
  'busy',
  'failed',
] as const;
export const ATTEMPT_STATUSES = [
  ...LIVE_ATTEMPT_STATUSES,
  ...FINAL_ATTEMPT_STATUSES,
] as const;
export const ATTEMPT_RESULTS = [
  'answered',
  'no_answer',
  'busy',
  'failed',
] as const;

export const MAX_CALL_ATTEMPTS = 3;
export const MAX_SCHEDULE_AHEAD_DAYS = 7;
export const DEFAULT_CALL_WINDOW_HOURS = 24;
export const SIGNATURE_HEADER = 'x-signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type UseCase = (typeof USE_CASES)[number];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** The outcomes a conversation for each use case may record. */
export const USE_CASE_OUTCOMES: Record<UseCase, readonly CallOutcome[]> = {
  order_confirmation: CALL_OUTCOMES,
};
export type CallRequestStatus = (typeof CALL_REQUEST_STATUSES)[number];
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type FinalAttemptStatus = (typeof FINAL_ATTEMPT_STATUSES)[number];

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/);
const timestamp = z.iso.datetime({ offset: true });
const metadata = z
  .record(
    z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_]+$/),
    z.string().max(200),
  )
  .refine((value) => Object.keys(value).length <= 10, {
    message: 'At most 10 metadata entries.',
  });

const orderConfirmationRequest = z
  .object({
    requestId: identifier,
    useCase: z.literal('order_confirmation'),
    customer: z
      .object({
        reference: identifier,
        name: z.string().trim().min(1).max(100),
        phone: z.string().regex(/^\+91\d{10}$/),
      })
      .strict(),
    order: z
      .object({
        id: identifier,
        items: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(120),
                quantity: z.number().int().min(1).max(999),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        total: z
          .object({
            // Minor units (paise) so amounts never pass through floating point.
            amountMinor: z.number().int().min(0).max(10_000_000_000),
            currency: z.literal('INR'),
          })
          .strict(),
        paymentMethod: z.enum(['cash_on_delivery', 'prepaid']),
        deliveryAddress: z.string().trim().min(1).max(300),
      })
      .strict(),
    schedule: z
      .object({
        notBefore: timestamp.optional(),
        notAfter: timestamp.optional(),
        maxAttempts: z.number().int().min(1).max(MAX_CALL_ATTEMPTS).optional(),
      })
      .strict()
      .optional(),
    metadata: metadata.optional(),
  })
  .strict();

export const callRequestSchema = z.discriminatedUnion('useCase', [
  orderConfirmationRequest,
]);
export type CallRequest = z.infer<typeof callRequestSchema>;

export interface CallRequestReceipt {
  requestId: string;
  status: CallRequestStatus;
  acceptedAt: string;
}

export const callResultSchema = z
  .object({
    eventId: z.uuid(),
    occurredAt: timestamp,
    requestId: identifier,
    requestStatus: z.enum(CALL_REQUEST_STATUSES),
    useCase: z.enum(USE_CASES),
    attempt: z
      .object({
        id: z.uuid(),
        number: z.number().int().min(1).max(MAX_CALL_ATTEMPTS),
        result: z.enum(ATTEMPT_RESULTS),
        startedAt: timestamp,
        answeredAt: timestamp.nullable(),
        endedAt: timestamp,
        durationSeconds: z.number().int().min(0),
        failureReason: z.string().max(300).nullable(),
      })
      .strict()
      // null when the window closed before another attempt could be made.
      .nullable(),
    outcome: z
      .object({
        code: z.enum(CALL_OUTCOMES),
        summary: z.string().max(1000),
        callbackAt: timestamp.nullable(),
      })
      .strict()
      .nullable(),
    metadata: metadata.optional(),
  })
  .strict();
export type CallResult = z.infer<typeof callResultSchema>;
