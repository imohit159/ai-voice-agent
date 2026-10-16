import type { WorkspaceState } from '@orderline/contracts/api';
import { Badge } from '../../../shared/ui/Badge.js';
import { rupees } from '../../../shared/ui/format.js';
import { useToast } from '../../../shared/ui/Toast.js';
import { Transcript } from '../../calls/components/Transcript.js';
import { usePractice, type PracticeStatus } from '../hooks/usePractice.js';

const STATUS_TEXT: Record<PracticeStatus, string> = {
  idle: 'Ready for a conversation',
  connecting: 'Connecting to your agent…',
  live: 'Live: speak naturally',
  ended: 'Practice complete',
};

export function PracticePage({ state }: { state: WorkspaceState }) {
  const toast = useToast();
  const practice = usePractice(toast);
  const order = state.orders[0];
  const running =
    practice.status === 'connecting' || practice.status === 'live';
  const provider =
    state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini Live';
  const ready = state.connections.selectedConfigured;

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">VOICE PRACTICE</span>
          <h1>Talk to your agent</h1>
          <p>
            The same conversation a customer gets, using a sample order. No
            phone call is placed.
          </p>
        </div>
      </div>
      <div className="work-grid">
        <div className="order-column">
          {order && (
            <section className="panel order-panel">
              <div className="panel-heading">
                <h2>Sample order</h2>
                <span className="sample-tag">SAMPLE DATA</span>
              </div>
              <div className="order-detail">
                <div>
                  <span className="eyebrow">{order.id}</span>
                  <h3>{order.items}</h3>
                  <p>{order.address}</p>
                </div>
                <div className="destination">
                  <span>Customer</span>
                  <strong>{order.customerName}</strong>
                  <span>{rupees(order.amount)} · cash on delivery</span>
                </div>
              </div>
            </section>
          )}
          <section className="workflow-strip">
            <span className="eyebrow">HOW THE AGENT HANDLES A CALL</span>
            <div>
              <span>
                <b>01</b> Disclose & verify identity
              </span>
              <span>
                <b>02</b> Read the order back
              </span>
              <span>
                <b>03</b> Record the decision, then hang up
              </span>
            </div>
            <p>
              Nothing is changed in your systems: the outcome is reported for
              your team to act on.
            </p>
          </section>
        </div>
        <aside className="agent-column">
          <section className="panel agent-panel">
            <div className="panel-heading">
              <h2>Your voice agent</h2>
              <span className="live-label">
                <span className="dot" aria-hidden="true" />
                {running ? 'LIVE' : 'PRACTICE'}
              </span>
            </div>
            <div className={`agent-stage ${running ? 'running' : ''}`}>
              <div className="soundmark" aria-hidden="true">
                {Array.from({ length: 9 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
              <h3 aria-live="polite">{STATUS_TEXT[practice.status]}</h3>
              <p>
                {state.settings.storeName} · {state.settings.language} ·{' '}
                {provider}
              </p>
            </div>
            <button
              className={running ? 'stop-button' : 'primary'}
              disabled={!running && !ready}
              onClick={running ? practice.stop : () => void practice.start()}
            >
              {running ? 'End practice ■' : 'Start voice practice →'}
            </button>
            <small className="practice-note">
              {ready
                ? 'Uses your microphone. Allow access when the browser asks.'
                : `The voice agent is not running, or has no ${provider} key.`}
            </small>
            {practice.attempt?.attempt.outcome && (
              <p>
                <Badge value={practice.attempt.attempt.outcome} />
              </p>
            )}
            <div className="live-transcript" aria-live="polite">
              <Transcript entries={practice.attempt?.transcript ?? []} />
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
