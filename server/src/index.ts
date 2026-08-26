import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import { Server as SocketServer } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import { z } from 'zod';
import {
  clearSessionCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  getUserFromToken,
  readSessionToken,
  requireAuth,
  requireInstanceAdmin,
  setSessionCookie,
  type AuthenticatedRequest,
} from './auth.js';
import { audit } from './audit.js';
import { activeInstanceBan, activePremiumForUser, backupDir, createBackup, db, instanceAudit, premiumBenefits, publicUser, rootDir, type PremiumBenefits, type PublicUser } from './db.js';
import {
  ALL_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  getChannelPermissions,
  getServerPermissions,
  hasChannelPermission,
  hasPermission,
  isServerOwner,
  Permission,
} from './permissions.js';
import { channelNameSchema, displayNameSchema, hexColorSchema, messageSchema, parseId, passwordSchema, serverNameSchema, usernameSchema } from './validation.js';

const uploadDir = path.join(rootDir, 'uploads');
const clientDist = path.join(rootDir, 'client', 'dist');
fs.mkdirSync(uploadDir, { recursive: true });

const isDevelopment = process.env.NODE_ENV === 'development' || process.env.npm_lifecycle_event === 'dev';

const app = express();
const server = http.createServer(app);

// Lê as origens permitidas na hora de criar o servidor (antes de configuredOrigins ser inicializado)
const _allowedOriginsRaw = [process.env.PUBLIC_URL, ...(process.env.ALLOWED_ORIGINS ?? '').split(',')]
  .map((v) => v?.trim()).filter(Boolean) as string[];

const io = new SocketServer(server, {
  cors: {
    origin: isDevelopment
      ? [/^http:\/\/(?:localhost|127\.0\.0\.1):5173$/]
      : _allowedOriginsRaw.length > 0
        ? _allowedOriginsRaw
        : false,
    credentials: true,
  },
  maxHttpBufferSize: 2_000_000,
});

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const termsVersion = '2026-08-23';
const trustProxy = (process.env.TRUST_PROXY ?? 'loopback').trim();
if (trustProxy && trustProxy !== 'false') app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? 1 : trustProxy);

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", 'data:', 'blob:'],
      "media-src": ["'self'", 'blob:'],
      "connect-src": ["'self'", 'ws:', 'wss:'],
    },
  },
}));
app.use(compression());
app.use(cors({ origin: isDevelopment ? [/^http:\/\/(?:localhost|127\.0\.0\.1):5173$/] : false, credentials: true }));
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
app.use('/uploads', express.static(uploadDir, { fallthrough: false, maxAge: '1h' }));

const configuredOrigins = new Set(
  [process.env.PUBLIC_URL, ...(process.env.ALLOWED_ORIGINS ?? '').split(',')]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        console.warn(`Invalid configured origin ignored: ${value}`);
        return [];
      }
    }),
);

function isLoopbackHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function isAllowedRequestOrigin(req: express.Request, originHeader: string) {
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  if (configuredOrigins.has(origin.origin)) return true;

  const hostHeader = req.get('host');
  if (hostHeader && origin.host === hostHeader) return true;

  if (isDevelopment && hostHeader) {
    const requestHostname = hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : hostHeader.split(':')[0];

    if (origin.hostname === requestHostname) return true;
    if (isLoopbackHostname(origin.hostname) && isLoopbackHostname(requestHostname)) return true;
  }

  return false;
}

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const origin = req.get('origin');

  // Bloqueia cross-site apenas quando a origem não está na lista de permitidas
  if (req.get('sec-fetch-site') === 'cross-site') {
    if (!origin || !isAllowedRequestOrigin(req, origin)) {
      return res.status(403).json({ error: 'Invalid origin.' });
    }
    return next();
  }

  if (!origin) return next();
  if (!isAllowedRequestOrigin(req, origin)) {
    return res.status(403).json({ error: 'Invalid origin.' });
  }

  next();
});

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 360, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', apiLimiter);

const imageMimes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);
const animatedImageMimes = new Map([...imageMimes, ['image/gif', '.gif']]);
const soundMimes = new Map([['audio/mpeg', '.mp3'], ['audio/ogg', '.ogg'], ['audio/wav', '.wav'], ['audio/x-wav', '.wav']]);
const attachmentMimes = new Map([
  ...imageMimes,
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['video/mp4', '.mp4'],
]);

function makeUpload(allowed: Map<string, string>, maxBytes: number) {
  return multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${allowed.get(file.mimetype) ?? '.bin'}`),
    }),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, callback) => callback(null, allowed.has(file.mimetype)),
  });
}

const imageUpload = makeUpload(imageMimes, 4 * 1024 * 1024);
const profileImageUpload = makeUpload(animatedImageMimes, 12 * 1024 * 1024);
const premiumImageUpload = makeUpload(animatedImageMimes, 8 * 1024 * 1024);
const premiumEmojiUpload = makeUpload(animatedImageMimes, 2 * 1024 * 1024);
const premiumSoundUpload = makeUpload(soundMimes, 5 * 1024 * 1024);
const badgeUpload = makeUpload(imageMimes, 1024 * 1024);
const attachmentUpload = makeUpload(attachmentMimes, 500 * 1024 * 1024);


function premiumMembership(userId: number) {
  return activePremiumForUser(userId);
}

function hasPremiumBenefit<K extends keyof PremiumBenefits>(userId: number, key: K): boolean {
  const premium = premiumMembership(userId);
  if (!premium) return false;
  const value = premium.benefits[key];
  return typeof value === 'boolean' ? value : Number(value) > 0;
}

function numericPremiumBenefit<K extends keyof PremiumBenefits>(userId: number, key: K, fallback: number): number {
  const premium = premiumMembership(userId);
  if (!premium) return fallback;
  const value = premium.benefits[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function removeUserUpload(filePath: string | null | undefined) {
  if (filePath?.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(filePath)), { force: true }, () => undefined);
}

function saveProfileHistory(userId: number) {
  const premium = premiumMembership(userId);
  const days = premium?.benefits.profileHistoryDays ?? 0;
  if (!premium || days <= 0) return;
  const row = db.prepare(`SELECT username, display_name, bio, status_text, avatar_path, banner_path, profile_theme, profile_gradient, profile_effect,
    avatar_decoration_path, profile_background_path, custom_join_sound_path, special_identity FROM users WHERE id = ?`).get(userId) as any;
  if (!row) return;
  db.prepare('INSERT INTO user_profile_history (user_id, snapshot, created_at) VALUES (?, ?, ?)').run(userId, JSON.stringify(row), Date.now());
  db.prepare('DELETE FROM user_profile_history WHERE user_id = ? AND created_at < ?').run(userId, Date.now() - days * 86400000);
}

function fail(res: express.Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function userById(id: number, includePrivate = false): PublicUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id);
  return row ? publicUser(row, includePrivate) : null;
}

function isMember(userId: number, serverId: number) {
  return Boolean(db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId));
}

function serverForChannel(channelId: number) {
  return db.prepare('SELECT server_id, kind FROM channels WHERE id = ?').get(channelId) as { server_id: number; kind: string } | undefined;
}

function canAccessChannel(userId: number, channelId: number) {
  const row = serverForChannel(channelId);
  return Boolean(row && isMember(userId, Number(row.server_id)) && hasChannelPermission(userId, channelId, Permission.VIEW_CHANNEL));
}

function friendshipStatus(a: number, b: number) {
  return db.prepare(`
    SELECT id, requester_id, addressee_id, status
    FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(a, b, b, a) as any;
}

function isBlocked(a: number, b: number) {
  return Boolean(db.prepare('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a));
}

function emitServerRefresh(serverId: number) {
  io.to(`server:${serverId}`).emit('server:refresh', { serverId });
}

function safeJson(value: string | null | undefined) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function messageAttachments(messageId: number) {
  return (db.prepare('SELECT id, path, original_name, mime_type, size_bytes FROM message_attachments WHERE message_id = ? ORDER BY id').all(messageId) as any[]).map((item) => ({
    id: Number(item.id), path: item.path, name: item.original_name, mimeType: item.mime_type, size: Number(item.size_bytes),
  }));
}

function messageReactions(messageId: number, viewerId: number) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
    FROM message_reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(created_at)
  `).all(viewerId, messageId) as any[];
  return rows.map((item) => ({ emoji: item.emoji, count: Number(item.count), mine: Boolean(item.mine) }));
}

function messageRowToJson(row: any, viewerId: number) {
  let replyTo = null;
  if (row.reply_to_id) {
    const reply = db.prepare(`
      SELECT m.id, m.content, u.id AS author_id, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
      FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?
    `).get(row.reply_to_id) as any;
    if (reply) replyTo = { id: Number(reply.id), content: reply.content, author: publicUser({ ...reply, id: reply.author_id, created_at: reply.user_created_at }) };
  }
  return {
    id: Number(row.id),
    channelId: Number(row.channel_id),
    author: publicUser({ ...row, id: row.author_id, created_at: row.user_created_at ?? row.created_at }),
    content: row.content,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    pinned: Boolean(row.pinned),
    replyTo,
    attachments: messageAttachments(Number(row.id)),
    reactions: messageReactions(Number(row.id), viewerId),
  };
}

function getMessage(messageId: number, viewerId: number) {
  const row = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
    FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?
  `).get(messageId) as any;
  return row ? messageRowToJson(row, viewerId) : null;
}

function removeUploaded(files: Express.Multer.File[] = []) {
  for (const file of files) fs.rm(file.path, { force: true }, () => undefined);
}

function ensureEveryoneRole(serverId: number) {
  const existing = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_everyone = 1').get(serverId) as any;
  if (existing) return Number(existing.id);
  return Number(db.prepare("INSERT INTO roles (server_id, name, color, permissions, position, is_everyone) VALUES (?, '@everyone', '#99aab5', ?, -1, 1)")
    .run(serverId, DEFAULT_MEMBER_PERMISSIONS).lastInsertRowid);
}

function serverMemberRoles(serverId: number, userId: number) {
  return (db.prepare(`
    SELECT r.id, r.name, r.color, r.permissions, r.position, r.is_everyone
    FROM roles r LEFT JOIN member_roles mr ON mr.role_id = r.id AND mr.user_id = ? AND mr.server_id = ?
    WHERE r.server_id = ? AND (r.is_everyone = 1 OR mr.user_id IS NOT NULL)
    ORDER BY r.position DESC, r.id
  `).all(userId, serverId, serverId) as any[]).map((r) => ({
    id: Number(r.id), name: r.name, color: r.color, permissions: Number(r.permissions), position: Number(r.position), isEveryone: Boolean(r.is_everyone),
  }));
}

function instanceSetting(key: string, fallback = '') {
  const row = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key) as any;
  return row?.value ?? fallback;
}

