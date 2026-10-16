import type { TranscriptEntry } from '@orderline/contracts/api';

/** Consecutive lines from the same speaker read as one turn. */
export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const turns: TranscriptEntry[] = [];
  for (const entry of entries) {
    const last = turns.at(-1);
    if (last?.role === entry.role)
      turns[turns.length - 1] = { ...last, text: `${last.text} ${entry.text}` };
    else turns.push(entry);
  }
  if (!turns.length)
    return <p className="muted">No transcript recorded yet.</p>;
  return (
    <>
      {turns.map((turn, index) => (
        <div className="transcript-turn" key={index}>
          <span>{turn.role === 'agent' ? 'AGENT' : 'CUSTOMER'}</span>
          <p>{turn.text}</p>
        </div>
      ))}
    </>
  );
}
