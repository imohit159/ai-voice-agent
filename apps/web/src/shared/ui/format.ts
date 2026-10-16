const labels: Record<string, string> = {
  confirmed: 'Confirmed',
  cancel_requested: 'Cancel requested',
  change_requested: 'Change requested',
  callback_requested: 'Call back',
  wrong_person: 'Wrong person',
  needs_follow_up: 'Follow up',
  pending: 'Pending',
  dialing: 'Dialling',
  ringing: 'Ringing',
  in_progress: 'In progress',
  unknown: 'Needs check',
  completed: 'Completed',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  exhausted: 'No answer, done',
  expired: 'Expired',
  delivered: 'Delivered',
  ready: 'Ready',
  configured: 'Configured',
  missing: 'Setup needed',
  simulated: 'Simulated',
  admin: 'Admin',
  viewer: 'Viewer',
  disabled: 'Disabled',
  active: 'Active',
};

export const label = (value: string) => labels[value] ?? value;

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export const rupees = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;