function setInstanceSetting(key: string, value: string) {
  db.prepare(`INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, value);
}

const onlineUsers = new Map<number, number>();
type VoiceState = { socketId: string; userId: number; user: PublicUser; channelId: number; serverId: number; selfMuted: boolean; selfDeafened: boolean; serverMuted: boolean; serverDeafened: boolean; cameraOn: boolean; screenOn: boolean };
const voiceStates = new Map<string, VoiceState>();

function publicPresence(userId: number, declared: PublicUser['presence']) {
  if (!onlineUsers.get(userId)) return 'offline';
  return declared === 'invisible' ? 'offline' : declared;
}

function voiceStatesForServer(serverId: number) {
  return [...voiceStates.values()].filter((state) => state.serverId === serverId).map((state) => ({ ...state, socketId: undefined }));
}

function emitVoiceState(serverId: number) {
  io.to(`server:${serverId}`).emit('voice:state', { serverId, states: voiceStatesForServer(serverId) });
}

function leaveVoiceSocket(socket: any) {
  const state = voiceStates.get(socket.id);
  const room = socket.data.voiceRoom as string | undefined;
  if (room) {
    socket.leave(room);
    socket.to(room).emit('voice:user-left', { socketId: socket.id, userId: socket.data.user?.id });
  }
  if (state) {
    voiceStates.delete(socket.id);
    emitVoiceState(state.serverId);
  }
  delete socket.data.voiceRoom;
  delete socket.data.voiceChannelId;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'OpenCord', version: '0.6.0' }));

app.get('/api/config', requireAuth, (req: AuthenticatedRequest, res) => {
  let iceServers: unknown[] = [];
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON ?? '[]');
    if (Array.isArray(parsed)) iceServers = parsed;
  } catch {
    console.warn('Invalid ICE_SERVERS_JSON; using an empty list.');
  }
  res.json({ iceServers, instanceName: instanceSetting('name', 'OpenCord'), instanceLogo: instanceSetting('logo', ''), premium: req.user ? activePremiumForUser(req.user.id) : null });
});

app.get('/api/instance', (_req, res) => {
  res.json({ name: instanceSetting('name', 'OpenCord'), description: instanceSetting('description', 'Your self-hosted place to talk.'), logo: instanceSetting('logo', ''), premiumName: instanceSetting('premiumName', 'Open+'), premiumColor: instanceSetting('premiumColor', '#f47fff'), premiumIcon: instanceSetting('premiumIcon', ''), termsVersion });
});

app.get('/api/monetization', (_req, res) => {
  res.json({
    enabled: instanceSetting('monetizationEnabled', 'false') === 'true',
    supportTitle: instanceSetting('supportTitle', 'Support OpenCord'),
    supportDescription: instanceSetting('supportDescription', 'Help fund development, maintenance, and infrastructure.'),
    supportUrl: instanceSetting('supportUrl', ''),
    supportButtonLabel: instanceSetting('supportButtonLabel', 'Support the project'),
    premiumCheckoutUrl: instanceSetting('premiumCheckoutUrl', ''),
    premiumCheckoutLabel: instanceSetting('premiumCheckoutLabel', 'Get access'),
    managedHostingUrl: instanceSetting('managedHostingUrl', ''),
    managedHostingLabel: instanceSetting('managedHostingLabel', 'Managed hosting'),
  });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const parsed = z.object({ username: usernameSchema, password: passwordSchema, displayName: displayNameSchema, acceptTerms: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid registration data.');
  const { username, password, displayName } = parsed.data;
  const isFirst = Number((db.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count) === 0;
  if (!isFirst && instanceSetting('registrationEnabled', 'true') !== 'true') return fail(res, 403, 'New registrations are disabled on this instance.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail(res, 409, 'That username is already in use.');
  const passwordHash = await bcrypt.hash(password, 12);
  const result = db.prepare('INSERT INTO users (username, password_hash, display_name, is_instance_admin, terms_accepted_at, terms_version) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, passwordHash, displayName, isFirst ? 1 : 0, Date.now(), termsVersion);
  const userId = Number(result.lastInsertRowid);
  if (isFirst) {
    const adminBadge = db.prepare("SELECT id FROM badges WHERE name = 'Administrator'").get() as any;
    if (adminBadge) db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id, assigned_by) VALUES (?, ?, ?)').run(userId, Number(adminBadge.id), userId);
  }
  const session = createSession(userId);
  setSessionCookie(res, session.token, session.expiresAt);
  return res.status(201).json({ user: userById(userId, true) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const parsed = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid credentials.');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(parsed.data.username) as any;
  if (!row || row.disabled || !(await bcrypt.compare(parsed.data.password, row.password_hash))) return fail(res, 401, 'Incorrect username or password.');
  const activeBan = activeInstanceBan(Number(row.id));
  if (activeBan) {
    return res.status(403).json({
      error: activeBan.expiresAt ? `Account banned until ${new Date(activeBan.expiresAt).toLocaleString('en-US')}. Reason: ${activeBan.reason}` : `Account permanently banned. Reason: ${activeBan.reason}`,
      ban: { reason: activeBan.reason, expiresAt: activeBan.expiresAt },
    });
  }
  const session = createSession(Number(row.id));
  setSessionCookie(res, session.token, session.expiresAt);
  return res.json({ user: publicUser(row, true) });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(readSessionToken(req));
  clearSessionCookie(res);
  return res.status(204).end();
});

app.post('/api/auth/logout-all', requireAuth, (req: AuthenticatedRequest, res) => {
  destroyAllSessions(req.user!.id);
  clearSessionCookie(res);
  return res.status(204).end();
});

app.post('/api/auth/password', requireAuth, authLimiter, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid password.');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!row || !(await bcrypt.compare(parsed.data.currentPassword, row.password_hash))) return fail(res, 401, 'Current password is incorrect.');
  const hash = await bcrypt.hash(parsed.data.newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user!.id);
  destroyAllSessions(req.user!.id);
  clearSessionCookie(res);
  return res.status(204).end();
});

app.get('/api/me', requireAuth, (req: AuthenticatedRequest, res) => res.json({ user: req.user }));

app.patch('/api/me', requireAuth, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({
    username: usernameSchema.optional(),
    displayName: displayNameSchema.optional(),
    bio: z.string().max(2000).optional(),
    statusText: z.string().max(160).optional(),
    presence: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid profile.');
  const premium = premiumMembership(req.user!.id);
  const bioMax = premium ? Math.max(190, premium.benefits.bioMaxLength) : 190;
  const statusMax = premium?.benefits.advancedStatus ? 160 : 64;
  if ((parsed.data.bio?.length ?? 0) > bioMax) return fail(res, 400, `Bio can contain at most ${bioMax} characters.`);
  if ((parsed.data.statusText?.length ?? 0) > statusMax) return fail(res, 400, `Status can contain at most ${statusMax} characters.`);
  const currentRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  if (parsed.data.username && parsed.data.username.toLowerCase() !== String(currentRow.username).toLowerCase()) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(parsed.data.username, req.user!.id)) return fail(res, 409, 'That username is already in use.');
  }
  saveProfileHistory(req.user!.id);
  db.prepare('UPDATE users SET username = ?, display_name = ?, bio = ?, status_text = ?, presence = ? WHERE id = ?').run(
    parsed.data.username ?? currentRow.username,
    parsed.data.displayName ?? currentRow.display_name,
    parsed.data.bio ?? currentRow.bio,
    parsed.data.statusText ?? currentRow.status_text,
    parsed.data.presence ?? currentRow.presence,
    req.user!.id,
  );
  const next = userById(req.user!.id, true)!;
  io.emit('user:update', next);
  io.emit('presence:update', { userId: next.id, presence: publicPresence(next.id, next.presence) });
  return res.json({ user: next });
});

app.get('/api/me/premium', requireAuth, (req: AuthenticatedRequest, res) => {
  const premium = premiumMembership(req.user!.id);
  return res.json({
    premium,
    system: {
      enabled: instanceSetting('premiumEnabled', 'true') === 'true',
      name: instanceSetting('premiumName', 'Open+'),
      description: instanceSetting('premiumDescription', 'Special benefits for this instance.'),
      color: instanceSetting('premiumColor', '#f47fff'),
      iconPath: instanceSetting('premiumIcon', '') || null,
      priceLabel: instanceSetting('premiumPriceLabel', 'Granted by the instance administration'),
      defaultDurationDays: Number(instanceSetting('premiumDefaultDurationDays', '30')) || 0,
      benefits: premiumBenefits(),
    },
  });
});

app.post('/api/me/premium/redeem', requireAuth, (req: AuthenticatedRequest, res) => {
  if (instanceSetting('premiumEnabled', 'true') !== 'true') return fail(res, 403, 'Premium memberships are currently disabled on this instance.');
  const parsed = z.object({ code: z.string().trim().min(8).max(80) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid redemption code.');
  const normalized = parsed.data.code.toUpperCase();
  const codeHash = crypto.createHash('sha256').update(normalized).digest('hex');
  try {
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM premium_redeem_codes WHERE code_hash = ?').get(codeHash) as any;
      if (!row || row.disabled || Number(row.use_count) >= Number(row.max_uses)) throw new Error('INVALID_CODE');
      if (db.prepare('SELECT 1 FROM premium_redeem_usage WHERE code_id = ? AND user_id = ?').get(Number(row.id), req.user!.id)) throw new Error('ALREADY_REDEEMED');
      const now = Date.now();
      const existing = db.prepare('SELECT starts_at, expires_at FROM user_premium WHERE user_id = ?').get(req.user!.id) as any;
      if (existing && existing.expires_at == null) throw new Error('ALREADY_PERMANENT');
      let expiresAt: number | null = null;
      if (row.duration_minutes != null) expiresAt = Math.max(now, Number(existing?.expires_at ?? 0)) + Number(row.duration_minutes) * 60_000;
      const update = db.prepare('UPDATE user_premium SET starts_at = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(now, expiresAt, req.user!.id);
      if (update.changes === 0) db.prepare('INSERT INTO user_premium (user_id, granted_by, starts_at, expires_at, updated_at) VALUES (?, NULL, ?, ?, CURRENT_TIMESTAMP)').run(req.user!.id, now, expiresAt);
      db.prepare('INSERT INTO premium_redeem_usage (code_id, user_id) VALUES (?, ?)').run(Number(row.id), req.user!.id);
      db.prepare('UPDATE premium_redeem_codes SET use_count = use_count + 1 WHERE id = ?').run(Number(row.id));
      instanceAudit(req.user!.id, 'PREMIUM_CODE_REDEEM', 'PREMIUM_CODE', Number(row.id));
      return expiresAt;
    })();
    io.to(`user:${req.user!.id}`).emit('premium:refresh');
    const user = userById(req.user!.id, true)!;
    io.emit('user:update', user);
    return res.json({ user, expiresAt: result, premium: activePremiumForUser(req.user!.id) });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CODE') return fail(res, 404, 'This redemption code is invalid, disabled, or fully used.');
    if (error instanceof Error && error.message === 'ALREADY_REDEEMED') return fail(res, 409, 'You already redeemed this code.');
    if (error instanceof Error && error.message === 'ALREADY_PERMANENT') return fail(res, 409, 'Your account already has a permanent premium membership.');
    console.error('[Premium] Redemption failed:', error);
    return fail(res, 500, 'Could not redeem this code.');
  }
});

app.get('/api/me/profile-history', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!hasPremiumBenefit(req.user!.id, 'profileHistoryDays')) return fail(res, 403, 'Your plan does not include profile history.');
  const days = numericPremiumBenefit(req.user!.id, 'profileHistoryDays', 0);
  const rows = db.prepare('SELECT id, snapshot, created_at FROM user_profile_history WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 200')
    .all(req.user!.id, Date.now() - days * 86400000) as any[];
  return res.json({ history: rows.map((row) => ({ id: Number(row.id), snapshot: safeJson(row.snapshot), createdAt: Number(row.created_at) })) });
});

app.patch('/api/me/premium-profile', requireAuth, (req: AuthenticatedRequest, res) => {
  const premium = premiumMembership(req.user!.id);
  if (!premium) return fail(res, 403, 'This feature requires the instance premium plan.');
  const safeGradientSchema = z.string().max(160).refine((value) => {
    if (!value) return true;
    if (/[;{}]/.test(value) || /url\s*\(/i.test(value)) return false;
    return /^(?:linear|radial)-gradient\([^\r\n]+\)$/i.test(value);
  });
  const parsed = z.object({
    profileTheme: z.enum(['', 'classic', 'midnight', 'glass', 'neon', 'minimal']).optional(),
    profileGradient: safeGradientSchema.optional(),
    profileEffect: z.enum(['', 'glow', 'pulse', 'stars']).optional(),
    specialIdentity: z.string().trim().max(48).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid customization.');
  if (parsed.data.profileTheme && !premium.benefits.customProfileTheme) return fail(res, 403, 'Profile themes are not included in your plan.');
  if (parsed.data.profileGradient && !premium.benefits.profileGradient) return fail(res, 403, 'Profile gradients are not included in your plan.');
  if (parsed.data.profileEffect && !premium.benefits.profileEffects) return fail(res, 403, 'Profile effects are not included in your plan.');
  if (parsed.data.specialIdentity && !premium.benefits.specialIdentity) return fail(res, 403, 'Special identity is not included in your plan.');
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  saveProfileHistory(req.user!.id);
  db.prepare('UPDATE users SET profile_theme = ?, profile_gradient = ?, profile_effect = ?, special_identity = ? WHERE id = ?').run(
    parsed.data.profileTheme ?? current.profile_theme,
    parsed.data.profileGradient ?? current.profile_gradient,
    parsed.data.profileEffect ?? current.profile_effect,
    parsed.data.specialIdentity ?? current.special_identity,
    req.user!.id,
  );
  const user = userById(req.user!.id, true)!;
  io.emit('user:update', user);
  return res.json({ user });
});

app.post('/api/me/avatar', requireAuth, profileImageUpload.single('avatar'), (req: AuthenticatedRequest, res) => {
  if (!req.file) return fail(res, 400, 'Select a PNG, JPEG, WebP, or GIF image.');
  if (req.file.mimetype === 'image/gif' && !hasPremiumBenefit(req.user!.id, 'animatedAvatar')) { removeUploaded([req.file]); return fail(res, 403, 'Animated avatars require the premium plan.'); }
  saveProfileHistory(req.user!.id);
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.avatar_path);
  const user = userById(req.user!.id, true)!;
  io.emit('user:update', user);
  return res.json({ user });
});

app.post('/api/me/banner', requireAuth, profileImageUpload.single('banner'), (req: AuthenticatedRequest, res) => {
  if (!req.file) return fail(res, 400, 'Select a PNG, JPEG, WebP, or GIF image.');
  if (req.file.mimetype === 'image/gif' && !hasPremiumBenefit(req.user!.id, 'animatedBanner')) { removeUploaded([req.file]); return fail(res, 403, 'Animated banners require the premium plan.'); }
  saveProfileHistory(req.user!.id);
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT banner_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET banner_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.banner_path);
  const user = userById(req.user!.id, true)!;
  io.emit('user:update', user);
  return res.json({ user });
});

app.post('/api/me/avatar-decoration', requireAuth, premiumImageUpload.single('image'), (req: AuthenticatedRequest, res) => {
  if (!hasPremiumBenefit(req.user!.id, 'avatarDecoration')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Avatar decorations are not included in your plan.'); }
  if (!req.file) return fail(res, 400, 'Select an image.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT avatar_decoration_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET avatar_decoration_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.avatar_decoration_path);
  const user = userById(req.user!.id, true)!; io.emit('user:update', user); return res.json({ user });
});

app.post('/api/me/profile-background', requireAuth, premiumImageUpload.single('image'), (req: AuthenticatedRequest, res) => {
  if (!hasPremiumBenefit(req.user!.id, 'profileBackground')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Profile backgrounds are not included in your plan.'); }
  if (!req.file) return fail(res, 400, 'Select an image.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT profile_background_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET profile_background_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.profile_background_path);
  const user = userById(req.user!.id, true)!; io.emit('user:update', user); return res.json({ user });
});

app.post('/api/me/custom-join-sound', requireAuth, premiumSoundUpload.single('sound'), (req: AuthenticatedRequest, res) => {
  if (!hasPremiumBenefit(req.user!.id, 'customJoinSound')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Custom join sounds are not included in your plan.'); }
  if (!req.file) return fail(res, 400, 'Select an MP3, OGG, or WAV file.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT custom_join_sound_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET custom_join_sound_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.custom_join_sound_path);
  const user = userById(req.user!.id, true)!; io.emit('user:update', user); return res.json({ user });
});


function premiumEmojiToken(name: string, id: number) {
  return `<:${name}:${id}>`;
}

function premiumEmojiPayload(row: any) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: String(row.name),
    imagePath: String(row.image_path),
    token: premiumEmojiToken(String(row.name), Number(row.id)),
  };
}

function validateCustomEmojiContent(userId: number, content: string) {
  const tokens = [...content.matchAll(/<:([a-z0-9_]{2,32}):(\d+)>/gi)];
  if (!tokens.length) return null;
  if (!hasPremiumBenefit(userId, 'externalEmojis')) return 'Custom emojis are not included in your plan.';
  for (const token of tokens) {
    const row = db.prepare('SELECT id, name FROM premium_emojis WHERE id = ?').get(Number(token[2])) as any;
    if (!row || String(row.name).toLowerCase() !== token[1].toLowerCase()) return 'The message contains an invalid custom emoji.';
  }
  return null;
}

app.get('/api/emojis', requireAuth, (req: AuthenticatedRequest, res) => {
  const search = String(req.query.search ?? '').trim().slice(0, 32);
  const mineOnly = String(req.query.mine ?? '') === '1';
  const premium = premiumMembership(req.user!.id);
  const canUseExternal = Boolean(premium?.benefits.externalEmojis) && !mineOnly;
  const rows = canUseExternal
    ? db.prepare(`SELECT * FROM premium_emojis WHERE (? = '' OR name LIKE ?) ORDER BY name COLLATE NOCASE LIMIT 120`).all(search, `%${search}%`) as any[]
    : db.prepare(`SELECT * FROM premium_emojis WHERE user_id = ? AND (? = '' OR name LIKE ?) ORDER BY name COLLATE NOCASE LIMIT 120`).all(req.user!.id, search, `%${search}%`) as any[];
  const favorites = (db.prepare('SELECT emoji_value FROM favorite_emojis WHERE user_id = ? ORDER BY created_at DESC').all(req.user!.id) as any[]).map((row) => String(row.emoji_value));
  return res.json({ emojis: rows.map(premiumEmojiPayload), favorites, favoriteLimit: premium?.benefits.favoriteEmojiSlots ?? 20 });
});

app.post('/api/me/emojis', requireAuth, premiumEmojiUpload.single('image'), (req: AuthenticatedRequest, res) => {
  if (!hasPremiumBenefit(req.user!.id, 'externalEmojis')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Custom emojis are not included in your plan.'); }
  if (!req.file) return fail(res, 400, 'Select a PNG, JPEG, WebP, or GIF image.');
  const name = String(req.body?.name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(name)) { removeUploaded([req.file]); return fail(res, 400, 'Use 2 to 32 characters: letters, numbers, and _.'); }
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM premium_emojis WHERE user_id = ?').get(req.user!.id) as any).count);
  if (count >= 100) { removeUploaded([req.file]); return fail(res, 400, 'Limit of 100 custom emojis per user reached.'); }
  try {
    const result = db.prepare('INSERT INTO premium_emojis (user_id, name, image_path) VALUES (?, ?, ?)').run(req.user!.id, name, `/uploads/${req.file.filename}`);
    const row = db.prepare('SELECT * FROM premium_emojis WHERE id = ?').get(Number(result.lastInsertRowid));
    return res.status(201).json({ emoji: premiumEmojiPayload(row) });
  } catch {
    removeUploaded([req.file]);
    return fail(res, 409, 'You already have an emoji with that name.');
  }
});

app.delete('/api/me/emojis/:emojiId', requireAuth, (req: AuthenticatedRequest, res) => {
  const emojiId = parseId(req.params.emojiId);
  const row = emojiId ? db.prepare('SELECT * FROM premium_emojis WHERE id = ? AND user_id = ?').get(emojiId, req.user!.id) as any : null;
  if (!row) return fail(res, 404, 'Emoji not found.');
  const token = premiumEmojiToken(String(row.name), Number(row.id));
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM favorite_emojis WHERE emoji_value = ?').run(token);
    db.prepare('DELETE FROM premium_emojis WHERE id = ?').run(emojiId);
  });
  transaction();
  removeUserUpload(row.image_path);
  return res.status(204).end();
});

app.put('/api/me/emoji-favorites', requireAuth, (req: AuthenticatedRequest, res) => {
  const value = String(req.body?.value ?? '').trim().slice(0, 80);
  if (!value) return fail(res, 400, 'Invalid emoji.');
  const premium = premiumMembership(req.user!.id);
  const limit = Math.max(1, Number(premium?.benefits.favoriteEmojiSlots ?? 20));
  const current = Number((db.prepare('SELECT COUNT(*) AS count FROM favorite_emojis WHERE user_id = ?').get(req.user!.id) as any).count);
  const exists = db.prepare('SELECT 1 FROM favorite_emojis WHERE user_id = ? AND emoji_value = ?').get(req.user!.id, value);
  if (!exists && current >= limit) return fail(res, 400, `Favorite emoji limit of ${limit} reached.`);
  db.prepare('INSERT OR IGNORE INTO favorite_emojis (user_id, emoji_value) VALUES (?, ?)').run(req.user!.id, value);
  return res.status(204).end();
});

app.delete('/api/me/emoji-favorites', requireAuth, (req: AuthenticatedRequest, res) => {
  const value = String(req.body?.value ?? '').trim().slice(0, 80);
  if (!value) return fail(res, 400, 'Invalid emoji.');
  db.prepare('DELETE FROM favorite_emojis WHERE user_id = ? AND emoji_value = ?').run(req.user!.id, value);
  return res.status(204).end();
});

app.get('/api/emojis/:emojiId/image', requireAuth, (req: AuthenticatedRequest, res) => {
  const emojiId = parseId(req.params.emojiId);
  const row = emojiId ? db.prepare('SELECT image_path FROM premium_emojis WHERE id = ?').get(emojiId) as any : null;
  if (!row?.image_path) return fail(res, 404, 'Emoji not found.');
  const file = path.join(uploadDir, path.basename(String(row.image_path)));
  return res.sendFile(file);
});

app.get('/api/users/search', requireAuth, (req: AuthenticatedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(`
    SELECT * FROM users WHERE disabled = 0 AND id <> ? AND (username LIKE ? OR display_name LIKE ?)
    ORDER BY display_name COLLATE NOCASE LIMIT 30
  `).all(req.user!.id, `%${q}%`, `%${q}%`);
  return res.json({ users: (rows as any[]).map((row) => ({ ...publicUser(row), presence: publicPresence(Number(row.id), row.presence) })) });
});

app.get('/api/users/:userId/profile', requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return fail(res, 404, 'User not found.');
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(userId) as any;
  if (!row) return fail(res, 404, 'User not found.');
  const relationship = userId === req.user!.id ? null : friendshipStatus(req.user!.id, userId);
  const mutualFriends = userId === req.user!.id ? 0 : Number((db.prepare(`
    SELECT COUNT(*) AS count FROM users u
    WHERE u.id <> ? AND EXISTS (
      SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.requester_id = ? AND f.addressee_id = u.id) OR (f.addressee_id = ? AND f.requester_id = u.id))
    ) AND EXISTS (
      SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.requester_id = ? AND f.addressee_id = u.id) OR (f.addressee_id = ? AND f.requester_id = u.id))
    )
  `).get(req.user!.id, req.user!.id, req.user!.id, userId, userId) as any).count);
  const commonServers = userId === req.user!.id ? [] : db.prepare(`
    SELECT s.id, s.name, s.icon_path FROM servers s
    JOIN server_members a ON a.server_id = s.id AND a.user_id = ?
    JOIN server_members b ON b.server_id = s.id AND b.user_id = ?
    ORDER BY s.name COLLATE NOCASE LIMIT 20
  `).all(req.user!.id, userId).map((s: any) => ({ id: Number(s.id), name: s.name, iconPath: s.icon_path ?? null }));
  return res.json({
    user: { ...publicUser(row), presence: publicPresence(userId, row.presence) },
    relationship: relationship ? { id: Number(relationship.id), status: relationship.status, incoming: Number(relationship.addressee_id) === req.user!.id } : null,
    blockedByMe: Boolean(db.prepare('SELECT 1 FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?').get(req.user!.id, userId)),
    mutualFriends,
    commonServers,
  });
});

app.put('/api/blocks/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const targetId = parseId(req.params.userId);
  if (!targetId || targetId === req.user!.id || !userById(targetId)) return fail(res, 400, 'Invalid user.');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)').run(req.user!.id, targetId);
    db.prepare('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)').run(req.user!.id, targetId, targetId, req.user!.id);
  })();
  io.to(`user:${targetId}`).emit('friends:refresh');
  io.to(`user:${req.user!.id}`).emit('friends:refresh');
  return res.status(204).end();
});

app.delete('/api/blocks/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const targetId = parseId(req.params.userId);
  if (!targetId) return fail(res, 400, 'Invalid user.');
  db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?').run(req.user!.id, targetId);
  return res.status(204).end();
});

app.get('/api/friends', requireAuth, (req: AuthenticatedRequest, res) => {
  const uid = req.user!.id;
  const decorate = (row: any) => ({ friendshipId: Number(row.friendship_id), unreadCount: Number(row.unread_count ?? 0), user: { ...publicUser(row), presence: publicPresence(Number(row.id), row.presence) } });
  const accepted = db.prepare(`
    SELECT f.id AS friendship_id, u.*,
      (SELECT COUNT(*) FROM direct_messages d
       WHERE d.sender_id = u.id AND d.recipient_id = ?
       AND d.id > COALESCE((SELECT dr.last_message_id FROM dm_reads dr WHERE dr.user_id = ? AND dr.other_user_id = u.id), 0)) AS unread_count
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted' AND u.disabled = 0
    ORDER BY u.display_name COLLATE NOCASE
  `).all(uid, uid, uid, uid, uid).map(decorate);
  const incoming = db.prepare(`SELECT f.id AS friendship_id, u.* FROM friendships f JOIN users u ON u.id = f.requester_id WHERE f.addressee_id = ? AND f.status = 'pending'`).all(uid).map(decorate);
  const outgoing = db.prepare(`SELECT f.id AS friendship_id, u.* FROM friendships f JOIN users u ON u.id = f.addressee_id WHERE f.requester_id = ? AND f.status = 'pending'`).all(uid).map(decorate);
  const blocked = db.prepare(`SELECT u.* FROM blocked_users b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?`).all(uid).map((row: any) => publicUser(row));
  return res.json({ accepted, incoming, outgoing, blocked });
});

app.post('/api/friends/request/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const targetId = parseId(req.params.userId);
  if (!targetId || targetId === req.user!.id || !userById(targetId)) return fail(res, 400, 'Invalid user.');
  if (isBlocked(req.user!.id, targetId)) return fail(res, 403, 'You cannot send a friend request to this user.');
  const existing = friendshipStatus(req.user!.id, targetId);
  if (existing) return fail(res, 409, existing.status === 'accepted' ? 'You are already friends.' : 'A pending friend request already exists.');
  db.prepare("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')").run(req.user!.id, targetId);
  io.to(`user:${targetId}`).emit('friends:refresh');
  return res.status(201).json({ ok: true });
});

app.post('/api/friends/:friendshipId/accept', requireAuth, (req: AuthenticatedRequest, res) => {
  const friendshipId = parseId(req.params.friendshipId);
  if (!friendshipId) return fail(res, 400, 'Invalid friend request.');
  const row = db.prepare("SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = 'pending'").get(friendshipId, req.user!.id) as any;
  if (!row) return fail(res, 404, 'Friend request not found.');
  if (isBlocked(Number(row.requester_id), Number(row.addressee_id))) return fail(res, 403, 'Friend request blocked.');
  db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(friendshipId);
  io.to(`user:${row.requester_id}`).emit('friends:refresh');
  io.to(`user:${row.addressee_id}`).emit('friends:refresh');
  return res.json({ ok: true });
});

app.delete('/api/friends/:friendshipId', requireAuth, (req: AuthenticatedRequest, res) => {
  const friendshipId = parseId(req.params.friendshipId);
  if (!friendshipId) return fail(res, 400, 'Invalid friendship.');
  const row = db.prepare('SELECT * FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)').get(friendshipId, req.user!.id, req.user!.id) as any;
  if (!row) return fail(res, 404, 'Record not found.');
  db.prepare('DELETE FROM friendships WHERE id = ?').run(friendshipId);
  io.to(`user:${row.requester_id}`).emit('friends:refresh');
  io.to(`user:${row.addressee_id}`).emit('friends:refresh');
  return res.status(204).end();
});

app.get('/api/servers', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db.prepare(`
    SELECT s.*, sm.nickname,
      COALESCE((SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE c.server_id = s.id
        AND m.id > COALESCE((SELECT cr.last_message_id FROM channel_reads cr WHERE cr.user_id = ? AND cr.channel_id = c.id), 0)
        AND m.author_id <> ?), 0) AS unread_count
    FROM server_members sm JOIN servers s ON s.id = sm.server_id
    WHERE sm.user_id = ? ORDER BY sm.joined_at ASC
  `).all(req.user!.id, req.user!.id, req.user!.id) as any[];
  return res.json({ servers: rows.map((r) => ({
    id: Number(r.id), name: r.name, description: r.description ?? '', iconPath: r.icon_path ?? null, bannerPath: r.banner_path ?? null,
    inviteCode: r.invite_code, ownerId: Number(r.owner_id), nickname: r.nickname ?? null, unreadCount: Number(r.unread_count ?? 0),
  })) });
});

app.post('/api/servers', requireAuth, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ name: serverNameSchema }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid server name.');
  const instanceMaxServers = Math.max(0, Number(instanceSetting('maxServersPerUser', '20')) || 0);
  const maxServers = premiumMembership(req.user!.id) ? numericPremiumBenefit(req.user!.id, 'maxServers', instanceMaxServers) : instanceMaxServers;
  const ownedServers = Number((db.prepare('SELECT COUNT(*) AS c FROM servers WHERE owner_id = ?').get(req.user!.id) as any).c);
  if (maxServers > 0 && ownedServers >= maxServers) return fail(res, 403, `Limit of ${maxServers} servers per user reached.`);
  const inviteCode = crypto.randomBytes(6).toString('base64url');
  const serverId = db.transaction(() => {
    const result = db.prepare('INSERT INTO servers (owner_id, name, invite_code) VALUES (?, ?, ?)').run(req.user!.id, parsed.data.name, inviteCode);
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, req.user!.id);
    const textCategory = Number(db.prepare("INSERT INTO channels (server_id, name, kind, position) VALUES (?, 'TEXT CHANNELS', 'CATEGORY', 0)").run(id).lastInsertRowid);
    db.prepare("INSERT INTO channels (server_id, name, kind, parent_id, position, topic) VALUES (?, 'general', 'TEXT', ?, 1, 'General discussion')").run(id, textCategory);
    const voiceCategory = Number(db.prepare("INSERT INTO channels (server_id, name, kind, position) VALUES (?, 'VOICE CHANNELS', 'CATEGORY', 2)").run(id).lastInsertRowid);
    db.prepare("INSERT INTO channels (server_id, name, kind, parent_id, position) VALUES (?, 'General', 'VOICE', ?, 3)").run(id, voiceCategory);
    ensureEveryoneRole(id);
    db.prepare('INSERT INTO server_invites (code, server_id, creator_id) VALUES (?, ?, ?)').run(inviteCode, id, req.user!.id);
    audit(id, req.user!.id, 'SERVER_CREATE', 'SERVER', id, { name: parsed.data.name });
    return id;
  })();
  return res.status(201).json({ serverId });
});

app.post('/api/servers/join', requireAuth, (req: AuthenticatedRequest, res) => {
  const code = String(req.body?.inviteCode ?? '').trim();
  const invite = db.prepare(`SELECT i.*, s.id AS sid FROM server_invites i JOIN servers s ON s.id = i.server_id WHERE i.code = ?`).get(code) as any
    ?? db.prepare('SELECT id AS server_id, id AS sid, NULL AS expires_at, NULL AS max_uses, 0 AS uses FROM servers WHERE invite_code = ?').get(code) as any;
  if (!invite) return fail(res, 404, 'Invalid invite.');
  const serverId = Number(invite.server_id ?? invite.sid);
  if (invite.expires_at && Number(invite.expires_at) <= Date.now()) return fail(res, 410, 'This invite has expired.');
  if (invite.max_uses && Number(invite.uses) >= Number(invite.max_uses)) return fail(res, 410, 'This invite has reached its usage limit.');
  if (db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(serverId, req.user!.id)) return fail(res, 403, 'You are banned from this server.');
  const inserted = db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, req.user!.id);
  if (inserted.changes && invite.code) db.prepare('UPDATE server_invites SET uses = uses + 1 WHERE code = ?').run(code);
  audit(serverId, req.user!.id, 'MEMBER_JOIN', 'USER', req.user!.id);
  emitServerRefresh(serverId);
  return res.json({ serverId });
});

app.get('/api/servers/:serverId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isMember(req.user!.id, serverId)) return fail(res, 404, 'Server not found.');
  ensureEveryoneRole(serverId);
  const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  const channels = (db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id').all(serverId) as any[])
    .filter((c) => hasChannelPermission(req.user!.id, Number(c.id), Permission.VIEW_CHANNEL))
    .map((c) => ({
      id: Number(c.id), serverId: Number(c.server_id), name: c.name, kind: c.kind, parentId: c.parent_id ? Number(c.parent_id) : null,
      position: Number(c.position), topic: c.topic ?? '', userLimit: Number(c.user_limit ?? 0), bitrate: Number(c.bitrate ?? 64000),
      permissions: getChannelPermissions(req.user!.id, Number(c.id)),
      overwrites: hasPermission(req.user!.id, serverId, Permission.MANAGE_ROLES)
        ? (db.prepare('SELECT target_type, target_id, allow_permissions, deny_permissions FROM channel_permission_overwrites WHERE channel_id = ?').all(Number(c.id)) as any[]).map((o) => ({ targetType: o.target_type, targetId: Number(o.target_id), allow: Number(o.allow_permissions), deny: Number(o.deny_permissions) }))
        : [],
    }));
  const members = (db.prepare(`
    SELECT u.*, sm.nickname, sm.joined_at, sp.display_name AS server_profile_display_name, sp.bio AS server_profile_bio, sp.avatar_path AS server_profile_avatar_path
    FROM server_members sm JOIN users u ON u.id = sm.user_id
    LEFT JOIN server_profiles sp ON sp.server_id = sm.server_id AND sp.user_id = sm.user_id
    WHERE sm.server_id = ? AND u.disabled = 0 ORDER BY u.display_name COLLATE NOCASE
  `).all(serverId) as any[]).map((m) => {
    const premium = activePremiumForUser(Number(m.id));
    const useServerProfile = Boolean(premium?.benefits.perServerProfiles);
    const user = publicUser({
      ...m,
      display_name: useServerProfile && m.server_profile_display_name ? m.server_profile_display_name : m.display_name,
      bio: useServerProfile && m.server_profile_bio != null ? m.server_profile_bio : m.bio,
      avatar_path: useServerProfile && m.server_profile_avatar_path ? m.server_profile_avatar_path : m.avatar_path,
    });
    return { ...user, presence: publicPresence(Number(m.id), m.presence), nickname: m.nickname ?? null, joinedAt: m.joined_at, roles: serverMemberRoles(serverId, Number(m.id)) };
  });
  const roles = (db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, id').all(serverId) as any[]).map((r) => ({
    id: Number(r.id), name: r.name, color: r.color, permissions: Number(r.permissions), position: Number(r.position), isEveryone: Boolean(r.is_everyone),
  }));
  return res.json({
    server: {
      id: Number(serverRow.id), name: serverRow.name, description: serverRow.description ?? '', ownerId: Number(serverRow.owner_id), inviteCode: serverRow.invite_code,
      iconPath: serverRow.icon_path ?? null, bannerPath: serverRow.banner_path ?? null,
    },
    channels, members, roles, myPermissions: getServerPermissions(req.user!.id, serverId), voiceStates: voiceStatesForServer(serverId),
  });
});

app.patch('/api/servers/:serverId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ name: serverNameSchema.optional(), description: z.string().max(240).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid configuration.');
  const current = db.prepare('SELECT name, description FROM servers WHERE id = ?').get(serverId) as any;
  db.prepare('UPDATE servers SET name = ?, description = ? WHERE id = ?').run(parsed.data.name ?? current.name, parsed.data.description ?? current.description, serverId);
  audit(serverId, req.user!.id, 'SERVER_UPDATE', 'SERVER', serverId, parsed.data);
  emitServerRefresh(serverId);
  return res.json({ ok: true });
});

app.post('/api/servers/:serverId/icon', requireAuth, imageUpload.single('icon'), (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Permission denied.'); }
  if (!req.file) return fail(res, 400, 'Invalid image.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT icon_path FROM servers WHERE id = ?').get(serverId) as any;
  db.prepare('UPDATE servers SET icon_path = ? WHERE id = ?').run(nextPath, serverId);
  if (old?.icon_path?.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(old.icon_path)), { force: true }, () => undefined);
  audit(serverId, req.user!.id, 'SERVER_ICON_UPDATE', 'SERVER', serverId);
  emitServerRefresh(serverId);
  return res.json({ iconPath: nextPath });
});

app.post('/api/servers/:serverId/banner', requireAuth, imageUpload.single('banner'), (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Permission denied.'); }
  if (!req.file) return fail(res, 400, 'Invalid image.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT banner_path FROM servers WHERE id = ?').get(serverId) as any;
  db.prepare('UPDATE servers SET banner_path = ? WHERE id = ?').run(nextPath, serverId);
  if (old?.banner_path?.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(old.banner_path)), { force: true }, () => undefined);
  audit(serverId, req.user!.id, 'SERVER_BANNER_UPDATE', 'SERVER', serverId);
  emitServerRefresh(serverId);
  return res.json({ bannerPath: nextPath });
});


app.put('/api/servers/:serverId/me-profile', requireAuth, premiumImageUpload.single('avatar'), (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isMember(req.user!.id, serverId)) { if (req.file) removeUploaded([req.file]); return fail(res, 404, 'Server not found.'); }
  if (!hasPremiumBenefit(req.user!.id, 'perServerProfiles')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Per-server profiles are not included in your plan.'); }
  const parsed = z.object({ displayName: z.string().trim().max(32).optional(), bio: z.string().max(600).optional() }).safeParse({ displayName: req.body.displayName || undefined, bio: req.body.bio ?? undefined });
  if (!parsed.success) { if (req.file) removeUploaded([req.file]); return fail(res, 400, 'Invalid server profile.'); }
  const current = db.prepare('SELECT * FROM server_profiles WHERE server_id = ? AND user_id = ?').get(serverId, req.user!.id) as any;
  const nextAvatar = req.file ? `/uploads/${req.file.filename}` : current?.avatar_path ?? null;
  db.prepare(`INSERT INTO server_profiles (server_id, user_id, display_name, bio, avatar_path, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(server_id, user_id) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio, avatar_path = excluded.avatar_path, updated_at = CURRENT_TIMESTAMP`)
    .run(serverId, req.user!.id, parsed.data.displayName ?? current?.display_name ?? null, parsed.data.bio ?? current?.bio ?? null, nextAvatar);
  if (req.file && current?.avatar_path && current.avatar_path !== nextAvatar) removeUserUpload(current.avatar_path);
  emitServerRefresh(serverId);
  return res.json({ ok: true });
});

app.post('/api/servers/:serverId/leave', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isMember(req.user!.id, serverId)) return fail(res, 404, 'Server not found.');
  if (isServerOwner(req.user!.id, serverId)) return fail(res, 409, 'Transfer ownership or delete the server before leaving.');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, req.user!.id);
  audit(serverId, req.user!.id, 'MEMBER_LEAVE', 'USER', req.user!.id);
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.delete('/api/servers/:serverId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isServerOwner(req.user!.id, serverId)) return fail(res, 403, 'Only the owner can delete the server.');
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  io.emit('server:deleted', { serverId });
  return res.status(204).end();
});

app.post('/api/servers/:serverId/transfer', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  const userId = parseId(req.body?.userId);
  if (!serverId || !userId || !isServerOwner(req.user!.id, serverId) || !isMember(userId, serverId)) return fail(res, 400, 'Invalid ownership transfer.');
  db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(userId, serverId);
  audit(serverId, req.user!.id, 'SERVER_TRANSFER', 'USER', userId);
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.get('/api/servers/:serverId/invites', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) return fail(res, 403, 'Permission denied.');
  const invites = (db.prepare('SELECT * FROM server_invites WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as any[]).map((i) => ({
    code: i.code, expiresAt: i.expires_at ? Number(i.expires_at) : null, maxUses: i.max_uses ? Number(i.max_uses) : null, uses: Number(i.uses), createdAt: i.created_at,
  }));
  return res.json({ invites });
});

app.post('/api/servers/:serverId/invites', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isMember(req.user!.id, serverId)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ expiresInMinutes: z.number().int().min(0).max(525600).optional(), maxUses: z.number().int().min(0).max(10000).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'Invalid invite configuration.');
  const code = crypto.randomBytes(7).toString('base64url');
  const expiresAt = parsed.data.expiresInMinutes ? Date.now() + parsed.data.expiresInMinutes * 60_000 : null;
  const maxUses = parsed.data.maxUses || null;
  db.prepare('INSERT INTO server_invites (code, server_id, creator_id, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)').run(code, serverId, req.user!.id, expiresAt, maxUses);
  audit(serverId, req.user!.id, 'INVITE_CREATE', 'INVITE', undefined, { code, expiresAt, maxUses });
  return res.status(201).json({ code, expiresAt, maxUses });
});

app.delete('/api/servers/:serverId/invites/:code', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) return fail(res, 403, 'Permission denied.');
  db.prepare('DELETE FROM server_invites WHERE server_id = ? AND code = ?').run(serverId, req.params.code);
  audit(serverId, req.user!.id, 'INVITE_DELETE', 'INVITE', undefined, { code: req.params.code });
  return res.status(204).end();
});

app.post('/api/servers/:serverId/channels', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_CHANNELS)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({
    name: channelNameSchema,
    kind: z.enum(['CATEGORY', 'TEXT', 'VOICE']),
    parentId: z.number().int().positive().nullable().optional(),
    topic: z.string().max(240).optional(),
    userLimit: z.number().int().min(0).max(99).optional(),
    bitrate: z.number().int().min(8000).max(384000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid channel.');
  if (parsed.data.parentId) {
    const parent = db.prepare("SELECT 1 FROM channels WHERE id = ? AND server_id = ? AND kind = 'CATEGORY'").get(parsed.data.parentId, serverId);
    if (!parent) return fail(res, 400, 'Invalid category.');
  }
  const position = Number((db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM channels WHERE server_id = ?').get(serverId) as any).max) + 1;
  const result = db.prepare('INSERT INTO channels (server_id, name, kind, parent_id, position, topic, user_limit, bitrate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    serverId, parsed.data.name, parsed.data.kind, parsed.data.kind === 'CATEGORY' ? null : (parsed.data.parentId ?? null), position,
    parsed.data.topic ?? '', parsed.data.userLimit ?? 0, parsed.data.bitrate ?? 64000,
  );
  const channelId = Number(result.lastInsertRowid);
  audit(serverId, req.user!.id, 'CHANNEL_CREATE', 'CHANNEL', channelId, { name: parsed.data.name, kind: parsed.data.kind });
  emitServerRefresh(serverId);
  return res.status(201).json({ channelId });
});

app.patch('/api/channels/:channelId', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  const row = channelId ? db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any : null;
  if (!row || !hasPermission(req.user!.id, Number(row.server_id), Permission.MANAGE_CHANNELS)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({
    name: channelNameSchema.optional(), parentId: z.number().int().positive().nullable().optional(), topic: z.string().max(240).optional(),
    userLimit: z.number().int().min(0).max(99).optional(), bitrate: z.number().int().min(8000).max(384000).optional(), position: z.number().int().min(0).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid channel.');
  if (parsed.data.parentId) {
    const parent = db.prepare("SELECT 1 FROM channels WHERE id = ? AND server_id = ? AND kind = 'CATEGORY'").get(parsed.data.parentId, row.server_id);
    if (!parent || Number(parsed.data.parentId) === channelId) return fail(res, 400, 'Invalid category.');
  }
  db.prepare('UPDATE channels SET name = ?, parent_id = ?, topic = ?, user_limit = ?, bitrate = ?, position = ? WHERE id = ?').run(
    parsed.data.name ?? row.name,
    row.kind === 'CATEGORY' ? null : (parsed.data.parentId !== undefined ? parsed.data.parentId : row.parent_id),
    parsed.data.topic ?? row.topic,
    parsed.data.userLimit ?? row.user_limit,
    parsed.data.bitrate ?? row.bitrate,
    parsed.data.position ?? row.position ?? 0,
    channelId,
  );
  audit(Number(row.server_id), req.user!.id, 'CHANNEL_UPDATE', 'CHANNEL', channelId ?? undefined, parsed.data);
  emitServerRefresh(Number(row.server_id));
  return res.status(204).end();
});

app.post('/api/servers/:serverId/channels/reorder', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_CHANNELS)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ items: z.array(z.object({ id: z.number().int().positive(), position: z.number().int().min(0), parentId: z.number().int().positive().nullable().optional() })).max(300) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid ordering.');
  const update = db.prepare('UPDATE channels SET position = ?, parent_id = CASE WHEN kind = \'CATEGORY\' THEN NULL ELSE ? END WHERE id = ? AND server_id = ?');
  db.transaction(() => { for (const item of parsed.data.items) update.run(item.position, item.parentId ?? null, item.id, serverId); })();
  audit(serverId, req.user!.id, 'CHANNEL_REORDER');
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.delete('/api/channels/:channelId', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  const row = channelId ? serverForChannel(channelId) : null;
  if (!row || !hasPermission(req.user!.id, Number(row.server_id), Permission.MANAGE_CHANNELS)) return fail(res, 403, 'Permission denied.');
  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  audit(Number(row.server_id), req.user!.id, 'CHANNEL_DELETE', 'CHANNEL', channelId!);
  emitServerRefresh(Number(row.server_id));
  return res.status(204).end();
});

app.put('/api/channels/:channelId/permissions', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  const row = channelId ? serverForChannel(channelId) : null;
  if (!row || !hasPermission(req.user!.id, Number(row.server_id), Permission.MANAGE_ROLES)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ targetType: z.enum(['ROLE', 'MEMBER']), targetId: z.number().int().positive(), allow: z.number().int().min(0).max(ALL_PERMISSIONS), deny: z.number().int().min(0).max(ALL_PERMISSIONS) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid permissions.');
  db.prepare(`INSERT INTO channel_permission_overwrites (channel_id, target_type, target_id, allow_permissions, deny_permissions)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow_permissions = excluded.allow_permissions, deny_permissions = excluded.deny_permissions`)
    .run(channelId, parsed.data.targetType, parsed.data.targetId, parsed.data.allow, parsed.data.deny);
  audit(Number(row.server_id), req.user!.id, 'CHANNEL_PERMISSIONS_UPDATE', 'CHANNEL', channelId!, parsed.data);
  emitServerRefresh(Number(row.server_id));
  return res.status(204).end();
});

app.get('/api/channels/:channelId/messages', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  if (!channelId || !canAccessChannel(req.user!.id, channelId)) return fail(res, 403, 'You do not have access to this channel.');
  const before = parseId(req.query.before);
  const limit = Math.min(100, Math.max(20, Number(req.query.limit ?? 50)));
  const rows = (before
    ? db.prepare(`SELECT m.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at FROM messages m JOIN users u ON u.id = m.author_id WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(channelId, before, limit)
    : db.prepare(`SELECT m.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at FROM messages m JOIN users u ON u.id = m.author_id WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`).all(channelId, limit)) as any[];
  const messages = rows.reverse().map((row) => messageRowToJson(row, req.user!.id));
  return res.json({ messages, hasMore: rows.length === limit });
});

