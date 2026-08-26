import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '../..');
export const dataDir = path.join(rootDir, 'data');
export const backupDir = path.join(rootDir, 'backups');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

export const dbPath = path.join(dataDir, 'opencord.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  status_text TEXT NOT NULL DEFAULT '',
  avatar_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requester_id, addressee_id),
  CHECK(requester_id <> addressee_id)
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon_path TEXT,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(server_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#99aab5',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY(server_id, user_id, role_id),
  FOREIGN KEY(server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CATEGORY','TEXT','VOICE')),
  parent_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position, id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_pair_a ON direct_messages(sender_id, recipient_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_pair_b ON direct_messages(recipient_id, sender_id, id DESC);
`);

function hasColumn(table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

function addColumn(table: string, definition: string) {
  const name = definition.trim().split(/\s+/)[0];
  if (!hasColumn(table, name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migration(version: number, run: () => void) {
  const done = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
  if (done) return;
  db.transaction(() => {
    run();
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  })();
}

migration(1, () => {
  addColumn('users', "banner_path TEXT");
  addColumn('users', "presence TEXT NOT NULL DEFAULT 'online'");
  addColumn('users', 'is_instance_admin INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'disabled INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'last_seen_at TEXT');

  addColumn('servers', "description TEXT NOT NULL DEFAULT ''");
  addColumn('servers', 'banner_path TEXT');

  addColumn('roles', 'permissions INTEGER NOT NULL DEFAULT 0');
  addColumn('roles', 'position INTEGER NOT NULL DEFAULT 0');
  addColumn('roles', 'is_everyone INTEGER NOT NULL DEFAULT 0');

  addColumn('channels', "topic TEXT NOT NULL DEFAULT ''");
  addColumn('channels', 'user_limit INTEGER NOT NULL DEFAULT 0');
  addColumn('channels', 'bitrate INTEGER NOT NULL DEFAULT 64000');

  addColumn('messages', 'reply_to_id INTEGER');
  addColumn('messages', 'pinned INTEGER NOT NULL DEFAULT 0');
  addColumn('direct_messages', 'edited_at TEXT');
  addColumn('direct_messages', 'reply_to_id INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(blocker_id, blocked_id),
      CHECK(blocker_id <> blocked_id)
    );

    CREATE TABLE IF NOT EXISTS server_bans (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      moderator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS server_invites (
      code TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER,
      max_uses INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_invites_server ON server_invites(server_id);

    CREATE TABLE IF NOT EXISTS channel_permission_overwrites (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('ROLE','MEMBER')),
      target_id INTEGER NOT NULL,
      allow_permissions INTEGER NOT NULL DEFAULT 0,
      deny_permissions INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

    CREATE TABLE IF NOT EXISTS message_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS dm_reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      other_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, other_user_id)
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'MENTIONS' CHECK(level IN ('ALL','MENTIONS','NONE')),
      muted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, server_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs(server_id, id DESC);

    CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dm_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dm_thread_members (
      thread_id INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(thread_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS dm_thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      reply_to_id INTEGER,
      edited_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dm_thread_messages ON dm_thread_messages(thread_id, id DESC);
  `);

  const servers = db.prepare('SELECT id FROM servers').all() as Array<{ id: number }>;
  const DEFAULT_PERMISSIONS = 1 | 2 | 4 | 8 | 16 | 32;
  for (const server of servers) {
    const everyone = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_everyone = 1').get(server.id);
    if (!everyone) {
      db.prepare("INSERT INTO roles (server_id, name, color, permissions, position, is_everyone) VALUES (?, '@everyone', '#99aab5', ?, -1, 1)")
        .run(server.id, DEFAULT_PERMISSIONS);
    }
  }
});

migration(2, () => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(requester_id, addressee_id, status);
    CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id, server_id);
    CREATE INDEX IF NOT EXISTS idx_member_roles_user ON member_roles(server_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_bans_server ON server_bans(server_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(channel_id, content);
  `);
});

migration(3, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      icon TEXT NOT NULL DEFAULT '◆',
      color TEXT NOT NULL DEFAULT '#7289da',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_badges (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, badge_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id, badge_id);
  `);

  const seed = db.prepare('INSERT OR IGNORE INTO badges (name, icon, color, position) VALUES (?, ?, ?, ?)');
  seed.run('Administrator', '★', '#f04747', 100);
  seed.run('Staff', '◆', '#43b581', 90);
  seed.run('Developer', '⌘', '#7289da', 80);
  seed.run('Bug Hunter', '⚒', '#faa61a', 70);
  seed.run('Early User', '✦', '#9b59b6', 60);

  db.exec(`
    INSERT OR IGNORE INTO user_badges (user_id, badge_id, assigned_by)
    SELECT u.id, b.id, u.id
    FROM users u JOIN badges b ON b.name = 'Administrator'
    WHERE u.is_instance_admin = 1
  `);
});



