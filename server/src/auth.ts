import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { parse as parseCookie } from 'cookie';
import { activeInstanceBan, db, publicUser, type PublicUser } from './db.js';

const SESSION_DAYS = 30;
const COOKIE_NAME = 'opencord_session';

export type AuthenticatedRequest = Request & { user?: PublicUser };

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createSession(userId: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, expiresAt, now);
  return { token, expiresAt };
}

export function destroySession(token: string | undefined) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyAllSessions(userId: number) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function readSessionToken(req: Request) {
  const cookies = parseCookie(req.headers.cookie ?? '');
  return cookies[COOKIE_NAME];
}

export function getUserFromToken(token: string | undefined): PublicUser | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0
  `).get(sha256(token), Date.now());
  if (!row) return null;
  if (activeInstanceBan(Number((row as any).id))) return null;
  return publicUser(row, true);
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const user = getUserFromToken(readSessionToken(req));
  if (!user) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  req.user = user;
  next();
}

export function requireInstanceAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user?.isInstanceAdmin) {
    res.status(403).json({ error: 'Access restricted to instance administrators.' });
    return;
  }
  next();
}

export function setSessionCookie(res: Response, token: string, expiresAt: number) {
  const secure = process.env.COOKIE_SECURE === 'true';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    expires: new Date(expiresAt),
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  const secure = process.env.COOKIE_SECURE === 'true';
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    path: '/',
  });
}