app.get('/api/channels/:channelId/messages/search', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  const q = String(req.query.q ?? '').trim();
  if (!channelId || !canAccessChannel(req.user!.id, channelId)) return fail(res, 403, 'You do not have access to this channel.');
  if (q.length < 2) return res.json({ messages: [] });
  const rows = db.prepare(`SELECT m.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
    FROM messages m JOIN users u ON u.id = m.author_id WHERE m.channel_id = ? AND m.content LIKE ? ORDER BY m.id DESC LIMIT 50`).all(channelId, `%${q}%`) as any[];
  return res.json({ messages: rows.map((row) => messageRowToJson(row, req.user!.id)) });
});

app.get('/api/channels/:channelId/pins', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  if (!channelId || !canAccessChannel(req.user!.id, channelId)) return fail(res, 403, 'You do not have access to this channel.');
  const rows = db.prepare(`SELECT m.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
    FROM messages m JOIN users u ON u.id = m.author_id WHERE m.channel_id = ? AND m.pinned = 1 ORDER BY m.id DESC LIMIT 100`).all(channelId) as any[];
  return res.json({ messages: rows.map((row) => messageRowToJson(row, req.user!.id)) });
});

app.post('/api/channels/:channelId/messages', requireAuth, attachmentUpload.array('files', 10), (req: AuthenticatedRequest, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const instanceUploadMb = Math.max(1, Math.min(50, Number(instanceSetting('maxUploadMb', '15')) || 15));
  const maxUploadMb = premiumMembership(req.user!.id) ? Math.max(instanceUploadMb, numericPremiumBenefit(req.user!.id, 'maxUploadMb', instanceUploadMb)) : instanceUploadMb;
  const maxFiles = premiumMembership(req.user!.id) ? Math.max(5, numericPremiumBenefit(req.user!.id, 'maxFilesPerMessage', 5)) : 5;
  if (files.length > maxFiles) { removeUploaded(files); return fail(res, 413, `Your limit is ${maxFiles} files per message.`); }
  const maxUploadBytes = maxUploadMb * 1024 * 1024;
  if (files.some((file) => file.size > maxUploadBytes)) { removeUploaded(files); return fail(res, 413, `Your per-file limit is ${Math.round(maxUploadBytes / 1024 / 1024)} MB.`); }
  const channelId = parseId(req.params.channelId);
  if (!channelId || !canAccessChannel(req.user!.id, channelId) || !hasChannelPermission(req.user!.id, channelId, Permission.SEND_MESSAGES)) { removeUploaded(files); return fail(res, 403, 'You do not have permission to send messages.'); }
  const content = String(req.body?.content ?? '').trim();
  if (!content && files.length === 0) return fail(res, 400, 'Message cannot be empty.');
  if (content.length > 4000) { removeUploaded(files); return fail(res, 400, 'Message is too long.'); }
  const emojiError = validateCustomEmojiContent(req.user!.id, content);
  if (emojiError) { removeUploaded(files); return fail(res, 403, emojiError); }
  const replyToId = req.body?.replyToId ? parseId(req.body.replyToId) : null;
  if (replyToId) {
    const reply = db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(replyToId, channelId);
    if (!reply) { removeUploaded(files); return fail(res, 400, 'Invalid replied message.'); }
  }
  const messageId = db.transaction(() => {
    const result = db.prepare('INSERT INTO messages (channel_id, author_id, content, reply_to_id) VALUES (?, ?, ?, ?)').run(channelId, req.user!.id, content, replyToId);
    const id = Number(result.lastInsertRowid);
    const insertAttachment = db.prepare('INSERT INTO message_attachments (message_id, path, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)');
    for (const file of files) insertAttachment.run(id, `/uploads/${file.filename}`, path.basename(file.originalname).slice(0, 160), file.mimetype, file.size);
    return id;
  })();
  const message = getMessage(messageId, req.user!.id)!;
  io.to(`channel:${channelId}`).emit('message:new', message);
  const serverId = Number(serverForChannel(channelId)!.server_id);
  io.to(`notify-server:${serverId}`).emit('server:unread', { serverId, channelId, authorId: req.user!.id });
  const recipients = db.prepare(`SELECT u.id, u.username, COALESCE(n.level, 'MENTIONS') AS level, COALESCE(n.muted, 0) AS muted
    FROM server_members sm JOIN users u ON u.id = sm.user_id
    LEFT JOIN notification_settings n ON n.user_id = u.id AND n.server_id = sm.server_id
    WHERE sm.server_id = ? AND u.id <> ? AND u.disabled = 0`).all(serverId, req.user!.id) as any[];
  for (const recipient of recipients) {
    if (recipient.muted || recipient.level === 'NONE') continue;
    const mentioned = content.includes(`@${recipient.username}`) || content.includes('@everyone');
    if (recipient.level === 'MENTIONS' && !mentioned) continue;
    io.to(`user:${recipient.id}`).emit('server:notification', { serverId, channelId, author: message.author, content: content || 'Sent a file', mentioned });
  }
  return res.status(201).json({ message });
});

