import { label } from './format.js';

/** Status pill; the status value doubles as its CSS modifier class. */
export function Badge({ value }: { value: string | null }) {
  return (
    <span className={`badge ${value ?? 'pending'}`}>
      <span className="dot" aria-hidden="true" />
      {value ? label(value) : 'Awaiting decision'}
    </span>
  );
}