migration(4, () => {
  addColumn('badges', 'image_path TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      expires_at INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at INTEGER,
      revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_instance_bans_user ON instance_bans(user_id, revoked_at, expires_at);

    CREATE TABLE IF NOT EXISTS instance_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_instance_audit_logs ON instance_audit_logs(id DESC);

    CREATE TABLE IF NOT EXISTS admin_user_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_user_notes_user ON admin_user_notes(user_id, id DESC);
  `);

  const defaults: Array<[string, string]> = [
    ['Administrator', '/badges/admin.svg'],
    ['Staff', '/badges/staff.svg'],
    ['Developer', '/badges/developer.svg'],
    ['Bug Hunter', '/badges/bug-hunter.svg'],
    ['Early User', '/badges/early-user.svg'],
  ];
  const update = db.prepare("UPDATE badges SET image_path = ? WHERE name = ? AND (image_path IS NULL OR image_path = '')");
  for (const [name, imagePath] of defaults) update.run(imagePath, name);
});


migration(5, () => {
  addColumn('users', "profile_theme TEXT NOT NULL DEFAULT ''");
  addColumn('users', "profile_gradient TEXT NOT NULL DEFAULT ''");
  addColumn('users', "profile_effect TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'avatar_decoration_path TEXT');
  addColumn('users', 'profile_background_path TEXT');
  addColumn('users', 'custom_join_sound_path TEXT');
  addColumn('users', "special_identity TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_premium (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      starts_at INTEGER NOT NULL,
      expires_at INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_user_premium_expires ON user_premium(expires_at);

    CREATE TABLE IF NOT EXISTS user_profile_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profile_history_user ON user_profile_history(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS server_profiles (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT,
      bio TEXT,
      avatar_path TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS premium_emojis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      image_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_premium_emojis_name ON premium_emojis(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS favorite_emojis (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, emoji_value)
    );
  `);

  const defaults: Array<[string, string]> = [
    ['premiumEnabled', 'true'],
    ['premiumName', 'Open+'],
    ['premiumDescription', 'Special benefits for this instance.'],
    ['premiumColor', '#f47fff'],
    ['premiumIcon', ''],
    ['premiumPriceLabel', 'Granted by the instance administration'],
    ['premiumDefaultDurationDays', '30'],
    ['premiumBenefits', JSON.stringify({
      animatedAvatar: true,
      animatedBanner: true,
      maxUploadMb: 50,
      externalEmojis: true,
      favoriteEmojiSlots: 100,
      screenShare1080p60: true,
      camera1080p60: true,
      customProfileTheme: true,
      premiumBadge: true,
      bioMaxLength: 600,
      maxServers: 100,
      maxDmGroups: 100,
      customJoinSound: true,
      profileEffects: true,
      avatarDecoration: true,
      profileBackground: true,
      externalReactions: true,
      maxFilesPerMessage: 10,
      priorityVoice: true,
      specialIdentity: true,
      perServerProfiles: true,
      premiumThemes: true,
      profileGradient: true,
      advancedStatus: true,
      profileHistoryDays: 90
    })],
  ];
  const seed = db.prepare('INSERT OR IGNORE INTO instance_settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) seed.run(key, value);
});



migration(6, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_premium (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      starts_at INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumn('user_premium', 'granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumn('user_premium', 'starts_at INTEGER NOT NULL DEFAULT 0');
  addColumn('user_premium', 'expires_at INTEGER');
  addColumn('user_premium', 'created_at TEXT');
  addColumn('user_premium', 'updated_at TEXT');

  db.exec(`
    DELETE FROM user_premium
    WHERE rowid NOT IN (SELECT MAX(rowid) FROM user_premium GROUP BY user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_premium_user_unique ON user_premium(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_premium_expires ON user_premium(expires_at);

    CREATE TABLE IF NOT EXISTS instance_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_instance_audit_logs ON instance_audit_logs(id DESC);
  `);

  db.prepare('UPDATE user_premium SET starts_at = ? WHERE starts_at IS NULL OR starts_at <= 0').run(Date.now());
  db.prepare("UPDATE user_premium SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL OR created_at = ''").run();
  db.prepare("UPDATE user_premium SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL OR updated_at = ''").run();
});

migration(7, () => {
  addColumn('users', 'terms_accepted_at INTEGER');
  addColumn('users', "terms_version TEXT NOT NULL DEFAULT ''");

  const legacyAdministratorBadge = Buffer.from('41646d696e6973747261646f72', 'hex').toString('utf8');
  const legacyDeveloperBadge = Buffer.from('446573656e766f6c7665646f72', 'hex').toString('utf8');
  db.prepare("UPDATE badges SET name = 'Administrator' WHERE name = ? AND NOT EXISTS (SELECT 1 FROM badges WHERE name = 'Administrator')").run(legacyAdministratorBadge);
  db.prepare("UPDATE badges SET name = 'Developer' WHERE name = ? AND NOT EXISTS (SELECT 1 FROM badges WHERE name = 'Developer')").run(legacyDeveloperBadge);
  const legacyPremiumDescription = Buffer.from('42656e6566c3ad63696f732065737065636961697320646573746120696e7374c3a26e6369612e', 'hex').toString('utf8');
  const legacyPremiumPriceLabel = Buffer.from('436f6e63656469646f2070656c612061646d696e6973747261c3a7c3a36f', 'hex').toString('utf8');
  db.prepare("UPDATE instance_settings SET value = 'Special benefits for this instance.' WHERE key = 'premiumDescription' AND value = ?").run(legacyPremiumDescription);
  db.prepare("UPDATE instance_settings SET value = 'Granted by the instance administration' WHERE key = 'premiumPriceLabel' AND value = ?").run(legacyPremiumPriceLabel);
});


migration(8, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS premium_redeem_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      code_prefix TEXT NOT NULL,
      duration_minutes INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      use_count INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_premium_redeem_codes_active ON premium_redeem_codes(disabled, use_count, max_uses);

    CREATE TABLE IF NOT EXISTS premium_redeem_usage (
      code_id INTEGER NOT NULL REFERENCES premium_redeem_codes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(code_id, user_id)
    );
  `);

  const defaults: Array<[string, string]> = [
    ['monetizationEnabled', 'false'],
    ['supportTitle', 'Support OpenCord'],
    ['supportDescription', 'Help fund development, maintenance, and infrastructure.'],
    ['supportUrl', ''],
    ['supportButtonLabel', 'Support the project'],
    ['premiumCheckoutUrl', ''],
    ['premiumCheckoutLabel', 'Get access'],
    ['managedHostingUrl', ''],
    ['managedHostingLabel', 'Managed hosting'],
  ];
  const seed = db.prepare('INSERT OR IGNORE INTO instance_settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) seed.run(key, value);
  db.prepare("UPDATE instance_settings SET value = 'OpenCord' WHERE key = 'name' AND value = ?").run(Buffer.from('4c6567616379436f7264', 'hex').toString('utf8'));
  db.prepare("UPDATE instance_settings SET value = 'Open+' WHERE key = 'premiumName' AND value = ?").run(Buffer.from('4c65676163792b', 'hex').toString('utf8'));
});

export type UserBadge = { id: number; name: string; imagePath: string | null };

export type PremiumBenefits = {
  animatedAvatar: boolean;
  animatedBanner: boolean;
  maxUploadMb: number;
  externalEmojis: boolean;
  favoriteEmojiSlots: number;
  screenShare1080p60: boolean;
  camera1080p60: boolean;
  customProfileTheme: boolean;
  premiumBadge: boolean;
  bioMaxLength: number;
  maxServers: number;
  maxDmGroups: number;
  customJoinSound: boolean;
  profileEffects: boolean;
  avatarDecoration: boolean;
  profileBackground: boolean;
  externalReactions: boolean;
  maxFilesPerMessage: number;
  priorityVoice: boolean;
  specialIdentity: boolean;
  perServerProfiles: boolean;
  premiumThemes: boolean;
  profileGradient: boolean;
  advancedStatus: boolean;
  profileHistoryDays: number;
};

export type PremiumMembership = {
  active: boolean;
  name: string;
  description: string;
  color: string;
  iconPath: string | null;
  expiresAt: number | null;
  benefits: PremiumBenefits;
};

export type PublicUser = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  statusText: string;
  avatarPath: string | null;
  bannerPath: string | null;
  profileTheme: string;
  profileGradient: string;
  profileEffect: string;
  avatarDecorationPath: string | null;
  profileBackgroundPath: string | null;
  customJoinSoundPath: string | null;
  specialIdentity: string;
  presence: 'online' | 'idle' | 'dnd' | 'invisible';
  createdAt: string;
  isInstanceAdmin?: boolean;
  badges: UserBadge[];
  premium: PremiumMembership | null;
};

export function userBadges(userId: number): UserBadge[] {
  return (db.prepare(`
    SELECT b.id, b.name, b.image_path
    FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ?
    ORDER BY b.position DESC, b.name COLLATE NOCASE
  `).all(userId) as any[]).map((badge) => ({
    id: Number(badge.id),
    name: String(badge.name),
    imagePath: badge.image_path ? String(badge.image_path) : null,
  }));
}


const defaultPremiumBenefits: PremiumBenefits = {
  animatedAvatar: true,
  animatedBanner: true,
  maxUploadMb: 50,
  externalEmojis: true,
  favoriteEmojiSlots: 100,
  screenShare1080p60: true,
  camera1080p60: true,
  customProfileTheme: true,
  premiumBadge: true,
  bioMaxLength: 600,
  maxServers: 100,
  maxDmGroups: 100,
  customJoinSound: true,
  profileEffects: true,
  avatarDecoration: true,
  profileBackground: true,
  externalReactions: true,
  maxFilesPerMessage: 10,
  priorityVoice: true,
  specialIdentity: true,
  perServerProfiles: true,
  premiumThemes: true,
  profileGradient: true,
  advancedStatus: true,
  profileHistoryDays: 90,
};

function setting(key: string, fallback: string) {
  const row = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function premiumBenefits(): PremiumBenefits {
  try {
    return { ...defaultPremiumBenefits, ...JSON.parse(setting('premiumBenefits', '{}')) };
  } catch {
    return { ...defaultPremiumBenefits };
  }
}

export function activePremiumForUser(userId: number, now = Date.now()): PremiumMembership | null {
  // Open+ is free for everyone
  return {
    active: true,
    name: setting('premiumName', 'Open+'),
    description: setting('premiumDescription', 'Special benefits for this instance.'),
    color: setting('premiumColor', '#f47fff'),
    iconPath: setting('premiumIcon', '') || null,
    expiresAt: null,
    benefits: premiumBenefits(),
  };
}

export function publicUser(row: any, includePrivate = false): PublicUser {
  const userId = Number(row.id);
  const presence = ['online', 'idle', 'dnd', 'invisible'].includes(String(row.presence)) ? row.presence : 'online';
  const premium = activePremiumForUser(userId);
  const benefits = premium?.benefits;
  return {
    id: userId,
    username: String(row.username),
    displayName: String(row.display_name),
    bio: String(row.bio ?? ''),
    statusText: String(row.status_text ?? ''),
    avatarPath: row.avatar_path ? String(row.avatar_path) : null,
    bannerPath: row.banner_path ? String(row.banner_path) : null,
    profileTheme: benefits?.customProfileTheme ? String(row.profile_theme ?? '') : '',
    profileGradient: benefits?.profileGradient ? String(row.profile_gradient ?? '') : '',
    profileEffect: benefits?.profileEffects ? String(row.profile_effect ?? '') : '',
    avatarDecorationPath: benefits?.avatarDecoration && row.avatar_decoration_path ? String(row.avatar_decoration_path) : null,
    profileBackgroundPath: benefits?.profileBackground && row.profile_background_path ? String(row.profile_background_path) : null,
    customJoinSoundPath: benefits?.customJoinSound && row.custom_join_sound_path ? String(row.custom_join_sound_path) : null,
    specialIdentity: benefits?.specialIdentity ? String(row.special_identity ?? '') : '',
    presence,
    createdAt: String(row.created_at ?? ''),
    ...(includePrivate ? { isInstanceAdmin: Boolean(row.is_instance_admin) } : {}),
    badges: userBadges(userId),
    premium,
  };
}

export type InstanceBan = {
  id: number;
  userId: number;
  moderatorId: number | null;
  reason: string;
  expiresAt: number | null;
  createdAt: string;
};

export function activeInstanceBan(userId: number, now = Date.now()): InstanceBan | null {
  const row = db.prepare(`
    SELECT id, user_id, moderator_id, reason, expires_at, created_at
    FROM instance_bans
    WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY id DESC LIMIT 1
  `).get(userId, now) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    moderatorId: row.moderator_id == null ? null : Number(row.moderator_id),
    reason: String(row.reason),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    createdAt: String(row.created_at),
  };
}

export function instanceAudit(actorId: number | null, action: string, targetType?: string, targetId?: number, details: Record<string, unknown> = {}) {
  db.prepare('INSERT INTO instance_audit_logs (actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(actorId, action, targetType ?? null, targetId ?? null, JSON.stringify(details));
}

export function createBackup(prefix = 'auto') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `${prefix}-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(destination);
  return destination;
}