app.patch('/api/messages/:messageId', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const parsed = z.object({ content: messageSchema }).safeParse(req.body);
  if (!messageId || !parsed.success) return fail(res, 400, 'Invalid message.');
  const emojiError = validateCustomEmojiContent(req.user!.id, parsed.data.content);
  if (emojiError) return fail(res, 403, emojiError);
  const row = db.prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?').get(messageId, req.user!.id) as any;
  if (!row) return fail(res, 404, 'Message not found.');
  db.prepare('UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(parsed.data.content, messageId);
  io.to(`channel:${row.channel_id}`).emit('message:edited', getMessage(messageId, req.user!.id));
  return res.json({ message: getMessage(messageId, req.user!.id) });
});

app.delete('/api/messages/:messageId', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  if (!messageId) return fail(res, 400, 'Invalid message.');
  const row = db.prepare(`SELECT m.*, c.server_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?`).get(messageId) as any;
  if (!row) return fail(res, 404, 'Message not found.');
  const allowed = Number(row.author_id) === req.user!.id || hasPermission(req.user!.id, Number(row.server_id), Permission.MANAGE_MESSAGES);
  if (!allowed) return fail(res, 403, 'Permission denied.');
  const attachments = db.prepare('SELECT path FROM message_attachments WHERE message_id = ?').all(messageId) as Array<{ path: string }>;
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  for (const attachment of attachments) if (attachment.path.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(attachment.path)), { force: true }, () => undefined);
  audit(Number(row.server_id), req.user!.id, 'MESSAGE_DELETE', 'MESSAGE', messageId, { authorId: Number(row.author_id) });
  io.to(`channel:${row.channel_id}`).emit('message:deleted', { id: messageId, channelId: Number(row.channel_id) });
  return res.status(204).end();
});

app.put('/api/messages/:messageId/pin', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const row = messageId ? db.prepare('SELECT m.channel_id, c.server_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?').get(messageId) as any : null;
  if (!row || !hasPermission(req.user!.id, Number(row.server_id), Permission.MANAGE_MESSAGES)) return fail(res, 403, 'Permission denied.');
  db.prepare('UPDATE messages SET pinned = 1 WHERE id = ?').run(messageId);
  audit(Number(row.server_id), req.user!.id, 'MESSAGE_PIN', 'MESSAGE', messageId!);
  io.to(`channel:${row.channel_id}`).emit('message:edited', getMessage(messageId!, req.user!.id));
  return res.status(204).end();
});

app.delete('/api/messages/:messageId/pin', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const row = messageId ? db.prepare('SELECT m.channel_id, c.server_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?').get(messageId) as any : null;
  if (!row || !hasPermission(req.user!.id, Number(row.server_id), Permission.MANAGE_MESSAGES)) return fail(res, 403, 'Permission denied.');
  db.prepare('UPDATE messages SET pinned = 0 WHERE id = ?').run(messageId);
  audit(Number(row.server_id), req.user!.id, 'MESSAGE_UNPIN', 'MESSAGE', messageId!);
  io.to(`channel:${row.channel_id}`).emit('message:edited', getMessage(messageId!, req.user!.id));
  return res.status(204).end();
});

app.put('/api/messages/:messageId/reactions/:emoji', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const emoji = String(req.params.emoji ?? '').slice(0, 80);
  const row = messageId ? db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId) as any : null;
  if (!row || !canAccessChannel(req.user!.id, Number(row.channel_id)) || !emoji) return fail(res, 400, 'Invalid reaction.');
  const custom = /^<:([a-z0-9_]{2,32}):(\d+)>$/i.exec(emoji);
  if (custom) {
    const customRow = db.prepare('SELECT id, user_id, name FROM premium_emojis WHERE id = ?').get(Number(custom[2])) as any;
    if (!customRow || String(customRow.name).toLowerCase() !== custom[1].toLowerCase()) return fail(res, 400, 'Invalid custom emoji.');
    if (Number(customRow.user_id) !== req.user!.id && !hasPremiumBenefit(req.user!.id, 'externalReactions')) return fail(res, 403, 'Custom emoji reactions are not included in your plan.');
  }
  db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, req.user!.id, emoji);
  io.to(`channel:${row.channel_id}`).emit('message:reaction', { messageId, channelId: Number(row.channel_id), reactions: messageReactions(messageId!, req.user!.id) });
  return res.status(204).end();
});

app.delete('/api/messages/:messageId/reactions/:emoji', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const emoji = String(req.params.emoji ?? '').slice(0, 80);
  const row = messageId ? db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId) as any : null;
  if (!row) return fail(res, 404, 'Message not found.');
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, req.user!.id, emoji);
  io.to(`channel:${row.channel_id}`).emit('message:reaction', { messageId, channelId: Number(row.channel_id), reactions: messageReactions(messageId!, req.user!.id) });
  return res.status(204).end();
});

app.post('/api/channels/:channelId/read', requireAuth, (req: AuthenticatedRequest, res) => {
  const channelId = parseId(req.params.channelId);
  if (!channelId || !canAccessChannel(req.user!.id, channelId)) return fail(res, 403, 'Access denied.');
  const last = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?').get(channelId) as any;
  db.prepare(`INSERT INTO channel_reads (user_id, channel_id, last_message_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id`).run(req.user!.id, channelId, Number(last.id));
  return res.status(204).end();
});

app.get('/api/dms/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const otherId = parseId(req.params.userId);
  if (!otherId || !userById(otherId)) return fail(res, 404, 'User not found.');
  const friendship = friendshipStatus(req.user!.id, otherId);
  if (!friendship || friendship.status !== 'accepted' || isBlocked(req.user!.id, otherId)) return fail(res, 403, 'Direct messages are available only between unblocked friends.');
  const before = parseId(req.query.before);
  const rows = (before ? db.prepare(`
    SELECT dm.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
    FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
    WHERE (((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)) AND dm.id < ?)
    ORDER BY dm.id DESC LIMIT 80
  `).all(req.user!.id, otherId, otherId, req.user!.id, before) : db.prepare(`
    SELECT dm.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
    FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
    WHERE (dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)
    ORDER BY dm.id DESC LIMIT 80
  `).all(req.user!.id, otherId, otherId, req.user!.id)) as any[];
  return res.json({ messages: rows.reverse().map((m) => ({
    id: Number(m.id), sender: publicUser({ ...m, id: m.sender_id, created_at: m.user_created_at }), recipientId: Number(m.recipient_id), content: m.content,
    createdAt: m.created_at, editedAt: m.edited_at ?? null, replyToId: m.reply_to_id ? Number(m.reply_to_id) : null,
  })), user: userById(otherId), hasMore: rows.length === 80 });
});

