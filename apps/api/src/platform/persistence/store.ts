import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database.js';
import {
  settingsSchema,
  type Order,
  type Settings,
} from '@orderline/contracts';

/**
 * Demo order and agent settings for the operator dashboard. Call data lives in
 * the call-management repositories; this store opens the shared connection.
 */
export class Store {
  // Exposed so module repositories share the connection; the store owns closing it.
  readonly db: DatabaseSync;
  constructor(
    path: string,
    // Unvalidated defaults: parsed here, so retired model names fall back safely.
    settings: Record<string, unknown>,
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
  resetDemo() {
    const order = this.order('DEMO-1001')!;
    this.db
      .prepare('UPDATE orders SET data=? WHERE id=?')
      .run(JSON.stringify({ ...order, outcome: null }), order.id);
  }
}
