import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import compression from 'compression';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
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

function isAllowedRequestOrigin(req: Request, originHeader: string) {
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

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const origin = req.get('origin');

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

const profileImageUpload = makeUpload(animatedImageMimes, 12 * 1024 * 1024);
const premiumImageUpload = makeUpload(animatedImageMimes, 8 * 1024 * 1024);

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

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function userById(id: number, includePrivate = false): PublicUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id);
  return row ? publicUser(row, includePrivate) : null;
}

function safeJson(value: string | null | undefined) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function removeUploaded(files: Express.Multer.File[] = []) {
  for (const file of files) fs.rm(file.path, { force: true }, () => undefined);
}

function instanceSetting(key: string, fallback = '') {
  const row = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key) as any;
  return row?.value ?? fallback;
}

function publicPresence(userId: number, declared: PublicUser['presence']) {
  return declared === 'invisible' ? 'offline' : declared;
}

app.get('/api/health', (_req: Request, res: Response) => res.json({ ok: true, name: 'OpenCord', version: '0.6.0' }));

app.get('/api/config', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  let iceServers: unknown[] = [];
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON ?? '[]');
    if (Array.isArray(parsed)) iceServers = parsed;
  } catch {
    console.warn('Invalid ICE_SERVERS_JSON; using an empty list.');
  }
  res.json({ iceServers, instanceName: instanceSetting('name', 'OpenCord'), instanceLogo: instanceSetting('logo', ''), premium: req.user ? activePremiumForUser(req.user.id) : null });
});

app.get('/api/instance', (_req: Request, res: Response) => {
  res.json({ name: instanceSetting('name', 'OpenCord'), description: instanceSetting('description', 'Your self-hosted place to talk.'), logo: instanceSetting('logo', ''), premiumName: instanceSetting('premiumName', 'Open+'), premiumColor: instanceSetting('premiumColor', '#f47fff'), premiumIcon: instanceSetting('premiumIcon', ''), termsVersion });
});

app.get('/api/monetization', (_req: Request, res: Response) => {
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

app.post('/api/auth/register', authLimiter, async (req: Request, res: Response) => {
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

app.post('/api/auth/login', authLimiter, async (req: Request, res: Response) => {
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

app.post('/api/auth/logout', (req: Request, res: Response) => {
  destroySession(readSessionToken(req));
  clearSessionCookie(res);
  return res.status(204).end();
});

app.post('/api/auth/logout-all', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  destroyAllSessions(req.user!.id);
  clearSessionCookie(res);
  return res.status(204).end();
});

app.post('/api/auth/password', requireAuth, authLimiter, async (req: AuthenticatedRequest, res: Response) => {
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

app.get('/api/me', requireAuth, (req: AuthenticatedRequest, res: Response) => res.json({ user: req.user }));

app.patch('/api/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
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

app.get('/api/me/premium', requireAuth, (req: AuthenticatedRequest, res: Response) => {
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

app.post('/api/me/premium/redeem', requireAuth, (req: AuthenticatedRequest, res: Response) => {
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

app.get('/api/me/profile-history', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  if (!hasPremiumBenefit(req.user!.id, 'profileHistoryDays')) return fail(res, 403, 'Your plan does not include profile history.');
  const days = numericPremiumBenefit(req.user!.id, 'profileHistoryDays', 0);
  const rows = db.prepare('SELECT id, snapshot, created_at FROM user_profile_history WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 200')
    .all(req.user!.id, Date.now() - days * 86400000) as any[];
  return res.json({ history: rows.map((row) => ({ id: Number(row.id), snapshot: safeJson(row.snapshot), createdAt: Number(row.created_at) })) });
});

app.patch('/api/me/premium-profile', requireAuth, (req: AuthenticatedRequest, res: Response) => {
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

app.post('/api/me/avatar', requireAuth, profileImageUpload.single('avatar'), (req: AuthenticatedRequest, res: Response) => {
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

app.post('/api/me/banner', requireAuth, profileImageUpload.single('banner'), (req: AuthenticatedRequest, res: Response) => {
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

app.post('/api/me/avatar-decoration', requireAuth, premiumImageUpload.single('image'), (req: AuthenticatedRequest, res: Response) => {
  if (!hasPremiumBenefit(req.user!.id, 'avatarDecoration')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Avatar decorations are not included in your plan.'); }
  if (!req.file) return fail(res, 400, 'Select an image.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT avatar_decoration_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET avatar_decoration_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.avatar_decoration_path);
  const user = userById(req.user!.id, true)!; io.emit('user:update', user); return res.json({ user });
});

app.post('/api/me/profile-background', requireAuth, premiumImageUpload.single('image'), (req: AuthenticatedRequest, res: Response) => {
  if (!hasPremiumBenefit(req.user!.id, 'profileBackground')) { if (req.file) removeUploaded([req.file]); return fail(res, 403, 'Profile backgrounds are not included in your plan.'); }
  if (!req.file) return fail(res, 400, 'Select an image.');
  const nextPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT profile_background_path FROM users WHERE id = ?').get(req.user!.id) as any;
  db.prepare('UPDATE users SET profile_background_path = ? WHERE id = ?').run(nextPath, req.user!.id);
  removeUserUpload(old?.profile_background_path);
  const user = userById(req.user!.id, true)!; io.emit('user:update', user); return res.json({ user });
});

server.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