app.post('/api/dms/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const otherId = parseId(req.params.userId);
  const parsed = z.object({ content: messageSchema, replyToId: z.number().int().positive().nullable().optional() }).safeParse(req.body);
  if (!otherId || !parsed.success) return fail(res, 400, 'Invalid message.');
  const emojiError = validateCustomEmojiContent(req.user!.id, parsed.data.content);
  if (emojiError) return fail(res, 403, emojiError);
  const friendship = friendshipStatus(req.user!.id, otherId);
  if (!friendship || friendship.status !== 'accepted' || isBlocked(req.user!.id, otherId)) return fail(res, 403, 'Direct message unavailable.');
  const result = db.prepare('INSERT INTO direct_messages (sender_id, recipient_id, content, reply_to_id) VALUES (?, ?, ?, ?)').run(req.user!.id, otherId, parsed.data.content, parsed.data.replyToId ?? null);
  const message = { id: Number(result.lastInsertRowid), sender: req.user, recipientId: otherId, content: parsed.data.content, createdAt: new Date().toISOString(), editedAt: null, replyToId: parsed.data.replyToId ?? null };
  io.to(`user:${otherId}`).emit('dm:new', message);
  io.to(`user:${req.user!.id}`).emit('dm:new', message);
  return res.status(201).json({ message });
});

app.patch('/api/dms/messages/:messageId', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const parsed = z.object({ content: messageSchema }).safeParse(req.body);
  if (!messageId || !parsed.success) return fail(res, 400, 'Invalid message.');
  const emojiError = validateCustomEmojiContent(req.user!.id, parsed.data.content);
  if (emojiError) return fail(res, 403, emojiError);
  const row = db.prepare('SELECT * FROM direct_messages WHERE id = ? AND sender_id = ?').get(messageId, req.user!.id) as any;
  if (!row) return fail(res, 404, 'Message not found.');
  db.prepare('UPDATE direct_messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(parsed.data.content, messageId);
  const payload = { id: messageId, content: parsed.data.content, editedAt: new Date().toISOString(), senderId: req.user!.id, recipientId: Number(row.recipient_id) };
  io.to(`user:${row.recipient_id}`).emit('dm:edited', payload);
  io.to(`user:${req.user!.id}`).emit('dm:edited', payload);
  return res.status(204).end();
});

app.delete('/api/dms/messages/:messageId', requireAuth, (req: AuthenticatedRequest, res) => {
  const messageId = parseId(req.params.messageId);
  const row = messageId ? db.prepare('SELECT * FROM direct_messages WHERE id = ? AND sender_id = ?').get(messageId, req.user!.id) as any : null;
  if (!row) return fail(res, 404, 'Message not found.');
  db.prepare('DELETE FROM direct_messages WHERE id = ?').run(messageId);
  const payload = { id: messageId, senderId: req.user!.id, recipientId: Number(row.recipient_id) };
  io.to(`user:${row.recipient_id}`).emit('dm:deleted', payload);
  io.to(`user:${req.user!.id}`).emit('dm:deleted', payload);
  return res.status(204).end();
});

app.post('/api/dms/:userId/read', requireAuth, (req: AuthenticatedRequest, res) => {
  const otherId = parseId(req.params.userId);
  if (!otherId) return fail(res, 400, 'Invalid user.');
  const last = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM direct_messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`).get(req.user!.id, otherId, otherId, req.user!.id) as any;
  db.prepare(`INSERT INTO dm_reads (user_id, other_user_id, last_message_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, other_user_id) DO UPDATE SET last_message_id = excluded.last_message_id`).run(req.user!.id, otherId, Number(last.id));
  return res.status(204).end();
});

app.get('/api/dm-groups', requireAuth, (req: AuthenticatedRequest, res) => {
  const groups = (db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM dm_thread_members x WHERE x.thread_id = t.id) AS member_count
    FROM dm_threads t JOIN dm_thread_members m ON m.thread_id = t.id WHERE m.user_id = ? ORDER BY t.id DESC`).all(req.user!.id) as any[]).map((t) => ({
    id: Number(t.id), name: t.name, iconPath: t.icon_path ?? null, ownerId: Number(t.owner_id), memberCount: Number(t.member_count),
  }));
  return res.json({ groups });
});

app.post('/api/dm-groups', requireAuth, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(48), memberIds: z.array(z.number().int().positive()).min(1).max(9) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid group.');
  const maxGroups = premiumMembership(req.user!.id) ? numericPremiumBenefit(req.user!.id, 'maxDmGroups', 20) : 20;
  const ownedGroups = Number((db.prepare('SELECT COUNT(*) AS c FROM dm_threads WHERE owner_id = ?').get(req.user!.id) as any).c);
  if (maxGroups > 0 && ownedGroups >= maxGroups) return fail(res, 403, `Limit of ${maxGroups} DM groups reached.`);
  const unique: number[] = [...new Set<number>(parsed.data.memberIds as number[])].filter((id) => id !== req.user!.id);
  for (const id of unique) {
    const friendship = friendshipStatus(req.user!.id, id);
    if (!friendship || friendship.status !== 'accepted' || isBlocked(req.user!.id, id)) return fail(res, 403, 'All members must be your friends.');
  }
  const threadId = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO dm_threads (owner_id, name) VALUES (?, ?)').run(req.user!.id, parsed.data.name).lastInsertRowid);
    const insert = db.prepare('INSERT INTO dm_thread_members (thread_id, user_id) VALUES (?, ?)');
    insert.run(id, req.user!.id);
    for (const userId of unique) insert.run(id, userId);
    return id;
  })();
  for (const id of unique) io.to(`user:${id}`).emit('dm-groups:refresh');
  return res.status(201).json({ threadId });
});

app.get('/api/dm-groups/:threadId', requireAuth, (req: AuthenticatedRequest, res) => {
  const threadId = parseId(req.params.threadId);
  if (!threadId || !db.prepare('SELECT 1 FROM dm_thread_members WHERE thread_id = ? AND user_id = ?').get(threadId, req.user!.id)) return fail(res, 404, 'Group not found.');
  const thread = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(threadId) as any;
  const members = (db.prepare('SELECT u.* FROM dm_thread_members m JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? ORDER BY u.display_name').all(threadId) as any[]).map((u) => publicUser(u));
  const messages = (db.prepare(`SELECT m.*, u.username, u.display_name, u.bio, u.status_text, u.avatar_path, u.banner_path, u.presence, u.created_at AS user_created_at
    FROM dm_thread_messages m JOIN users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.id DESC LIMIT 100`).all(threadId) as any[]).reverse().map((m) => ({
      id: Number(m.id), threadId, author: publicUser({ ...m, id: m.author_id, created_at: m.user_created_at }), content: m.content, createdAt: m.created_at, editedAt: m.edited_at ?? null,
    }));
  return res.json({ group: { id: threadId, name: thread.name, iconPath: thread.icon_path ?? null, ownerId: Number(thread.owner_id), members }, messages });
});

app.post('/api/dm-groups/:threadId/messages', requireAuth, (req: AuthenticatedRequest, res) => {
  const threadId = parseId(req.params.threadId);
  const parsed = z.object({ content: messageSchema }).safeParse(req.body);
  if (!threadId || !parsed.success || !db.prepare('SELECT 1 FROM dm_thread_members WHERE thread_id = ? AND user_id = ?').get(threadId, req.user!.id)) return fail(res, 403, 'Invalid group.');
  const emojiError = validateCustomEmojiContent(req.user!.id, parsed.data.content);
  if (emojiError) return fail(res, 403, emojiError);
  const id = Number(db.prepare('INSERT INTO dm_thread_messages (thread_id, author_id, content) VALUES (?, ?, ?)').run(threadId, req.user!.id, parsed.data.content).lastInsertRowid);
  const message = { id, threadId, author: req.user, content: parsed.data.content, createdAt: new Date().toISOString(), editedAt: null };
  const members = db.prepare('SELECT user_id FROM dm_thread_members WHERE thread_id = ?').all(threadId) as Array<{ user_id: number }>;
  for (const member of members) io.to(`user:${member.user_id}`).emit('dm-group:new', message);
  return res.status(201).json({ message });
});

app.post('/api/servers/:serverId/roles', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_ROLES)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ name: z.string().trim().min(1).max(32), color: hexColorSchema, permissions: z.number().int().min(0).max(ALL_PERMISSIONS).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid role.');
  const max = Number((db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM roles WHERE server_id = ?').get(serverId) as any).p);
  const result = db.prepare('INSERT INTO roles (server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?)').run(serverId, parsed.data.name, parsed.data.color, parsed.data.permissions ?? 0, max + 1);
  audit(serverId, req.user!.id, 'ROLE_CREATE', 'ROLE', Number(result.lastInsertRowid), parsed.data);
  emitServerRefresh(serverId);
  return res.status(201).json({ roleId: Number(result.lastInsertRowid) });
});

app.patch('/api/roles/:roleId', requireAuth, (req: AuthenticatedRequest, res) => {
  const roleId = parseId(req.params.roleId);
  const role = roleId ? db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as any : null;
  if (!role || !hasPermission(req.user!.id, Number(role.server_id), Permission.MANAGE_ROLES)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ name: z.string().trim().min(1).max(32).optional(), color: hexColorSchema.optional(), permissions: z.number().int().min(0).max(ALL_PERMISSIONS).optional(), position: z.number().int().min(-1).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid role.');
  if (role.is_everyone && parsed.data.name && parsed.data.name !== '@everyone') return fail(res, 400, 'The @everyone role cannot be renamed.');
  db.prepare('UPDATE roles SET name = ?, color = ?, permissions = ?, position = ? WHERE id = ?').run(parsed.data.name ?? role.name, parsed.data.color ?? role.color, parsed.data.permissions ?? role.permissions, parsed.data.position ?? role.position, roleId);
  audit(Number(role.server_id), req.user!.id, 'ROLE_UPDATE', 'ROLE', roleId!, parsed.data);
  emitServerRefresh(Number(role.server_id));
  return res.status(204).end();
});

app.delete('/api/roles/:roleId', requireAuth, (req: AuthenticatedRequest, res) => {
  const roleId = parseId(req.params.roleId);
  const role = roleId ? db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as any : null;
  if (!role || role.is_everyone || !hasPermission(req.user!.id, Number(role.server_id), Permission.MANAGE_ROLES)) return fail(res, 403, 'This role cannot be removed.');
  db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
  audit(Number(role.server_id), req.user!.id, 'ROLE_DELETE', 'ROLE', roleId!);
  emitServerRefresh(Number(role.server_id));
  return res.status(204).end();
});

app.post('/api/servers/:serverId/roles/reorder', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_ROLES)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ ids: z.array(z.number().int().positive()).max(200) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid ordering.');
  const update = db.prepare('UPDATE roles SET position = ? WHERE id = ? AND server_id = ? AND is_everyone = 0');
  db.transaction(() => parsed.data.ids.forEach((id, index) => update.run(parsed.data.ids.length - index, id, serverId)))();
  audit(serverId, req.user!.id, 'ROLE_REORDER');
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.put('/api/servers/:serverId/members/:userId/roles/:roleId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId), roleId = parseId(req.params.roleId);
  if (!serverId || !userId || !roleId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_ROLES)) return fail(res, 403, 'Permission denied.');
  const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ? AND is_everyone = 0').get(roleId, serverId) as any;
  if (!role || !isMember(userId, serverId)) return fail(res, 404, 'Invalid role or member.');
  db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, userId, roleId);
  audit(serverId, req.user!.id, 'MEMBER_ROLE_ADD', 'USER', userId, { roleId });
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.delete('/api/servers/:serverId/members/:userId/roles/:roleId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId), roleId = parseId(req.params.roleId);
  if (!serverId || !userId || !roleId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_ROLES)) return fail(res, 403, 'Permission denied.');
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(serverId, userId, roleId);
  audit(serverId, req.user!.id, 'MEMBER_ROLE_REMOVE', 'USER', userId, { roleId });
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.patch('/api/servers/:serverId/members/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId);
  if (!serverId || !userId || (!hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER) && req.user!.id !== userId)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ nickname: z.string().trim().max(32).nullable() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid nickname.');
  db.prepare('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?').run(parsed.data.nickname || null, serverId, userId);
  audit(serverId, req.user!.id, 'MEMBER_NICKNAME_UPDATE', 'USER', userId, { nickname: parsed.data.nickname });
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.post('/api/servers/:serverId/members/:userId/kick', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId);
  if (!serverId || !userId || !hasPermission(req.user!.id, serverId, Permission.KICK_MEMBERS) || isServerOwner(userId, serverId)) return fail(res, 403, 'Permission denied.');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  audit(serverId, req.user!.id, 'MEMBER_KICK', 'USER', userId, { reason: String(req.body?.reason ?? '').slice(0, 240) });
  io.to(`user:${userId}`).emit('server:kicked', { serverId });
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.post('/api/servers/:serverId/members/:userId/ban', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId);
  if (!serverId || !userId || !hasPermission(req.user!.id, serverId, Permission.BAN_MEMBERS) || isServerOwner(userId, serverId)) return fail(res, 403, 'Permission denied.');
  const reason = String(req.body?.reason ?? '').slice(0, 240);
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO server_bans (server_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?)').run(serverId, userId, req.user!.id, reason);
    db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  })();
  audit(serverId, req.user!.id, 'MEMBER_BAN', 'USER', userId, { reason });
  io.to(`user:${userId}`).emit('server:banned', { serverId });
  emitServerRefresh(serverId);
  return res.status(204).end();
});

app.get('/api/servers/:serverId/bans', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.BAN_MEMBERS)) return fail(res, 403, 'Permission denied.');
  const bans = (db.prepare(`SELECT b.*, u.username, u.display_name, u.avatar_path FROM server_bans b JOIN users u ON u.id = b.user_id WHERE b.server_id = ? ORDER BY b.created_at DESC`).all(serverId) as any[]).map((b) => ({
    userId: Number(b.user_id), username: b.username, displayName: b.display_name, avatarPath: b.avatar_path ?? null, reason: b.reason, createdAt: b.created_at,
  }));
  return res.json({ bans });
});

app.delete('/api/servers/:serverId/bans/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId);
  if (!serverId || !userId || !hasPermission(req.user!.id, serverId, Permission.BAN_MEMBERS)) return fail(res, 403, 'Permission denied.');
  db.prepare('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  audit(serverId, req.user!.id, 'MEMBER_UNBAN', 'USER', userId);
  return res.status(204).end();
});

app.get('/api/servers/:serverId/audit', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) return fail(res, 403, 'Permission denied.');
  const logs = (db.prepare(`SELECT a.*, u.username, u.display_name, u.avatar_path FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.server_id = ? ORDER BY a.id DESC LIMIT 200`).all(serverId) as any[]).map((a) => ({
    id: Number(a.id), actor: a.actor_id ? { id: Number(a.actor_id), username: a.username, displayName: a.display_name, avatarPath: a.avatar_path ?? null } : null,
    action: a.action, targetType: a.target_type, targetId: a.target_id ? Number(a.target_id) : null, details: safeJson(a.details), createdAt: a.created_at,
  }));
  return res.json({ logs });
});

app.get('/api/servers/:serverId/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isMember(req.user!.id, serverId)) return fail(res, 403, 'Access denied.');
  const row = db.prepare('SELECT level, muted FROM notification_settings WHERE user_id = ? AND server_id = ?').get(req.user!.id, serverId) as any;
  return res.json({ level: row?.level ?? 'MENTIONS', muted: Boolean(row?.muted) });
});

