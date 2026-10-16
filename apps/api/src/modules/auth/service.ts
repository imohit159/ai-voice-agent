import type { UserRole } from '@orderline/contracts';
import type { SessionUser } from '@orderline/contracts/api';
import type { AuditRecorder } from '../audit/module.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  toSummary,
  type StoredUser,
  type UserRepository,
} from './repository.js';

export class AuthError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type Dependencies = {
  users: UserRepository;
  audit: AuditRecorder;
  /** Signs `${userId}.${sessionVersion}`; verify returns it or null. */
  issueSessionToken: (subject: string) => string;
  readSessionToken: (token: string) => string | null;
  now: () => Date;
  newId: () => string;
};

// Compared against when the email is unknown, so timing does not reveal which accounts exist.
const UNKNOWN_USER_HASH = hashPassword('timing-equaliser-not-a-real-password');

const sessionUser = (user: StoredUser): SessionUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
});

export function createAuth({
  users,
  audit,
  issueSessionToken,
  readSessionToken,
  now,
  newId,
}: Dependencies) {
  const timestamp = () => now().toISOString();

  async function bootstrapAdmin(email: string, password: string) {
    if (users.count() > 0) return false;
    users.insert(
      {
        id: newId(),
        email,
        name: 'Administrator',
        role: 'admin',
        passwordHash: await hashPassword(password),
        sessionVersion: 1,
        disabledAt: null,
        createdAt: timestamp(),
      },
      timestamp(),
    );
    return true;
  }

  function resolve(token?: string): SessionUser | null {
    const subject = token ? readSessionToken(token) : null;
    const [id, version] = subject?.split('.') ?? [];
    const user = id ? users.byId(id) : null;
    if (!user || user.disabledAt || String(user.sessionVersion) !== version)
      return null;
    return sessionUser(user);
  }

  async function login(email: string, password: string) {
    const user = users.byEmail(email);
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? (await UNKNOWN_USER_HASH),
    );
    if (!user || !valid || user.disabledAt)
      throw new AuthError(401, 'Incorrect email or password.');
    audit({ userId: user.id, action: 'auth.login' });
    return {
      token: issueSessionToken(`${user.id}.${user.sessionVersion}`),
      user: sessionUser(user),
    };
  }

  function requireUser(id: string): StoredUser {
    const user = users.byId(id);
    if (!user) throw new AuthError(404, 'User not found.');
    return user;
  }

  async function createUser(
    actor: SessionUser,
    input: { email: string; name: string; role: UserRole; password: string },
  ) {
    if (users.byEmail(input.email))
      throw new AuthError(409, 'A user with this email already exists.');
    const user: StoredUser = {
      id: newId(),
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await hashPassword(input.password),
      sessionVersion: 1,
      disabledAt: null,
      createdAt: timestamp(),
    };
    users.insert(user, timestamp());
    audit({
      userId: actor.id,
      action: 'user.created',
      subjectType: 'user',
      subjectId: user.id,
    });
    return toSummary(user);
  }

  function updateUser(
    actor: SessionUser,
    id: string,
    change: { name?: string; role?: UserRole; disabled?: boolean },
  ) {
    const user = requireUser(id);
    const role = change.role ?? user.role;
    const disabledAt =
      change.disabled === undefined
        ? user.disabledAt
        : change.disabled
          ? (user.disabledAt ?? timestamp())
          : null;
    const losesAdmin =
      user.role === 'admin' &&
      !user.disabledAt &&
      (role !== 'admin' || disabledAt);
    if (losesAdmin && user.id === actor.id)
      throw new AuthError(
        409,
        'You cannot remove your own administrator access.',
      );
    if (losesAdmin && users.activeAdminCount() <= 1)
      throw new AuthError(
        409,
        'At least one active administrator is required.',
      );
    users.update(
      id,
      {
        name: change.name ?? user.name,
        role,
        passwordHash: user.passwordHash,
        disabledAt,
      },
      timestamp(),
    );
    audit({
      userId: actor.id,
      action: 'user.updated',
      subjectType: 'user',
      subjectId: id,
    });
    return toSummary(requireUser(id));
  }

  async function resetPassword(
    actor: SessionUser,
    id: string,
    password: string,
  ) {
    const user = requireUser(id);
    users.update(
      id,
      {
        name: user.name,
        role: user.role,
        passwordHash: await hashPassword(password),
        disabledAt: user.disabledAt,
      },
      timestamp(),
    );
    audit({
      userId: actor.id,
      action: 'user.password_reset',
      subjectType: 'user',
      subjectId: id,
    });
  }

  async function changeOwnPassword(
    actor: SessionUser,
    current: string,
    next: string,
  ) {
    const user = requireUser(actor.id);
    if (!(await verifyPassword(current, user.passwordHash)))
      throw new AuthError(403, 'Your current password is incorrect.');
    await resetPassword(actor, actor.id, next);
    // The version bump signed this session out too; hand back a fresh one.
    const updated = requireUser(actor.id);
    return issueSessionToken(`${updated.id}.${updated.sessionVersion}`);
  }

  return {
    bootstrapAdmin,
    resolve,
    login,
    listUsers: () => users.list().map(toSummary),
    createUser,
    updateUser,
    resetPassword,
    changeOwnPassword,
  };
}

export type Auth = ReturnType<typeof createAuth>;
