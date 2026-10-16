import type { FinalAttemptStatus } from '@orderline/contracts/integration';

// Provider-neutral port. Adapters translate their provider's states into these.
export type ProviderCallStatus = 'ringing' | 'in_progress' | FinalAttemptStatus;

export interface ProviderEvent {
  attemptId: string;
  /** The identifier returned when the call was requested; absent if a callback omits it. */
  providerCallId?: string;
  /** The connected call leg, when the provider identifies it separately (Plivo CallUUID). */
  providerLegId?: string | null;
  status: ProviderCallStatus;
  /** Provider's reason for a call that ended without being answered. */
  detail?: string | null;
}

export type ProviderCallState = Pick<ProviderEvent, 'status' | 'detail'>;

export interface Telephony {
  readonly name: string;
  dial(request: {
    attemptId: string;
    phone: string;
  }): Promise<{ providerCallId: string; status: ProviderCallStatus }>;
  lookup(call: {
    providerCallId: string;
    providerLegId: string | null;
  }): Promise<ProviderCallState>;
  close?(): void;
}

export class TelephonyError extends Error {
  /** `uncertain`: the provider may have placed the call, so redialling could call the customer twice. */
  constructor(
    message: string,
    public uncertain: boolean,
  ) {
    super(message);
  }
}