app.put('/api/servers/:serverId/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isMember(req.user!.id, serverId)) return fail(res, 403, 'Access denied.');
  const parsed = z.object({ level: z.enum(['ALL', 'MENTIONS', 'NONE']), muted: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid preference.');
  db.prepare(`INSERT INTO notification_settings (user_id, server_id, level, muted) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, server_id) DO UPDATE SET level = excluded.level, muted = excluded.muted`).run(req.user!.id, serverId, parsed.data.level, parsed.data.muted ? 1 : 0);
  return res.status(204).end();
});

app.post('/api/servers/:serverId/voice/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId), userId = parseId(req.params.userId);
  if (!serverId || !userId || !hasPermission(req.user!.id, serverId, Permission.MANAGE_SERVER)) return fail(res, 403, 'Permission denied.');
  const parsed = z.object({ action: z.enum(['disconnect', 'mute', 'unmute', 'deafen', 'undeafen', 'move']), channelId: z.number().int().positive().optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid action.');
  const targets = [...voiceStates.values()].filter((state) => state.serverId === serverId && state.userId === userId);
  for (const state of targets) {
    const socket = io.sockets.sockets.get(state.socketId);
    if (!socket) continue;
    if (parsed.data.action === 'disconnect') {
      socket.emit('voice:forced-disconnect');
      leaveVoiceSocket(socket);
    } else if (parsed.data.action === 'move' && parsed.data.channelId) {
      const target = db.prepare("SELECT id FROM channels WHERE id = ? AND server_id = ? AND kind = 'VOICE'").get(parsed.data.channelId, serverId);
      if (!target) return fail(res, 400, 'Invalid destination channel.');
      socket.emit('voice:forced-move', { channelId: parsed.data.channelId });
      leaveVoiceSocket(socket);
    } else {
      if (parsed.data.action === 'mute') state.serverMuted = true;
      if (parsed.data.action === 'unmute') state.serverMuted = false;
      if (parsed.data.action === 'deafen') state.serverDeafened = true;
      if (parsed.data.action === 'undeafen') state.serverDeafened = false;
      socket.emit('voice:moderation', { serverMuted: state.serverMuted, serverDeafened: state.serverDeafened });
    }
  }
  audit(serverId, req.user!.id, `VOICE_${parsed.data.action.toUpperCase()}`, 'USER', userId, { channelId: parsed.data.channelId });
  emitVoiceState(serverId);
  return res.status(204).end();
});

app.get('/api/servers/:serverId/export', requireAuth, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  if (!serverId || !isServerOwner(req.user!.id, serverId)) return fail(res, 403, 'Only the owner can export this server.');
  const serverRow = db.prepare('SELECT id, name, description FROM servers WHERE id = ?').get(serverId) as any;
  const channels = db.prepare('SELECT name, kind, parent_id, position, topic, user_limit, bitrate, id FROM channels WHERE server_id = ? ORDER BY position').all(serverId) as any[];
  const roles = db.prepare('SELECT name, color, permissions, position, is_everyone FROM roles WHERE server_id = ? ORDER BY position').all(serverId) as any[];
  const messages = db.prepare(`SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at, m.pinned, u.username AS author_username FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.author_id WHERE c.server_id = ? ORDER BY m.id`).all(serverId);
  res.setHeader('Content-Disposition', `attachment; filename="opencord-server-${serverId}.json"`);
  return res.json({ format: 'opencord-server-export-v1', exportedAt: new Date().toISOString(), server: serverRow, channels, roles, messages });
});

app.post('/api/servers/import', requireAuth, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ format: z.literal('opencord-server-export-v1'), server: z.object({ name: z.string().min(1).max(60), description: z.string().max(240).optional() }), channels: z.array(z.any()).max(500), roles: z.array(z.any()).max(200) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid export file.');
  const inviteCode = crypto.randomBytes(6).toString('base64url');
  const serverId = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO servers (owner_id, name, description, invite_code) VALUES (?, ?, ?, ?)').run(req.user!.id, parsed.data.server.name, parsed.data.server.description ?? '', inviteCode).lastInsertRowid);
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, req.user!.id);
    const idMap = new Map<number, number>();
    for (const item of [...parsed.data.channels].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))) {
      const kind = ['CATEGORY', 'TEXT', 'VOICE'].includes(item.kind) ? item.kind : 'TEXT';
      const newId = Number(db.prepare('INSERT INTO channels (server_id, name, kind, parent_id, position, topic, user_limit, bitrate) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(id, String(item.name ?? 'channel').slice(0, 48), kind, Number(item.position ?? 0), String(item.topic ?? '').slice(0, 240), Number(item.user_limit ?? 0), Number(item.bitrate ?? 64000)).lastInsertRowid);
      idMap.set(Number(item.id), newId);
    }
    for (const item of parsed.data.channels) if (item.parent_id && idMap.has(Number(item.id)) && idMap.has(Number(item.parent_id))) db.prepare('UPDATE channels SET parent_id = ? WHERE id = ?').run(idMap.get(Number(item.parent_id)), idMap.get(Number(item.id)));
    for (const role of parsed.data.roles) {
      if (role.is_everyone) continue;
      db.prepare('INSERT INTO roles (server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?)').run(id, String(role.name ?? 'Role').slice(0, 32), /^#[0-9a-f]{6}$/i.test(String(role.color)) ? role.color : '#99aab5', Number(role.permissions ?? 0) & ALL_PERMISSIONS, Number(role.position ?? 0));
    }
    ensureEveryoneRole(id);
    db.prepare('INSERT INTO server_invites (code, server_id, creator_id) VALUES (?, ?, ?)').run(inviteCode, id, req.user!.id);
    audit(id, req.user!.id, 'SERVER_IMPORT', 'SERVER', id);
    return id;
  })();
  return res.status(201).json({ serverId });
});

app.get('/api/admin/stats', requireAuth, requireInstanceAdmin, (_req, res) => {
  const now = Date.now();
  const counts = {
    users: Number((db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c),
    disabledUsers: Number((db.prepare('SELECT COUNT(*) AS c FROM users WHERE disabled = 1').get() as any).c),
    servers: Number((db.prepare('SELECT COUNT(*) AS c FROM servers').get() as any).c),
    messages: Number((db.prepare('SELECT (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM direct_messages) + (SELECT COUNT(*) FROM dm_thread_messages) AS c').get() as any).c),
    online: onlineUsers.size,
    sessions: Number((db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?').get(now) as any).c),
    activeBans: Number((db.prepare('SELECT COUNT(*) AS c FROM instance_bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(now) as any).c),
  };
  let uploadBytes = 0;
  for (const file of fs.readdirSync(uploadDir)) { try { uploadBytes += fs.statSync(path.join(uploadDir, file)).size; } catch {} }
  return res.json({ ...counts, uploadBytes, dataPath: path.join(rootDir, 'data') });
});

app.get('/api/admin/users', requireAuth, requireInstanceAdmin, (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const now = Date.now();
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM server_members sm WHERE sm.user_id = u.id) AS server_count,
      (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) +
      (SELECT COUNT(*) FROM direct_messages dm WHERE dm.sender_id = u.id) +
      (SELECT COUNT(*) FROM dm_thread_messages gm WHERE gm.author_id = u.id) AS message_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count
    FROM users u
    WHERE u.username LIKE ? OR u.display_name LIKE ? OR CAST(u.id AS TEXT) = ?
    ORDER BY u.id DESC LIMIT 300
  `).all(now, `%${q}%`, `%${q}%`, q) as any[];
  return res.json({ users: rows.map((u) => ({
    ...publicUser(u, true),
    disabled: Boolean(u.disabled),
    lastSeenAt: u.last_seen_at ?? null,
    serverCount: Number(u.server_count),
    messageCount: Number(u.message_count),
    sessionCount: Number(u.session_count),
    activeBan: activeInstanceBan(Number(u.id)),
  })) });
});

app.get('/api/admin/users/:userId', requireAuth, requireInstanceAdmin, (req, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return fail(res, 400, 'Invalid user.');
  const row = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM server_members sm WHERE sm.user_id = u.id) AS server_count,
      (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) +
      (SELECT COUNT(*) FROM direct_messages dm WHERE dm.sender_id = u.id) +
      (SELECT COUNT(*) FROM dm_thread_messages gm WHERE gm.author_id = u.id) AS message_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count
    FROM users u WHERE u.id = ?
  `).get(Date.now(), userId) as any;
  if (!row) return fail(res, 404, 'User not found.');
  const sessions = (db.prepare('SELECT token_hash, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map((item) => ({
    id: String(item.token_hash), createdAt: Number(item.created_at), expiresAt: Number(item.expires_at), active: Number(item.expires_at) > Date.now(),
  }));
  const servers = db.prepare(`
    SELECT s.id, s.name, s.icon_path, sm.joined_at
    FROM server_members sm JOIN servers s ON s.id = sm.server_id
    WHERE sm.user_id = ? ORDER BY sm.joined_at DESC
  `).all(userId).map((item: any) => ({ id: Number(item.id), name: item.name, iconPath: item.icon_path ?? null, joinedAt: item.joined_at }));
  const notes = db.prepare(`
    SELECT n.id, n.note, n.created_at, a.id AS author_id, a.display_name AS author_name
    FROM admin_user_notes n LEFT JOIN users a ON a.id = n.author_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100
  `).all(userId).map((item: any) => ({ id: Number(item.id), note: item.note, createdAt: item.created_at, authorId: item.author_id == null ? null : Number(item.author_id), authorName: item.author_name ?? 'Former administrator' }));
  return res.json({ user: { ...publicUser(row, true), disabled: Boolean(row.disabled), lastSeenAt: row.last_seen_at ?? null, serverCount: Number(row.server_count), messageCount: Number(row.message_count), sessionCount: Number(row.session_count), activeBan: activeInstanceBan(userId) }, sessions, servers, notes });
});

app.put('/api/admin/users/:userId/disabled', requireAuth, requireInstanceAdmin, async (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  const parsed = z.object({ disabled: z.boolean(), reason: z.string().trim().max(500).optional() }).safeParse(req.body);
  if (!userId || !parsed.success || userId === req.user!.id) return fail(res, 400, 'Invalid operation.');
  const target = db.prepare('SELECT id, is_instance_admin FROM users WHERE id = ?').get(userId) as any;
  if (!target) return fail(res, 404, 'User not found.');
  if (target.is_instance_admin) return fail(res, 409, 'Remove administrator access before disabling this account.');
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(parsed.data.disabled ? 1 : 0, userId);
  instanceAudit(req.user!.id, parsed.data.disabled ? 'USER_DISABLE' : 'USER_ENABLE', 'USER', userId, { reason: parsed.data.reason ?? '' });
  if (parsed.data.disabled) {
    destroyAllSessions(userId);
    io.to(`user:${userId}`).emit('account:disabled', { reason: parsed.data.reason ?? '' });
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const targetSocket of sockets) targetSocket.disconnect(true);
  }
  return res.status(204).end();
});

app.put('/api/admin/users/:userId/admin', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  const parsed = z.object({ isAdmin: z.boolean() }).safeParse(req.body);
  if (!userId || !parsed.success) return fail(res, 400, 'Invalid operation.');
  const target = db.prepare('SELECT id, is_instance_admin, disabled FROM users WHERE id = ?').get(userId) as any;
  if (!target) return fail(res, 404, 'User not found.');
  if (parsed.data.isAdmin && (Boolean(target.disabled) || activeInstanceBan(userId))) return fail(res, 409, 'Reactivate and unban the user before granting administrator access.');
  if (!parsed.data.isAdmin && target.is_instance_admin) {
    const adminCount = Number((db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_instance_admin = 1').get() as any).c);
    if (adminCount <= 1) return fail(res, 409, 'The instance must keep at least one administrator.');
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET is_instance_admin = ? WHERE id = ?').run(parsed.data.isAdmin ? 1 : 0, userId);
    const adminBadge = db.prepare("SELECT id FROM badges WHERE name = 'Administrator'").get() as any;
    if (adminBadge) {
      if (parsed.data.isAdmin) db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id, assigned_by) VALUES (?, ?, ?)').run(userId, Number(adminBadge.id), req.user!.id);
      else db.prepare('DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?').run(userId, Number(adminBadge.id));
    }
  })();
  instanceAudit(req.user!.id, parsed.data.isAdmin ? 'ADMIN_GRANT' : 'ADMIN_REVOKE', 'USER', userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  io.emit('user:update', publicUser(updated));
  io.to(`user:${userId}`).emit('account:admin', { isInstanceAdmin: parsed.data.isAdmin });
  return res.json({ user: publicUser(updated, userId === req.user!.id) });
});

app.post('/api/admin/users/:userId/logout', requireAuth, requireInstanceAdmin, async (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return fail(res, 400, 'Invalid user.');
  destroyAllSessions(userId);
  instanceAudit(req.user!.id, 'USER_FORCE_LOGOUT', 'USER', userId);
  io.to(`user:${userId}`).emit('account:logout', { reason: 'Your sessions were terminated by an administrator.' });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const targetSocket of sockets) targetSocket.disconnect(true);
  return res.status(204).end();
});

app.delete('/api/admin/sessions/:sessionId', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const sessionId = String(req.params.sessionId ?? '');
  if (!/^[a-f0-9]{64}$/i.test(sessionId)) return fail(res, 400, 'Invalid session.');
  const row = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(sessionId) as any;
  if (!row) return res.status(204).end();
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionId);
  instanceAudit(req.user!.id, 'SESSION_REVOKE', 'USER', Number(row.user_id), { session: sessionId.slice(0, 12) });
  return res.status(204).end();
});

app.delete('/api/admin/users/:userId', requireAuth, requireInstanceAdmin, async (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  const parsed = z.object({ confirmation: z.string().trim(), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
  if (!userId || !parsed.success || userId === req.user!.id) return fail(res, 400, 'Invalid operation.');
  const target = db.prepare('SELECT id, username, is_instance_admin, avatar_path, banner_path, avatar_decoration_path, profile_background_path, custom_join_sound_path FROM users WHERE id = ?').get(userId) as any;
  if (!target) return fail(res, 404, 'User not found.');
  if (target.is_instance_admin) return fail(res, 409, 'Remove administrator access before deleting this account.');
  if (parsed.data.confirmation.toLowerCase() !== String(target.username).toLowerCase()) return fail(res, 400, 'Digite o username exato para confirmar.');

  const memberships = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId) as Array<{ server_id: number }>;
  const ownedServers = db.prepare('SELECT id, name, icon_path, banner_path FROM servers WHERE owner_id = ?').all(userId) as any[];
  const ownedServerIds = new Set(ownedServers.map((server) => Number(server.id)));
  const uploaded = new Set<string>();
  for (const value of [target.avatar_path, target.banner_path, target.avatar_decoration_path, target.profile_background_path, target.custom_join_sound_path]) if (typeof value === 'string' && value.startsWith('/uploads/')) uploaded.add(value);
  const serverProfileAvatars = db.prepare('SELECT avatar_path FROM server_profiles WHERE user_id = ?').all(userId) as Array<{ avatar_path: string | null }>;
  for (const item of serverProfileAvatars) if (item.avatar_path?.startsWith('/uploads/')) uploaded.add(item.avatar_path);

  const premiumEmojiImages = db.prepare('SELECT image_path FROM premium_emojis WHERE user_id = ?').all(userId) as Array<{ image_path: string | null }>;
  for (const item of premiumEmojiImages) if (item.image_path?.startsWith('/uploads/')) uploaded.add(item.image_path);

  const authoredAttachments = db.prepare('SELECT ma.path FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.author_id = ?').all(userId) as Array<{ path: string }>;
  for (const item of authoredAttachments) if (item.path?.startsWith('/uploads/')) uploaded.add(item.path);
  for (const server of ownedServers) {
    for (const value of [server.icon_path, server.banner_path]) if (typeof value === 'string' && value.startsWith('/uploads/')) uploaded.add(value);
    const serverAttachments = db.prepare('SELECT ma.path FROM message_attachments ma JOIN messages m ON m.id = ma.message_id JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?').all(Number(server.id)) as Array<{ path: string }>;
    for (const item of serverAttachments) if (item.path?.startsWith('/uploads/')) uploaded.add(item.path);
    const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(Number(server.id)) as Array<{ user_id: number }>;
    for (const member of memberIds) io.to(`user:${Number(member.user_id)}`).emit('server:deleted', { serverId: Number(server.id), reason: `Server removed because the owner account was deleted. ${parsed.data.reason}` });
  }

  io.to(`user:${userId}`).emit('account:deleted', { reason: parsed.data.reason });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const targetSocket of sockets) targetSocket.disconnect(true);
  instanceAudit(req.user!.id, 'USER_DELETE', 'USER', userId, { username: target.username, reason: parsed.data.reason, ownedServers: ownedServers.map((server) => ({ id: Number(server.id), name: server.name })) });
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  for (const membership of memberships) if (!ownedServerIds.has(Number(membership.server_id))) emitServerRefresh(Number(membership.server_id));
  io.emit('friends:refresh');
  for (const filePath of uploaded) fs.rm(path.join(uploadDir, path.basename(filePath)), { force: true }, () => undefined);
  return res.status(204).end();
});

app.post('/api/admin/users/:userId/notes', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  const parsed = z.object({ note: z.string().trim().min(1).max(1000) }).safeParse(req.body);
  if (!userId || !parsed.success || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return fail(res, 400, 'Invalid note.');
  const result = db.prepare('INSERT INTO admin_user_notes (user_id, author_id, note) VALUES (?, ?, ?)').run(userId, req.user!.id, parsed.data.note);
  instanceAudit(req.user!.id, 'USER_NOTE_ADD', 'USER', userId, { noteId: Number(result.lastInsertRowid) });
  return res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.delete('/api/admin/notes/:noteId', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const noteId = parseId(req.params.noteId);
  if (!noteId) return fail(res, 400, 'Invalid note.');
  const note = db.prepare('SELECT user_id FROM admin_user_notes WHERE id = ?').get(noteId) as any;
  if (!note) return res.status(204).end();
  db.prepare('DELETE FROM admin_user_notes WHERE id = ?').run(noteId);
  instanceAudit(req.user!.id, 'USER_NOTE_DELETE', 'USER', Number(note.user_id), { noteId });
  return res.status(204).end();
});

app.get('/api/admin/bans', requireAuth, requireInstanceAdmin, (req, res) => {
  const onlyActive = String(req.query.active ?? '') === 'true';
  const now = Date.now();
  const rows = db.prepare(`
    SELECT b.*, u.username, u.display_name, u.avatar_path,
      m.display_name AS moderator_name, r.display_name AS revoked_by_name
    FROM instance_bans b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN users m ON m.id = b.moderator_id
    LEFT JOIN users r ON r.id = b.revoked_by
    ${onlyActive ? 'WHERE b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?)' : ''}
    ORDER BY b.id DESC LIMIT 300
  `).all(...(onlyActive ? [now] : [])) as any[];
  return res.json({ bans: rows.map((b) => ({
    id: Number(b.id), userId: Number(b.user_id), username: b.username, displayName: b.display_name, avatarPath: b.avatar_path ?? null,
    moderatorId: b.moderator_id == null ? null : Number(b.moderator_id), moderatorName: b.moderator_name ?? 'Former administrator', reason: b.reason,
    expiresAt: b.expires_at == null ? null : Number(b.expires_at), createdAt: b.created_at,
    revokedAt: b.revoked_at == null ? null : Number(b.revoked_at), revokedBy: b.revoked_by == null ? null : Number(b.revoked_by), revokedByName: b.revoked_by_name ?? null,
    revokeReason: b.revoke_reason ?? null,
    active: b.revoked_at == null && (b.expires_at == null || Number(b.expires_at) > now),
  })) });
});

app.post('/api/admin/users/:userId/ban', requireAuth, requireInstanceAdmin, async (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  const parsed = z.object({ reason: z.string().trim().min(1).max(500), durationMinutes: z.number().int().min(1).max(5_256_000).nullable() }).safeParse(req.body);
  if (!userId || !parsed.success || userId === req.user!.id) return fail(res, 400, 'Invalid ban.');
  const target = db.prepare('SELECT id, is_instance_admin FROM users WHERE id = ?').get(userId) as any;
  if (!target) return fail(res, 404, 'User not found.');
  if (target.is_instance_admin) return fail(res, 409, 'Remove administrator access before banning this account.');
  if (activeInstanceBan(userId)) return fail(res, 409, 'This user already has an active ban.');
  const expiresAt = parsed.data.durationMinutes == null ? null : Date.now() + parsed.data.durationMinutes * 60_000;
  const result = db.prepare('INSERT INTO instance_bans (user_id, moderator_id, reason, expires_at) VALUES (?, ?, ?, ?)').run(userId, req.user!.id, parsed.data.reason, expiresAt);
  destroyAllSessions(userId);
  instanceAudit(req.user!.id, 'USER_BAN', 'USER', userId, { banId: Number(result.lastInsertRowid), reason: parsed.data.reason, expiresAt });
  io.to(`user:${userId}`).emit('account:banned', { reason: parsed.data.reason, expiresAt });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const targetSocket of sockets) targetSocket.disconnect(true);
  return res.status(201).json({ id: Number(result.lastInsertRowid), expiresAt });
});

