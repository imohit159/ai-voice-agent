import type { FinalAttemptStatus } from '@orderline/contracts/integration';

// Provider-neutral port. Adapters translate their provider's states into these.
export type ProviderCallStatus = 'ringing' | 'in_progress' | FinalAttemptStatus;

export interface Telephony {
  readonly name: string;
  dial(request: {
    attemptId: string;
    phone: string;
  }): Promise<{ providerCallId: string; status: ProviderCallStatus }>;
  lookup(providerCallId: string): Promise<ProviderCallStatus>;
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
