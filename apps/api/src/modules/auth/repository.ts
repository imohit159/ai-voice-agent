import type { DatabaseSync } from 'node:sqlite';
import type { UserRole } from '@orderline/contracts';
import type { UserSummary } from '@orderline/contracts/api';

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  sessionVersion: number;
  disabledAt: string | null;
  createdAt: string;
}

type Row = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  session_version: number;
  disabled_at: string | null;
  created_at: string;
};

const toUser = (row: Row): StoredUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  passwordHash: row.password_hash,
  sessionVersion: row.session_version,
  disabledAt: row.disabled_at,
  createdAt: row.created_at,
});

export const toSummary = (user: StoredUser): UserSummary => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  disabled: user.disabledAt !== null,
  createdAt: user.createdAt,
});

export function createUserRepository(db: DatabaseSync) {
  const one = (sql: string, value: string) => {
    const row = db.prepare(sql).get(value) as Row | undefined;
    return row ? toUser(row) : null;
  };
  return {
    count(): number {
      return (
        db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }
      ).n;
    },
    activeAdminCount(): number {
      return (
        db
          .prepare(
            "SELECT count(*) AS n FROM users WHERE role='admin' AND disabled_at IS NULL",
          )
          .get() as { n: number }
      ).n;
    },
    byId: (id: string) => one('SELECT * FROM users WHERE id=?', id),
    byEmail: (email: string) => one('SELECT * FROM users WHERE email=?', email),
    list(): StoredUser[] {
      return (
        db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]
      ).map(toUser);
    },
    insert(user: StoredUser, at: string): void {
      db.prepare(
        `INSERT INTO users (id, email, name, role, password_hash, session_version,
          disabled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        user.id,
        user.email,
        user.name,
        user.role,
        user.passwordHash,
        user.sessionVersion,
        user.disabledAt,
        at,
        at,
      );
    },
    /** Any change here bumps the session version, signing the user out everywhere. */
    update(
      id: string,
      change: Pick<StoredUser, 'name' | 'role' | 'passwordHash' | 'disabledAt'>,
      at: string,
    ): void {
      db.prepare(
        `UPDATE users SET name=?, role=?, password_hash=?, disabled_at=?,
          session_version = session_version + 1, updated_at=? WHERE id=?`,
      ).run(
        change.name,
        change.role,
        change.passwordHash,
        change.disabledAt,
        at,
        id,
      );
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