app.post('/api/admin/bans/:banId/revoke', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const banId = parseId(req.params.banId);
  const parsed = z.object({ reason: z.string().trim().max(500).default('') }).safeParse(req.body);
  if (!banId || !parsed.success) return fail(res, 400, 'Invalid ban.');
  const ban = db.prepare('SELECT id, user_id, revoked_at FROM instance_bans WHERE id = ?').get(banId) as any;
  if (!ban) return fail(res, 404, 'Ban not found.');
  if (ban.revoked_at != null) return fail(res, 409, 'This ban has already been revoked.');
  db.prepare('UPDATE instance_bans SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?').run(Date.now(), req.user!.id, parsed.data.reason, banId);
  instanceAudit(req.user!.id, 'USER_UNBAN', 'USER', Number(ban.user_id), { banId, reason: parsed.data.reason });
  return res.status(204).end();
});

app.get('/api/admin/badges', requireAuth, requireInstanceAdmin, (_req, res) => {
  const badges = (db.prepare(`
    SELECT b.id, b.name, b.image_path, b.position, b.created_at, COUNT(ub.user_id) AS assignment_count
    FROM badges b LEFT JOIN user_badges ub ON ub.badge_id = b.id
    GROUP BY b.id ORDER BY b.position DESC, b.name COLLATE NOCASE
  `).all() as any[]).map((badge) => ({
    id: Number(badge.id), name: String(badge.name), imagePath: badge.image_path ? String(badge.image_path) : null,
    position: Number(badge.position), createdAt: badge.created_at, assignmentCount: Number(badge.assignment_count),
  }));
  return res.json({ badges });
});

app.post('/api/admin/badges', requireAuth, requireInstanceAdmin, badgeUpload.single('image'), (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(32) }).safeParse({ name: req.body.name });
  if (!parsed.success || !req.file) { if (req.file) removeUploaded([req.file]); return fail(res, 400, 'Enter a name and upload an image for the badge.'); }
  if (Number((db.prepare('SELECT COUNT(*) AS count FROM badges').get() as any).count) >= 100) { removeUploaded([req.file]); return fail(res, 409, 'Limit of 100 badges reached.'); }
  try {
    const position = Number((db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM badges').get() as any).max) + 1;
    const imagePath = `/uploads/${req.file.filename}`;
    const result = db.prepare("INSERT INTO badges (name, icon, color, image_path, position) VALUES (?, '◆', '#7289da', ?, ?)").run(parsed.data.name, imagePath, position);
    instanceAudit(req.user!.id, 'BADGE_CREATE', 'BADGE', Number(result.lastInsertRowid), { name: parsed.data.name });
    io.emit('badges:refresh');
    return res.status(201).json({ id: Number(result.lastInsertRowid), name: parsed.data.name, imagePath, position });
  } catch {
    removeUploaded([req.file]);
    return fail(res, 409, 'A badge with that name already exists.');
  }
});

app.put('/api/admin/badges/:badgeId', requireAuth, requireInstanceAdmin, badgeUpload.single('image'), (req: AuthenticatedRequest, res) => {
  const badgeId = parseId(req.params.badgeId);
  const parsed = z.object({ name: z.string().trim().min(1).max(32) }).safeParse({ name: req.body.name });
  if (!badgeId || !parsed.success) { if (req.file) removeUploaded([req.file]); return fail(res, 400, 'Invalid badge.'); }
  const current = db.prepare('SELECT * FROM badges WHERE id = ?').get(badgeId) as any;
  if (!current) { if (req.file) removeUploaded([req.file]); return fail(res, 404, 'Badge not found.'); }
  const nextImage = req.file ? `/uploads/${req.file.filename}` : current.image_path;
  if (!nextImage) { if (req.file) removeUploaded([req.file]); return fail(res, 400, 'A badge must have an image.'); }
  try {
    db.prepare('UPDATE badges SET name = ?, image_path = ? WHERE id = ?').run(parsed.data.name, nextImage, badgeId);
  } catch {
    if (req.file) removeUploaded([req.file]);
    return fail(res, 409, 'A badge with that name already exists.');
  }
  if (req.file && current.image_path?.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(current.image_path)), { force: true }, () => undefined);
  instanceAudit(req.user!.id, 'BADGE_UPDATE', 'BADGE', badgeId, { name: parsed.data.name });
  io.emit('badges:refresh');
  return res.json({ id: badgeId, name: parsed.data.name, imagePath: nextImage, position: Number(current.position) });
});

app.post('/api/admin/badges/reorder', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ ids: z.array(z.number().int().positive()).max(100) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid ordering.');
  const update = db.prepare('UPDATE badges SET position = ? WHERE id = ?');
  db.transaction(() => parsed.data.ids.forEach((id, index) => update.run(parsed.data.ids.length - index, id)))();
  instanceAudit(req.user!.id, 'BADGE_REORDER', 'BADGE');
  io.emit('badges:refresh');
  return res.status(204).end();
});

app.delete('/api/admin/badges/:badgeId', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const badgeId = parseId(req.params.badgeId);
  if (!badgeId) return fail(res, 400, 'Invalid badge.');
  const badge = db.prepare('SELECT name, image_path FROM badges WHERE id = ?').get(badgeId) as any;
  if (!badge) return res.status(204).end();
  db.prepare('DELETE FROM badges WHERE id = ?').run(badgeId);
  if (badge.image_path?.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(badge.image_path)), { force: true }, () => undefined);
  instanceAudit(req.user!.id, 'BADGE_DELETE', 'BADGE', badgeId, { name: badge.name });
  io.emit('badges:refresh');
  return res.status(204).end();
});

app.put('/api/admin/users/:userId/badges', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  const parsed = z.object({ badgeIds: z.array(z.number().int().positive()).max(100) }).safeParse(req.body);
  if (!userId || !parsed.success || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return fail(res, 400, 'Invalid user or badges.');
  const uniqueIds = [...new Set(parsed.data.badgeIds)];
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => '?').join(',');
    const existing = Number((db.prepare(`SELECT COUNT(*) AS count FROM badges WHERE id IN (${placeholders})`).get(...uniqueIds) as any).count);
    if (existing !== uniqueIds.length) return fail(res, 400, 'One of the badges does not exist.');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM user_badges WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO user_badges (user_id, badge_id, assigned_by) VALUES (?, ?, ?)');
    for (const badgeId of uniqueIds) insert.run(userId, badgeId, req.user!.id);
  })();
  instanceAudit(req.user!.id, 'USER_BADGES_UPDATE', 'USER', userId, { badgeIds: uniqueIds });
  const updatedRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  const updatedPublic = publicUser(updatedRow);
  io.emit('user:update', updatedPublic);
  io.emit('badges:refresh', { userId });
  return res.json({ user: publicUser(updatedRow, userId === req.user!.id) });
});

app.get('/api/admin/servers', requireAuth, requireInstanceAdmin, (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const rows = db.prepare(`
    SELECT s.*, u.username AS owner_username, u.display_name AS owner_name,
      (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count,
      (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count,
      (SELECT COUNT(*) FROM messages m JOIN channels c2 ON c2.id = m.channel_id WHERE c2.server_id = s.id) AS message_count
    FROM servers s JOIN users u ON u.id = s.owner_id
    WHERE s.name LIKE ? OR u.username LIKE ? OR CAST(s.id AS TEXT) = ?
    ORDER BY s.id DESC LIMIT 300
  `).all(`%${q}%`, `%${q}%`, q) as any[];
  return res.json({ servers: rows.map((row) => ({
    id: Number(row.id), name: row.name, description: row.description ?? '', iconPath: row.icon_path ?? null, bannerPath: row.banner_path ?? null,
    ownerId: Number(row.owner_id), ownerUsername: row.owner_username, ownerName: row.owner_name, memberCount: Number(row.member_count), channelCount: Number(row.channel_count), messageCount: Number(row.message_count), createdAt: row.created_at,
  })) });
});

app.delete('/api/admin/servers/:serverId', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const serverId = parseId(req.params.serverId);
  const parsed = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
  if (!serverId || !parsed.success) return fail(res, 400, 'Invalid operation.');
  const serverRow = db.prepare('SELECT id, name, icon_path, banner_path FROM servers WHERE id = ?').get(serverId) as any;
  if (!serverRow) return fail(res, 404, 'Server not found.');
  const attachmentPaths = (db.prepare('SELECT ma.path FROM message_attachments ma JOIN messages m ON m.id = ma.message_id JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?').all(serverId) as any[]).map((row) => String(row.path));
  const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId) as Array<{ user_id: number }>;
  io.to(`server:${serverId}`).emit('server:deleted', { serverId, reason: parsed.data.reason });
  for (const member of memberIds) io.to(`user:${Number(member.user_id)}`).emit('server:deleted', { serverId, reason: parsed.data.reason });
  instanceAudit(req.user!.id, 'SERVER_DELETE', 'SERVER', serverId, { name: serverRow.name, reason: parsed.data.reason });
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  const files = [serverRow.icon_path, serverRow.banner_path, ...attachmentPaths].filter((value: unknown) => typeof value === 'string' && value.startsWith('/uploads/')) as string[];
  for (const filePath of files) fs.rm(path.join(uploadDir, path.basename(filePath)), { force: true }, () => undefined);
  return res.status(204).end();
});

app.get('/api/admin/audit', requireAuth, requireInstanceAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(300, Number(req.query.limit ?? 150) || 150));
  const action = String(req.query.action ?? '').trim().slice(0, 80);
  const rows = db.prepare(`
    SELECT l.*, u.display_name AS actor_name, u.username AS actor_username
    FROM instance_audit_logs l LEFT JOIN users u ON u.id = l.actor_id
    WHERE (? = '' OR l.action = ?)
    ORDER BY l.id DESC LIMIT ?
  `).all(action, action, limit) as any[];
  return res.json({ logs: rows.map((row) => ({ id: Number(row.id), actorId: row.actor_id == null ? null : Number(row.actor_id), actorName: row.actor_name ?? 'Sistema', actorUsername: row.actor_username ?? null, action: row.action, targetType: row.target_type ?? null, targetId: row.target_id == null ? null : Number(row.target_id), details: safeJson(row.details), createdAt: row.created_at })) });
});


const premiumBenefitsSchema = z.object({
  animatedAvatar: z.boolean(), animatedBanner: z.boolean(), maxUploadMb: z.number().int().min(1).max(500), externalEmojis: z.boolean(),
  favoriteEmojiSlots: z.number().int().min(0).max(1000), screenShare1080p60: z.boolean(), camera1080p60: z.boolean(), customProfileTheme: z.boolean(),
  premiumBadge: z.boolean(), bioMaxLength: z.number().int().min(190).max(4000), maxServers: z.number().int().min(0).max(5000), maxDmGroups: z.number().int().min(0).max(5000),
  customJoinSound: z.boolean(), profileEffects: z.boolean(), avatarDecoration: z.boolean(), profileBackground: z.boolean(), externalReactions: z.boolean(),
  maxFilesPerMessage: z.number().int().min(1).max(10), priorityVoice: z.boolean(), specialIdentity: z.boolean(), perServerProfiles: z.boolean(),
  premiumThemes: z.boolean(), profileGradient: z.boolean(), advancedStatus: z.boolean(), profileHistoryDays: z.number().int().min(0).max(3650),
});

app.get('/api/admin/premium', requireAuth, requireInstanceAdmin, (_req, res) => {
  const now = Date.now();
  const subscribers = (db.prepare(`SELECT p.user_id, p.granted_by, p.starts_at, p.expires_at, u.username, u.display_name, u.avatar_path
    FROM user_premium p JOIN users u ON u.id = p.user_id ORDER BY CASE WHEN p.expires_at IS NULL THEN 0 ELSE 1 END, p.expires_at DESC`).all() as any[]).map((row) => ({
      userId: Number(row.user_id), grantedBy: row.granted_by == null ? null : Number(row.granted_by), startsAt: Number(row.starts_at), expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      username: row.username, displayName: row.display_name, avatarPath: row.avatar_path ?? null, active: Number(row.starts_at) <= now && (row.expires_at == null || Number(row.expires_at) > now),
    }));
  return res.json({
    enabled: instanceSetting('premiumEnabled', 'true') === 'true', name: instanceSetting('premiumName', 'Open+'),
    description: instanceSetting('premiumDescription', 'Special benefits for this instance.'), color: instanceSetting('premiumColor', '#f47fff'),
    iconPath: instanceSetting('premiumIcon', '') || null, priceLabel: instanceSetting('premiumPriceLabel', 'Granted by the instance administration'),
    defaultDurationDays: Math.max(0, Math.min(3650, Number(instanceSetting('premiumDefaultDurationDays', '30')) || 0)), benefits: premiumBenefits(), subscribers,
  });
});

