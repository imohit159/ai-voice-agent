import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.js';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  settingsSchema,
  type Call,
  type CallStatus,
  type Order,
  type Outcome,
  type Settings,
  type Transcript,
} from '@orderline/contracts';

export class Store {
  // Exposed so new module repositories share the connection until the legacy
  // demo store is retired; the store still owns closing it.
  readonly db: DatabaseSync;
  constructor(
    path: string,
    settings: z.input<typeof settingsSchema>,
    phone: string,
  ) {
    this.db = openDatabase(path);
    const sample: Order = {
      id: 'DEMO-1001',
      customerName: 'Test Customer',
      phone,
      items: '1 × Wireless headphones (sample product)',
      amount: 1499,
      currency: 'INR',
      address: 'Sample delivery area: Bengaluru',
      outcome: null,
      isDemo: true,
    };
    this.db
      .prepare('INSERT OR IGNORE INTO orders VALUES (?,?)')
      .run(sample.id, JSON.stringify(sample));
    const defaults = settingsSchema.parse(settings);
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES (1,?)')
      .run(JSON.stringify(defaults));
    const existing = this.decode<Record<string, unknown>>(
      this.db.prepare('SELECT data FROM settings WHERE id=1').get(),
    )!;
    this.saveSettings(settingsSchema.parse({ ...defaults, ...existing }));
    // Browser sessions cannot survive a process restart; phone attempts need reconciliation.
    for (const call of this.calls()) {
      if (ACTIVE_STATUSES.includes(call.status) && call.status !== 'unknown') {
        this.update(
          call.id,
          call.mode === 'browser'
            ? {
                status: 'failed',
                error: 'Practice interrupted by server restart.',
              }
            : {
                status: 'unknown',
                error:
                  'Server restarted. Reconcile with Exotel before retrying.',
              },
        );
      }
    }
  }
  close() {
    this.db.close();
  }
  private decode<T>(row: unknown): T | null {
    return row ? (JSON.parse((row as { data: string }).data) as T) : null;
  }
  orders(): Order[] {
    return this.db
      .prepare('SELECT data FROM orders')
      .all()
      .map((r) => this.decode<Order>(r)!);
  }
  order(id: string): Order | null {
    return this.decode(
      this.db.prepare('SELECT data FROM orders WHERE id=?').get(id),
    );
  }
  settings(): Settings {
    return this.decode<Settings>(
      this.db.prepare('SELECT data FROM settings WHERE id=1').get(),
    )!;
  }
  saveSettings(settings: Settings) {
    this.db
      .prepare('UPDATE settings SET data=? WHERE id=1')
      .run(JSON.stringify(settings));
  }
  calls(): Call[] {
    return this.db
      .prepare('SELECT data FROM calls ORDER BY rowid DESC LIMIT 200')
      .all()
      .map((r) => this.decode<Call>(r)!);
  }
  call(id: string): Call | null {
    return this.decode(
      this.db.prepare('SELECT data FROM calls WHERE id=?').get(id),
    );
  }
  byKey(key: string): Call | null {
    return this.decode(
      this.db.prepare('SELECT data FROM calls WHERE request_key=?').get(key),
    );
  }
  byProviderSid(sid: string): Call | null {
    return this.decode(
      this.db
        .prepare(
          "SELECT data FROM calls WHERE json_extract(data, '$.providerSid')=? LIMIT 1",
        )
        .get(sid),
    );
  }
  hasActivePhoneCall(orderId: string): boolean {
    const statuses = ACTIVE_STATUSES.map(() => '?').join(',');
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM calls WHERE order_id=? AND mode='phone' AND status IN (${statuses}) LIMIT 1`,
        )
        .get(orderId, ...ACTIVE_STATUSES),
    );
  }
  activeCount(): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM calls WHERE status IN ('queued','connecting','active','unknown')",
        )
        .get()!.n,
    );
  }
  create(orderId: string, mode: Call['mode'], key: string): Call {
    const call: Call = {
      id: randomUUID(),
      orderId,
      mode,
      status: 'queued',
      outcome: null,
      agentSettings: this.settings(),
      summary: null,
      providerSid: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id,order_id,mode,status,request_key,data) VALUES (?,?,?,?,?,?)',
      )
      .run(call.id, orderId, mode, call.status, key, JSON.stringify(call));
    return call;
  }
  claim(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE calls SET claimed=1 WHERE id=? AND claimed=0 AND status IN ('queued','connecting','active','unknown')",
        )
        .run(id).changes === 1
    );
  }
  update(
    id: string,
    change: Partial<Omit<Call, 'id' | 'orderId' | 'mode' | 'createdAt'>>,
  ): Call {
    const call = this.call(id);
    if (!call) throw new Error('Call not found.');
    // Late provider events must not regress a terminal attempt.
    if (
      TERMINAL_STATUSES.includes(call.status) &&
      change.status &&
      ACTIVE_STATUSES.includes(change.status)
    )
      delete change.status;
    if (
      call.status === 'active' &&
      (change.status === 'queued' || change.status === 'connecting')
    )
      delete change.status;
    const updated = { ...call, ...change };
    if (TERMINAL_STATUSES.includes(updated.status))
      updated.endedAt ??= new Date().toISOString();
    this.db
      .prepare('UPDATE calls SET status=?,data=? WHERE id=?')
      .run(updated.status, JSON.stringify(updated), id);
    return updated;
  }
  setOutcome(id: string, outcome: Outcome, evidence: string): Call {
    const call = this.call(id);
    if (!call || !['active', 'connecting'].includes(call.status))
      throw new Error('Call is not active.');
    if (call.outcome && call.outcome !== outcome)
      throw new Error('An outcome is already recorded.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.update(id, { outcome, summary: evidence });
      if (call.mode === 'phone') {
        const order = this.order(call.orderId)!;
        this.db
          .prepare('UPDATE orders SET data=? WHERE id=?')
          .run(JSON.stringify({ ...order, outcome }), order.id);
      }
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  appendTranscript(id: string, role: Transcript['role'], text: string) {
    if (!text.trim()) return;
    this.db
      .prepare(
        'INSERT INTO transcripts(call_id,role,text,created_at) VALUES (?,?,?,?)',
      )
      .run(id, role, text.slice(0, 4000), new Date().toISOString());
  }
  transcripts(id: string): Transcript[] {
    return this.db
      .prepare(
        'SELECT id,role,text,created_at AS createdAt FROM transcripts WHERE call_id=? ORDER BY id LIMIT 1000',
      )
      .all() as unknown as Transcript[];
  }
  resetDemo() {
    if (this.activeCount())
      throw new Error(
        'Finish or reconcile active calls before resetting the demo.',
      );
    const order = this.order('DEMO-1001')!;
    this.db
      .prepare('UPDATE orders SET data=? WHERE id=?')
      .run(JSON.stringify({ ...order, outcome: null }), order.id);
  }
}