app.put('/api/admin/premium', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({
    enabled: z.boolean(), name: z.string().trim().min(1).max(40), description: z.string().max(240), color: hexColorSchema,
    priceLabel: z.string().max(80), defaultDurationDays: z.number().int().min(0).max(3650), benefits: premiumBenefitsSchema,
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid premium plan configuration.');
  setInstanceSetting('premiumEnabled', String(parsed.data.enabled));
  setInstanceSetting('premiumName', parsed.data.name);
  setInstanceSetting('premiumDescription', parsed.data.description);
  setInstanceSetting('premiumColor', parsed.data.color);
  setInstanceSetting('premiumPriceLabel', parsed.data.priceLabel);
  setInstanceSetting('premiumDefaultDurationDays', String(parsed.data.defaultDurationDays));
  setInstanceSetting('premiumBenefits', JSON.stringify(parsed.data.benefits));
  instanceAudit(req.user!.id, 'PREMIUM_SETTINGS_UPDATE', 'INSTANCE', undefined, { name: parsed.data.name, enabled: parsed.data.enabled, priceLabel: parsed.data.priceLabel, defaultDurationDays: parsed.data.defaultDurationDays, benefits: parsed.data.benefits });
  io.emit('premium:refresh');
  return res.status(204).end();
});

app.post('/api/admin/premium/icon', requireAuth, requireInstanceAdmin, premiumImageUpload.single('icon'), (req: AuthenticatedRequest, res) => {
  if (!req.file) return fail(res, 400, 'Select PNG, JPEG, WebP, or GIF.');
  const old = instanceSetting('premiumIcon', '');
  const nextPath = `/uploads/${req.file.filename}`;
  setInstanceSetting('premiumIcon', nextPath);
  removeUserUpload(old);
  instanceAudit(req.user!.id, 'PREMIUM_ICON_UPDATE', 'INSTANCE');
  io.emit('premium:refresh');
  return res.json({ iconPath: nextPath });
});

app.put('/api/admin/users/:userId/premium', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return fail(res, 400, 'Invalid user.');

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!target) return fail(res, 404, 'User not found.');

  const activeRaw = req.body?.active;
  const active = activeRaw === true || activeRaw === 'true' || activeRaw === 1 || activeRaw === '1';
  const inactive = activeRaw === false || activeRaw === 'false' || activeRaw === 0 || activeRaw === '0';
  if (!active && !inactive) return fail(res, 400, 'Invalid premium plan state.');

  let durationMinutes: number | null = null;
  const durationRaw = req.body?.durationMinutes;
  if (active && durationRaw !== null && durationRaw !== undefined && durationRaw !== '') {
    const numericDuration = Number(durationRaw);
    if (!Number.isInteger(numericDuration) || numericDuration < 1 || numericDuration > 5_256_000) {
      return fail(res, 400, 'Invalid duration. Use between 1 minute and 3650 days, or permanent.');
    }
    durationMinutes = numericDuration;
  }

  try {
    if (!active) {
      db.transaction(() => {
        db.prepare('DELETE FROM user_premium WHERE user_id = ?').run(userId);
        instanceAudit(req.user!.id, 'PREMIUM_REVOKE', 'USER', userId);
      })();
      io.to(`user:${userId}`).emit('premium:refresh');
      const updatedUser = userById(userId, true);
      if (updatedUser) io.emit('user:update', updatedUser);
      return res.status(204).end();
    }

    const startsAt = Date.now();
    const expiresAt = durationMinutes == null ? null : startsAt + durationMinutes * 60_000;

    db.transaction(() => {
      const update = db.prepare(`UPDATE user_premium
        SET granted_by = ?, starts_at = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?`).run(req.user!.id, startsAt, expiresAt, userId);
      if (update.changes === 0) {
        db.prepare(`INSERT INTO user_premium (user_id, granted_by, starts_at, expires_at, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(userId, req.user!.id, startsAt, expiresAt);
      }
      instanceAudit(req.user!.id, 'PREMIUM_GRANT', 'USER', userId, { expiresAt, durationMinutes });
    })();

    io.to(`user:${userId}`).emit('premium:refresh');
    const updatedUser = userById(userId, true);
    if (updatedUser) io.emit('user:update', updatedUser);
    return res.json({ expiresAt, premium: activePremiumForUser(userId) });
  } catch (error) {
    console.error('[Premium] Failed to update subscription:', error);
    return fail(res, 500, 'Could not update the premium plan. Restart OpenCord to apply migrations and try again.');
  }
});

const monetizationUrlSchema = z.string().trim().max(500).refine((value) => value === '' || /^https?:\/\/[^\s]+$/i.test(value));

app.get('/api/admin/monetization', requireAuth, requireInstanceAdmin, (_req, res) => res.json({
  enabled: instanceSetting('monetizationEnabled', 'false') === 'true',
  supportTitle: instanceSetting('supportTitle', 'Support OpenCord'),
  supportDescription: instanceSetting('supportDescription', 'Help fund development, maintenance, and infrastructure.'),
  supportUrl: instanceSetting('supportUrl', ''),
  supportButtonLabel: instanceSetting('supportButtonLabel', 'Support the project'),
  premiumCheckoutUrl: instanceSetting('premiumCheckoutUrl', ''),
  premiumCheckoutLabel: instanceSetting('premiumCheckoutLabel', 'Get access'),
  managedHostingUrl: instanceSetting('managedHostingUrl', ''),
  managedHostingLabel: instanceSetting('managedHostingLabel', 'Managed hosting'),
}));

app.put('/api/admin/monetization', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({
    enabled: z.boolean(),
    supportTitle: z.string().trim().min(1).max(60),
    supportDescription: z.string().max(240),
    supportUrl: monetizationUrlSchema,
    supportButtonLabel: z.string().trim().min(1).max(40),
    premiumCheckoutUrl: monetizationUrlSchema,
    premiumCheckoutLabel: z.string().trim().min(1).max(40),
    managedHostingUrl: monetizationUrlSchema,
    managedHostingLabel: z.string().trim().min(1).max(40),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid monetization configuration. Use only HTTP or HTTPS links.');
  setInstanceSetting('monetizationEnabled', String(parsed.data.enabled));
  setInstanceSetting('supportTitle', parsed.data.supportTitle);
  setInstanceSetting('supportDescription', parsed.data.supportDescription);
  setInstanceSetting('supportUrl', parsed.data.supportUrl);
  setInstanceSetting('supportButtonLabel', parsed.data.supportButtonLabel);
  setInstanceSetting('premiumCheckoutUrl', parsed.data.premiumCheckoutUrl);
  setInstanceSetting('premiumCheckoutLabel', parsed.data.premiumCheckoutLabel);
  setInstanceSetting('managedHostingUrl', parsed.data.managedHostingUrl);
  setInstanceSetting('managedHostingLabel', parsed.data.managedHostingLabel);
  instanceAudit(req.user!.id, 'MONETIZATION_SETTINGS_UPDATE', 'INSTANCE', undefined, { enabled: parsed.data.enabled, supportUrlConfigured: Boolean(parsed.data.supportUrl), premiumCheckoutConfigured: Boolean(parsed.data.premiumCheckoutUrl), managedHostingConfigured: Boolean(parsed.data.managedHostingUrl) });
  io.emit('monetization:refresh');
  return res.status(204).end();
});

app.get('/api/admin/monetization/codes', requireAuth, requireInstanceAdmin, (_req, res) => {
  const codes = (db.prepare(`SELECT id, code_prefix, duration_minutes, max_uses, use_count, disabled, created_at FROM premium_redeem_codes ORDER BY id DESC LIMIT 250`).all() as any[]).map((row) => ({
    id: Number(row.id), prefix: String(row.code_prefix), durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes), maxUses: Number(row.max_uses), useCount: Number(row.use_count), disabled: Boolean(row.disabled), createdAt: String(row.created_at),
  }));
  return res.json({ codes });
});

app.post('/api/admin/monetization/codes', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ durationDays: z.number().int().min(0).max(3650), maxUses: z.number().int().min(1).max(1000) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid redemption-code configuration.');
  const raw = crypto.randomBytes(9).toString('hex').toUpperCase();
  const code = `OPEN-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const durationMinutes = parsed.data.durationDays === 0 ? null : parsed.data.durationDays * 1440;
  const result = db.prepare('INSERT INTO premium_redeem_codes (code_hash, code_prefix, duration_minutes, max_uses, created_by) VALUES (?, ?, ?, ?, ?)').run(codeHash, code.slice(0, 11), durationMinutes, parsed.data.maxUses, req.user!.id);
  instanceAudit(req.user!.id, 'PREMIUM_CODE_CREATE', 'PREMIUM_CODE', Number(result.lastInsertRowid), { durationMinutes, maxUses: parsed.data.maxUses });
  return res.status(201).json({ id: Number(result.lastInsertRowid), code });
});

app.delete('/api/admin/monetization/codes/:id', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid code.');
  const result = db.prepare('UPDATE premium_redeem_codes SET disabled = 1 WHERE id = ?').run(id);
  if (result.changes === 0) return fail(res, 404, 'Redemption code not found.');
  instanceAudit(req.user!.id, 'PREMIUM_CODE_DISABLE', 'PREMIUM_CODE', id);
  return res.status(204).end();
});

app.get('/api/admin/settings', requireAuth, requireInstanceAdmin, (_req, res) => res.json({
  name: instanceSetting('name', 'OpenCord'),
  description: instanceSetting('description', 'Your self-hosted place to talk.'),
  logo: instanceSetting('logo', ''),
  registrationEnabled: instanceSetting('registrationEnabled', 'true') === 'true',
  maxServersPerUser: Math.max(0, Number(instanceSetting('maxServersPerUser', '20')) || 0),
  maxUploadMb: Math.max(1, Math.min(50, Number(instanceSetting('maxUploadMb', '15')) || 15)),
}));
app.put('/api/admin/settings', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(60), description: z.string().max(240), registrationEnabled: z.boolean(),
    maxServersPerUser: z.number().int().min(0).max(1000), maxUploadMb: z.number().int().min(1).max(50),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid configuration.');
  setInstanceSetting('name', parsed.data.name);
  setInstanceSetting('description', parsed.data.description);
  setInstanceSetting('registrationEnabled', String(parsed.data.registrationEnabled));
  setInstanceSetting('maxServersPerUser', String(parsed.data.maxServersPerUser));
  setInstanceSetting('maxUploadMb', String(parsed.data.maxUploadMb));
  instanceAudit(req.user!.id, 'INSTANCE_SETTINGS_UPDATE', 'INSTANCE', undefined, { name: parsed.data.name, registrationEnabled: parsed.data.registrationEnabled, maxServersPerUser: parsed.data.maxServersPerUser, maxUploadMb: parsed.data.maxUploadMb });
  return res.status(204).end();
});

app.post('/api/admin/logo', requireAuth, requireInstanceAdmin, imageUpload.single('logo'), (req: AuthenticatedRequest, res) => {
  if (!req.file) return fail(res, 400, 'Select an image.');
  const previous = instanceSetting('logo', '');
  const nextPath = `/uploads/${req.file.filename}`;
  setInstanceSetting('logo', nextPath);
  if (previous.startsWith('/uploads/')) fs.rm(path.join(uploadDir, path.basename(previous)), { force: true }, () => undefined);
  instanceAudit(req.user!.id, 'INSTANCE_LOGO_UPDATE', 'INSTANCE');
  return res.json({ logo: nextPath });
});

app.post('/api/admin/backup', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const backup = createBackup('manual');
  instanceAudit(req.user!.id, 'BACKUP_CREATE', 'BACKUP', undefined, { file: path.basename(backup) });
  return res.json({ file: path.basename(backup) });
});

app.get('/api/admin/backups', requireAuth, requireInstanceAdmin, (_req, res) => {
  const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.db')).map((name) => ({ name, size: fs.statSync(path.join(backupDir, name)).size, modifiedAt: fs.statSync(path.join(backupDir, name)).mtime.toISOString() })).sort((a, b) => b.name.localeCompare(a.name));
  return res.json({ backups });
});

app.get('/api/admin/backups/:name/download', requireAuth, requireInstanceAdmin, (req, res) => {
  const name = path.basename(String(req.params.name));
  if (!/^[a-zA-Z0-9._-]+\.db$/.test(name)) return fail(res, 400, 'Invalid backup.');
  const target = path.join(backupDir, name);
  if (!fs.existsSync(target)) return fail(res, 404, 'Backup not found.');
  return res.download(target, name);
});

app.delete('/api/admin/backups/:name', requireAuth, requireInstanceAdmin, (req: AuthenticatedRequest, res) => {
  const name = path.basename(String(req.params.name));
  if (!/^[a-zA-Z0-9._-]+\.db$/.test(name)) return fail(res, 400, 'Invalid backup.');
  const target = path.join(backupDir, name);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  instanceAudit(req.user!.id, 'BACKUP_DELETE', 'BACKUP', undefined, { file: name });
  return res.status(204).end();
});

io.use((socket, next) => {
  const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
  const user = getUserFromToken(cookies.opencord_session);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user as PublicUser;
  socket.join(`user:${user.id}`);
  const membershipRooms = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(user.id) as Array<{ server_id: number }>;
  for (const membership of membershipRooms) socket.join(`notify-server:${Number(membership.server_id)}`);
  onlineUsers.set(user.id, (onlineUsers.get(user.id) ?? 0) + 1);
  io.emit('presence:update', { userId: user.id, presence: publicPresence(user.id, user.presence) });

  socket.on('latency:ping', (ack?: (serverTime: number) => void) => ack?.(Date.now()));

  socket.on('server:subscribe', (serverIdRaw) => {
    const serverId = parseId(serverIdRaw);
    if (serverId && isMember(user.id, serverId)) { socket.join(`server:${serverId}`); socket.join(`notify-server:${serverId}`); }
  });

  socket.on('server:unsubscribe', (serverIdRaw) => {
    const serverId = parseId(serverIdRaw);
    if (serverId) socket.leave(`server:${serverId}`);
  });

  socket.on('channel:subscribe', (channelIdRaw) => {
    const channelId = parseId(channelIdRaw);
    if (channelId && canAccessChannel(user.id, channelId)) socket.join(`channel:${channelId}`);
  });

  socket.on('channel:unsubscribe', (channelIdRaw) => {
    const channelId = parseId(channelIdRaw);
    if (channelId) socket.leave(`channel:${channelId}`);
  });

  socket.on('typing:channel', (payload: any) => {
    const channelId = parseId(payload?.channelId);
    const currentUser = userById(user.id) ?? user;
    socket.data.user = currentUser;
    if (channelId && canAccessChannel(currentUser.id, channelId)) socket.to(`channel:${channelId}`).emit('typing:channel', { channelId, user: currentUser });
  });

  socket.on('typing:dm', (payload: any) => {
    const targetId = parseId(payload?.userId);
    if (!targetId) return;
    const currentUser = userById(user.id) ?? user;
    socket.data.user = currentUser;
    const friendship = friendshipStatus(currentUser.id, targetId);
    if (friendship?.status === 'accepted' && !isBlocked(currentUser.id, targetId)) io.to(`user:${targetId}`).emit('typing:dm', { user: currentUser });
  });

  socket.on('voice:join', async (channelIdRaw, acknowledge?: (payload: any) => void) => {
    const currentUser = userById(user.id) ?? user;
    socket.data.user = currentUser;
    const requestedChannel = typeof channelIdRaw === 'object' && channelIdRaw ? channelIdRaw.channelId : channelIdRaw;
    const usePriority = !(typeof channelIdRaw === 'object' && channelIdRaw && channelIdRaw.usePriority === false);
    const channelId = parseId(requestedChannel);
    if (!channelId || !canAccessChannel(currentUser.id, channelId) || !hasChannelPermission(currentUser.id, channelId, Permission.CONNECT)) return acknowledge?.({ error: 'Invalid voice channel or permission denied.' });
    const channel = db.prepare("SELECT * FROM channels WHERE id = ? AND kind = 'VOICE'").get(channelId) as any;
    if (!channel) return acknowledge?.({ error: 'Invalid voice channel.' });
    const room = `voice:${channelId}`;
    const existingSockets = await io.in(room).fetchSockets();
    const hasPriorityVoice = usePriority && hasPremiumBenefit(currentUser.id, 'priorityVoice');
    if (Number(channel.user_limit) > 0 && existingSockets.length >= Number(channel.user_limit) && !hasPriorityVoice && !hasPermission(currentUser.id, Number(channel.server_id), Permission.MANAGE_SERVER)) return acknowledge?.({ error: 'Voice channel is full.' });

    leaveVoiceSocket(socket);
    const peers = existingSockets.map((peer) => {
      const peerUser = userById(Number((peer.data.user as PublicUser | undefined)?.id)) ?? peer.data.user as PublicUser;
      if (peerUser) peer.data.user = peerUser;
      return { socketId: peer.id, user: peerUser, state: voiceStates.get(peer.id) };
    });
    socket.join(room);
    socket.data.voiceRoom = room;
    socket.data.voiceChannelId = channelId;
    const state: VoiceState = { socketId: socket.id, userId: currentUser.id, user: currentUser, channelId, serverId: Number(channel.server_id), selfMuted: false, selfDeafened: false, serverMuted: false, serverDeafened: false, cameraOn: false, screenOn: false };
    voiceStates.set(socket.id, state);
    socket.to(room).emit('voice:user-joined', { socketId: socket.id, user: currentUser, state });
    emitVoiceState(Number(channel.server_id));
    acknowledge?.({ peers, channelId, state });
  });

  socket.on('voice:state-update', (payload: any) => {
    const state = voiceStates.get(socket.id);
    if (!state) return;
    if (typeof payload?.selfMuted === 'boolean') state.selfMuted = payload.selfMuted;
    if (typeof payload?.selfDeafened === 'boolean') state.selfDeafened = payload.selfDeafened;
    if (typeof payload?.cameraOn === 'boolean') state.cameraOn = payload.cameraOn;
    if (typeof payload?.screenOn === 'boolean') state.screenOn = payload.screenOn;
    socket.to(`voice:${state.channelId}`).emit('voice:peer-state', { socketId: socket.id, state });
    emitVoiceState(state.serverId);
  });

  socket.on('voice:leave', () => leaveVoiceSocket(socket));

  socket.on('webrtc:signal', (payload: any) => {
    if (!payload || typeof payload.to !== 'string') return;
    const room = socket.data.voiceRoom as string | undefined;
    if (!room) return;
    const target = io.sockets.sockets.get(payload.to);
    if (!target || target.data.voiceRoom !== room) return;
    const currentUser = userById(user.id) ?? user;
    socket.data.user = currentUser;
    io.to(payload.to).emit('webrtc:signal', { from: socket.id, user: currentUser, description: payload.description, candidate: payload.candidate });
  });

  socket.on('disconnect', () => {
    leaveVoiceSocket(socket);
    const next = Math.max(0, (onlineUsers.get(user.id) ?? 1) - 1);
    if (next) onlineUsers.set(user.id, next); else onlineUsers.delete(user.id);
    if (!next) db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    io.emit('presence:update', { userId: user.id, presence: next ? publicPresence(user.id, user.presence) : 'offline' });
  });
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof multer.MulterError) return fail(res, 400, error.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Upload failed.');
  if (error instanceof Error && error.message === 'File type not allowed.') return fail(res, 400, error.message);
  return fail(res, 500, 'Internal server error.');
});

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

let lastPremiumExpirySweep = Date.now();
setInterval(() => {
  const now = Date.now();
  const expired = db.prepare(`SELECT user_id FROM user_premium WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?`).all(lastPremiumExpirySweep, now) as Array<{ user_id: number }>;
  lastPremiumExpirySweep = now;
  for (const row of expired) {
    const userId = Number(row.user_id);
    io.to(`user:${userId}`).emit('premium:refresh');
    const user = userById(userId);
    if (user) io.emit('user:update', user);
  }
}, 30_000).unref();

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()), 60 * 60 * 1000).unref();
setInterval(() => {
  try {
    createBackup('auto');
    const files = fs.readdirSync(backupDir).filter((name) => name.startsWith('auto-') && name.endsWith('.db')).sort().reverse();
    for (const old of files.slice(10)) fs.rmSync(path.join(backupDir, old), { force: true });
  } catch (error) { console.error('Automatic backup failed:', error); }
}, 24 * 60 * 60 * 1000).unref();

server.listen(port, host, () => {
  console.log(`OpenCord 0.6.0 available at http://localhost:${port}`);
  if (host === '0.0.0.0') console.log(`Local network: open http://YOUR-IP:${port} on another device.`);
});
