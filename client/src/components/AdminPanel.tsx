import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { Ban, ChevronDown, ChevronUp, Crown, DollarSign, Download, HardDrive, History, LogOut, RefreshCw, Search, Server, Settings, Shield, Sparkles, Trash2, Upload, Users } from 'lucide-react';
import { api } from '../lib/api';
import type { PremiumBenefits, User, UserBadge } from '../types';
import { Avatar } from './Avatar';
import { UserBadges } from './UserBadges';
import { ImageUploadField } from './ImageUploadField';

type AdminTab = 'overview' | 'users' | 'bans' | 'badges' | 'premium' | 'monetization' | 'servers' | 'audit' | 'settings' | 'backups';

type ActiveBan = {
  id: number;
  userId: number;
  moderatorId: number | null;
  reason: string;
  expiresAt: number | null;
  createdAt: string;
};

type AdminUser = User & {
  disabled: boolean;
  isInstanceAdmin: boolean;
  lastSeenAt: string | null;
  serverCount: number;
  messageCount: number;
  sessionCount: number;
  activeBan: ActiveBan | null;
};

type AdminBadge = UserBadge & {
  position: number;
  createdAt: string;
  assignmentCount: number;
};

type AdminStats = {
  users: number;
  disabledUsers: number;
  servers: number;
  messages: number;
  online: number;
  sessions: number;
  activeBans: number;
  uploadBytes: number;
  dataPath: string;
};

type AdminBan = {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarPath: string | null;
  moderatorId: number | null;
  moderatorName: string;
  reason: string;
  expiresAt: number | null;
  createdAt: string;
  revokedAt: number | null;
  revokedBy: number | null;
  revokedByName: string | null;
  revokeReason: string | null;
  active: boolean;
};

type AdminServer = {
  id: number;
  name: string;
  description: string;
  iconPath: string | null;
  bannerPath: string | null;
  ownerId: number;
  ownerUsername: string;
  ownerName: string;
  memberCount: number;
  channelCount: number;
  messageCount: number;
  createdAt: string;
};

type AuditLog = {
  id: number;
  actorId: number | null;
  actorName: string;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: number | null;
  details: Record<string, unknown>;
  createdAt: string;
};

type UserDetail = {
  user: AdminUser;
  sessions: Array<{ id: string; createdAt: number; expiresAt: number; active: boolean }>;
  servers: Array<{ id: number; name: string; iconPath: string | null; joinedAt: string }>;
  notes: Array<{ id: number; note: string; createdAt: string; authorId: number | null; authorName: string }>;
};

type InstanceSettings = {
  name: string;
  description: string;
  logo: string;
  registrationEnabled: boolean;
  maxServersPerUser: number;
  maxUploadMb: number;
};

type Backup = { name: string; size: number; modifiedAt: string };


type MonetizationConfig = {
  enabled: boolean;
  supportTitle: string;
  supportDescription: string;
  supportUrl: string;
  supportButtonLabel: string;
  premiumCheckoutUrl: string;
  premiumCheckoutLabel: string;
  managedHostingUrl: string;
  managedHostingLabel: string;
};



type PremiumRedeemCode = {
  id: number;
  prefix: string;
  durationMinutes: number | null;
  maxUses: number;
  useCount: number;
  disabled: boolean;
  createdAt: string;
};

type PremiumSubscriber = { userId: number; username: string; displayName: string; avatarPath: string | null; grantedBy: number | null; startsAt: number; expiresAt: number | null; active: boolean };
type PremiumConfig = {
  enabled: boolean;
  name: string;
  description: string;
  color: string;
  iconPath: string | null;
  priceLabel: string;
  defaultDurationDays: number;
  benefits: PremiumBenefits;
  subscribers: PremiumSubscriber[];
};

const defaultPremiumBenefits: PremiumBenefits = {
  animatedAvatar: true, animatedBanner: true, maxUploadMb: 50, externalEmojis: true, favoriteEmojiSlots: 100,
  screenShare1080p60: true, camera1080p60: true, customProfileTheme: true, premiumBadge: true, bioMaxLength: 600,
  maxServers: 100, maxDmGroups: 100, customJoinSound: true, profileEffects: true, avatarDecoration: true, profileBackground: true,
  externalReactions: true, maxFilesPerMessage: 10, priorityVoice: true, specialIdentity: true, perServerProfiles: true,
  premiumThemes: true, profileGradient: true, advancedStatus: true, profileHistoryDays: 90,
};


const actionNames: Record<string, string> = {
  USER_DISABLE: 'Account disabled', USER_ENABLE: 'Account enabled', ADMIN_GRANT: 'Administrator granted', ADMIN_REVOKE: 'Administrator revoked',
  USER_FORCE_LOGOUT: 'Sessions ended', SESSION_REVOKE: 'Session revoked', USER_DELETE: 'Account deleted', USER_NOTE_ADD: 'Note added',
  USER_NOTE_DELETE: 'Note removed', USER_BAN: 'User banned', USER_UNBAN: 'Ban revoked', BADGE_CREATE: 'Badge created',
  BADGE_UPDATE: 'Badge updated', BADGE_DELETE: 'Badge deleted', BADGE_REORDER: 'Badges reordered', USER_BADGES_UPDATE: 'User badges updated',
  SERVER_DELETE: 'Server deleted', INSTANCE_SETTINGS_UPDATE: 'Settings updated', INSTANCE_LOGO_UPDATE: 'Logo updated', PREMIUM_SETTINGS_UPDATE: 'Premium plan updated', PREMIUM_ICON_UPDATE: 'Plan icon updated', PREMIUM_GRANT: 'Plan granted', PREMIUM_REVOKE: 'Plan removed', MONETIZATION_SETTINGS_UPDATE: 'Monetization updated', PREMIUM_CODE_CREATE: 'Premium code created', PREMIUM_CODE_DISABLE: 'Premium code disabled', PREMIUM_CODE_REDEEM: 'Premium code redeemed', BACKUP_CREATE: 'Backup created', BACKUP_DELETE: 'Backup deleted',
};

function dateTime(value: string | number | null | undefined) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US');
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function banExpiryLabel(ban: { expiresAt: number | null }) {
  return ban.expiresAt == null ? 'Permanent' : `Until ${dateTime(ban.expiresAt)}`;
}

export function AdminPanel({ notify }: { notify: (message: string) => void }) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);
  const [badges, setBadges] = useState<AdminBadge[]>([]);
  const [bans, setBans] = useState<AdminBan[]>([]);
  const [showOnlyActiveBans, setShowOnlyActiveBans] = useState(true);
  const [servers, setServers] = useState<AdminServer[]>([]);
  const [serverQuery, setServerQuery] = useState('');
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [settings, setSettings] = useState<InstanceSettings>({ name: 'OpenCord', description: '', logo: '', registrationEnabled: true, maxServersPerUser: 20, maxUploadMb: 15 });
  const [premium, setPremium] = useState<PremiumConfig>({ enabled: true, name: 'Open+', description: '', color: '#f47fff', iconPath: null, priceLabel: 'Granted by the instance administration', defaultDurationDays: 30, benefits: defaultPremiumBenefits, subscribers: [] });
  const [monetization, setMonetization] = useState<MonetizationConfig>({ enabled: false, supportTitle: 'Support OpenCord', supportDescription: 'Help fund development, maintenance, and infrastructure.', supportUrl: '', supportButtonLabel: 'Support the project', premiumCheckoutUrl: '', premiumCheckoutLabel: 'Get access', managedHostingUrl: '', managedHostingLabel: 'Managed hosting' });
  const [redeemCodes, setRedeemCodes] = useState<PremiumRedeemCode[]>([]);
  const [newRedeemCode, setNewRedeemCode] = useState('');
  const [backups, setBackups] = useState<Backup[]>([]);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Administrative operation failed.'); }
    finally { setBusy(false); }
  };

  const loadStats = async () => setStats(await api<AdminStats>('/api/admin/stats'));
  const loadUsers = async (query = userQuery) => setUsers((await api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(query)}`)).users);
  const loadUserDetail = async (userId: number) => {
    setSelectedUserId(userId);
    setUserDetail(await api<UserDetail>(`/api/admin/users/${userId}`));
  };
  const loadBadges = async () => setBadges((await api<{ badges: AdminBadge[] }>('/api/admin/badges')).badges);
  const loadBans = async () => setBans((await api<{ bans: AdminBan[] }>(`/api/admin/bans${showOnlyActiveBans ? '?active=true' : ''}`)).bans);
  const loadServers = async (query = serverQuery) => setServers((await api<{ servers: AdminServer[] }>(`/api/admin/servers?q=${encodeURIComponent(query)}`)).servers);
  const loadAudit = async () => setLogs((await api<{ logs: AuditLog[] }>('/api/admin/audit?limit=200')).logs);
  const loadSettings = async () => setSettings(await api<InstanceSettings>('/api/admin/settings'));
  const loadPremium = async () => setPremium(await api<PremiumConfig>('/api/admin/premium'));
  const loadMonetization = async () => { const [config, codeData] = await Promise.all([api<MonetizationConfig>('/api/admin/monetization'), api<{ codes: PremiumRedeemCode[] }>('/api/admin/monetization/codes')]); setMonetization(config); setRedeemCodes(codeData.codes); };
  const loadBackups = async () => setBackups((await api<{ backups: Backup[] }>('/api/admin/backups')).backups);

  const refreshCurrent = async () => {
    await loadStats();
    if (tab === 'users') { await loadUsers(); if (selectedUserId) await loadUserDetail(selectedUserId); }
    if (tab === 'bans') await loadBans();
    if (tab === 'badges') await loadBadges();
    if (tab === 'premium') await loadPremium();
    if (tab === 'monetization') await loadMonetization();
    if (tab === 'servers') await loadServers();
    if (tab === 'audit') await loadAudit();
    if (tab === 'settings') await loadSettings();
    if (tab === 'backups') await loadBackups();
  };

  useEffect(() => { void withBusy(async () => { await Promise.all([loadStats(), loadBadges()]); }); }, []);
  useEffect(() => {
    void withBusy(async () => {
      if (tab === 'users') await loadUsers();
      else if (tab === 'bans') await loadBans();
      else if (tab === 'badges') await loadBadges();
      else if (tab === 'premium') await loadPremium();
      else if (tab === 'monetization') await loadMonetization();
      else if (tab === 'servers') await loadServers();
      else if (tab === 'audit') await loadAudit();
      else if (tab === 'settings') await loadSettings();
      else if (tab === 'backups') await loadBackups();
    });
  }, [tab, showOnlyActiveBans]);

  const setUserBadge = async (badgeId: number, checked: boolean) => {
    if (!userDetail) return;
    const ids = new Set(userDetail.user.badges.map((badge) => badge.id));
    if (checked) ids.add(badgeId); else ids.delete(badgeId);
    await withBusy(async () => {
      await api(`/api/admin/users/${userDetail.user.id}/badges`, { method: 'PUT', body: JSON.stringify({ badgeIds: [...ids] }) });
      await Promise.all([loadUserDetail(userDetail.user.id), loadUsers(), loadBadges()]);
      notify('Badges updated.');
    });
  };

  const createBadge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withBusy(async () => {
      await api('/api/admin/badges', { method: 'POST', body: new FormData(form) });
      form.reset();
      await loadBadges();
      notify('Badge created.');
    });
  };

  const updateBadge = async (event: FormEvent<HTMLFormElement>, badgeId: number) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withBusy(async () => {
      await api(`/api/admin/badges/${badgeId}`, { method: 'PUT', body: new FormData(form) });
      form.reset();
      await loadBadges();
      notify('Badge updated.');
    });
  };

  const reorderBadge = async (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= badges.length) return;
    const next = [...badges];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    await withBusy(async () => {
      await api('/api/admin/badges/reorder', { method: 'POST', body: JSON.stringify({ ids: next.map((badge) => badge.id) }) });
      await loadBadges();
    });
  };

  const banUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!userDetail) return;
    const form = new FormData(event.currentTarget);
    const preset = String(form.get('duration') ?? 'permanent');
    let durationMinutes: number | null = null;
    if (preset === 'custom') durationMinutes = Math.max(1, Number(form.get('customMinutes') ?? 1));
    else if (preset !== 'permanent') durationMinutes = Number(preset);
    const reason = String(form.get('reason') ?? '').trim();
    await withBusy(async () => {
      await api(`/api/admin/users/${userDetail.user.id}/ban`, { method: 'POST', body: JSON.stringify({ reason, durationMinutes }) });
      await Promise.all([loadUserDetail(userDetail.user.id), loadUsers(), loadBans(), loadStats()]);
      notify('User banned.');
    });
  };

  const revokeBan = async (ban: AdminBan) => {
    const reason = window.prompt('Revocation reason (optional):', '') ?? '';
    await withBusy(async () => {
      await api(`/api/admin/bans/${ban.id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
      await Promise.all([loadBans(), loadStats(), loadUsers()]);
      if (selectedUserId === ban.userId) await loadUserDetail(ban.userId);
      notify('Ban revoked.');
    });
  };

  const toggleDisabled = async (user: AdminUser) => {
    const reason = window.prompt(user.disabled ? 'Reactivation reason (optional):' : 'Deactivation reason (optional):', '') ?? '';
    await withBusy(async () => {
      await api(`/api/admin/users/${user.id}/disabled`, { method: 'PUT', body: JSON.stringify({ disabled: !user.disabled, reason }) });
      await Promise.all([loadUsers(), loadStats()]);
      await loadUserDetail(user.id);
      notify(user.disabled ? 'Account enabled.' : 'Account disabled.');
    });
  };

  const toggleAdmin = async (user: AdminUser) => {
    if (!window.confirm(`${user.isInstanceAdmin ? 'Remove' : 'Grant'} administrator access for @${user.username}?`)) return;
    await withBusy(async () => {
      await api(`/api/admin/users/${user.id}/admin`, { method: 'PUT', body: JSON.stringify({ isAdmin: !user.isInstanceAdmin }) });
      await Promise.all([loadUsers(), loadBadges()]);
      await loadUserDetail(user.id);
      notify(user.isInstanceAdmin ? 'Administrator access revoked.' : 'Administrator access granted.');
    });
  };

  const forceLogout = async (user: AdminUser) => {
    if (!window.confirm(`End all sessions for @${user.username}?`)) return;
    await withBusy(async () => {
      await api(`/api/admin/users/${user.id}/logout`, { method: 'POST' });
      await Promise.all([loadUsers(), loadUserDetail(user.id), loadStats()]);
      notify('Sessions ended.');
    });
  };

  const deleteUser = async (user: AdminUser) => {
    const confirmation = window.prompt(`This action is permanent. Type ${user.username} to confirm:`);
    if (confirmation == null) return;
    const reason = window.prompt('Deletion reason:', 'Rules violation')?.trim();
    if (!reason) return notify('A deletion reason is required.');
    await withBusy(async () => {
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE', body: JSON.stringify({ confirmation, reason }) });
      setSelectedUserId(null);
      setUserDetail(null);
      await Promise.all([loadUsers(), loadStats()]);
      notify('Account permanently deleted.');
    });
  };

  const addNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!userDetail) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    await withBusy(async () => {
      await api(`/api/admin/users/${userDetail.user.id}/notes`, { method: 'POST', body: JSON.stringify({ note: String(data.get('note') ?? '') }) });
      form.reset();
      await loadUserDetail(userDetail.user.id);
      notify('Note added.');
    });
  };

  const downloadBackup = async (backup: Backup) => {
    await withBusy(async () => {
      const response = await fetch(`/api/admin/backups/${encodeURIComponent(backup.name)}/download`, { credentials: 'include' });
      if (!response.ok) throw new Error('Could not download the backup.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = backup.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    });
  };


  const changePremiumForUser = async (user: AdminUser, active: boolean) => {
    let durationMinutes: number | null = null;
    if (active) {
      const defaultValue = premium.defaultDurationDays > 0 ? String(premium.defaultDurationDays) : '';
      const raw = window.prompt(`Duration do ${premium.name} in days. Leave empty for permanent:`, defaultValue);
      if (raw === null) return;
      const normalized = raw.trim().replace(',', '.');
      if (normalized) {
        const days = Number(normalized);
        if (!Number.isFinite(days) || days <= 0 || days > 3650) return notify('Invalid duration. Use up to 3650 days or leave it empty for permanent.');
        const minutes = Math.round(days * 1440);
        if (!Number.isInteger(minutes) || minutes < 1) return notify('Invalid duration.');
        durationMinutes = minutes;
      }
    }

    await withBusy(async () => {
      await api(`/api/admin/users/${user.id}/premium`, {
        method: 'PUT',
        body: JSON.stringify({ active, durationMinutes }),
      });

      const refreshes = [loadUserDetail(user.id), loadUsers(), loadPremium(), loadStats()];
      const results = await Promise.allSettled(refreshes);
      if (results.some((result) => result.status === 'rejected')) {
        console.warn('[Admin] Plan updated, but one view could not be refreshed.', results);
      }
      notify(active ? `${premium.name} granted successfully.` : `${premium.name} removed successfully.`);
    });
  };

  const updatePremiumBenefit = <K extends keyof PremiumBenefits>(key: K, value: PremiumBenefits[K]) => {
    setPremium((current) => ({ ...current, benefits: { ...current.benefits, [key]: value } }));
  };

  const tabs: Array<{ id: AdminTab; label: string; icon: ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <Shield size={15} /> },
    { id: 'users', label: 'Users', icon: <Users size={15} /> },
    { id: 'bans', label: 'Bans', icon: <Ban size={15} /> },
    { id: 'badges', label: 'Badges', icon: <Crown size={15} /> },
    { id: 'premium', label: 'Premium plan', icon: <Sparkles size={15} /> },
    { id: 'monetization', label: 'Monetization', icon: <DollarSign size={15} /> },
    { id: 'servers', label: 'Servers', icon: <Server size={15} /> },
    { id: 'audit', label: 'Audit', icon: <History size={15} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={15} /> },
    { id: 'backups', label: 'Backups', icon: <HardDrive size={15} /> },
  ];

  return <div className="admin-panel-v3">
    <div className="admin-panel-header">
      <div><h2>Administration Panel</h2><p>Manage the entire OpenCord instance.</p></div>
      <button type="button" className="icon-button" disabled={busy} onClick={() => void withBusy(refreshCurrent)} title="Update"><RefreshCw size={17} /></button>
    </div>

    <div className="admin-subnav">{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.icon}{item.label}</button>)}</div>

    {tab === 'overview' && <section className="admin-view">
      {stats && <>
        <div className="admin-stat-grid">
          <div><strong>{stats.users}</strong><span>Users</span></div><div><strong>{stats.online}</strong><span>Online</span></div><div><strong>{stats.servers}</strong><span>Servers</span></div><div><strong>{stats.messages}</strong><span>Messages</span></div>
          <div><strong>{stats.activeBans}</strong><span>Active bans</span></div><div><strong>{stats.sessions}</strong><span>Sessions</span></div><div><strong>{stats.disabledUsers}</strong><span>Disabled</span></div><div><strong>{bytes(stats.uploadBytes)}</strong><span>Uploads</span></div>
        </div>
        <div className="admin-info-card"><strong>Database</strong><span>{stats.dataPath}</span></div>
      </>}
    </section>}

    {tab === 'users' && <section className="admin-view">
      <form className="admin-search" onSubmit={(event) => { event.preventDefault(); void withBusy(() => loadUsers(userQuery)); }}><Search size={16} /><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="Search by ID, username, or display name" /><button className="secondary-button small">Search</button></form>
      <div className="admin-split">
        <div className="admin-list">
          {users.map((user) => <button type="button" key={user.id} className={`admin-user-list-row ${selectedUserId === user.id ? 'active' : ''}`} onClick={() => void withBusy(() => loadUserDetail(user.id))}>
            <Avatar user={user} size={36} /><div><strong>{user.displayName}</strong><span>@{user.username} · ID {user.id}</span><UserBadges badges={user.badges} compact /></div>
            <div className="admin-row-tags">{user.isInstanceAdmin && <b>ADMIN</b>}{user.activeBan && <b className="red">BAN</b>}{user.disabled && <b className="muted">OFF</b>}</div>
          </button>)}
          {!users.length && <div className="admin-empty">No users found.</div>}
        </div>

        <div className="admin-detail">
          {!userDetail ? <div className="admin-empty">Select a user to manage.</div> : <>
            <div className="admin-user-heading"><Avatar user={userDetail.user} size={58} /><div><h3>{userDetail.user.displayName}</h3><span>@{userDetail.user.username} · ID {userDetail.user.id}</span><UserBadges badges={userDetail.user.badges} /></div></div>
            <div className="admin-mini-stats"><span><b>{userDetail.user.serverCount ?? userDetail.servers.length}</b> servers</span><span><b>{userDetail.user.messageCount ?? 0}</b> messages</span><span><b>{userDetail.sessions.filter((session) => session.active).length}</b> sessions</span><span>Last seen: {dateTime(userDetail.user.lastSeenAt)}</span></div>

            {userDetail.user.activeBan && <div className="admin-ban-alert"><strong>Active ban · {banExpiryLabel(userDetail.user.activeBan)}</strong><span>{userDetail.user.activeBan.reason}</span></div>}

            <div className="admin-action-grid">
              <button type="button" className="secondary-button small" onClick={() => void forceLogout(userDetail.user)}><LogOut size={14} /> End sessions</button>
              <button type="button" className="secondary-button small" onClick={() => void toggleAdmin(userDetail.user)}><Crown size={14} /> {userDetail.user.isInstanceAdmin ? 'Revoke admin' : 'Grant admin'}</button>
              <button type="button" className={userDetail.user.disabled ? 'secondary-button small' : 'danger-button small'} onClick={() => void toggleDisabled(userDetail.user)}>{userDetail.user.disabled ? 'Enable account' : 'Disable account'}</button>
              <button type="button" className="danger-button small" onClick={() => void deleteUser(userDetail.user)}><Trash2 size={14} /> Delete account</button>
            </div>

            {!userDetail.user.activeBan && !userDetail.user.isInstanceAdmin && <form className="admin-ban-form" onSubmit={banUser}>
              <h4>Ban user</h4>
              <textarea name="reason" required maxLength={500} placeholder="Ban reason" />
              <div><select name="duration" defaultValue="1440"><option value="60">1 hour</option><option value="360">6 hours</option><option value="1440">1 day</option><option value="10080">7 days</option><option value="43200">30 days</option><option value="permanent">Permanent</option><option value="custom">Custom</option></select><input name="customMinutes" type="number" min="1" max="5256000" placeholder="Minutes (for custom duration)" /></div>
              <button className="danger-button small"><Ban size={14} /> Apply ban</button>
            </form>}

            <div className="admin-detail-section"><h4>Badges</h4><div className="admin-badge-assignment">
              {badges.map((badge) => <label key={badge.id}><input type="checkbox" checked={userDetail.user.badges.some((item) => item.id === badge.id)} onChange={(event) => void setUserBadge(badge.id, event.target.checked)} /><img src={badge.imagePath || '/badges/default.svg'} alt="" /><span>{badge.name}</span></label>)}
              {!badges.length && <span>No badges created.</span>}
            </div></div>

            <div className="admin-detail-section"><h4>{premium.name}</h4>
              {userDetail.user.premium ? <div className="admin-premium-user-card"><div>{premium.iconPath && <img src={premium.iconPath} alt="" />}<div><strong>{premium.name} active</strong><span>{userDetail.user.premium.expiresAt ? `Until ${dateTime(userDetail.user.premium.expiresAt)}` : 'Permanent'}</span></div></div><button type="button" className="danger-button small" onClick={() => void changePremiumForUser(userDetail.user, false)}>Remove</button></div>
              : <button type="button" className="primary-button small" onClick={() => void changePremiumForUser(userDetail.user, true)}><Sparkles size={14} /> Grant {premium.name}</button>}
            </div>

            <div className="admin-detail-section"><h4>Sessions</h4>{userDetail.sessions.map((session) => <div className="admin-row" key={session.id}><div><strong>{session.id.slice(0, 12)}…</strong><span>Created {dateTime(session.createdAt)} · expires {dateTime(session.expiresAt)}</span></div><button type="button" className="secondary-button small" disabled={!session.active} onClick={() => void withBusy(async () => { await api(`/api/admin/sessions/${session.id}`, { method: 'DELETE' }); await Promise.all([loadUserDetail(userDetail.user.id), loadUsers(), loadStats()]); })}>{session.active ? 'Revoke' : 'Expired'}</button></div>)}</div>

            <div className="admin-detail-section"><h4>Servers</h4>{userDetail.servers.map((server) => <div className="admin-row" key={server.id}><div><strong>{server.name}</strong><span>ID {server.id} · joined {dateTime(server.joinedAt)}</span></div></div>)}{!userDetail.servers.length && <span className="admin-muted">No servers.</span>}</div>

            <div className="admin-detail-section"><h4>Administrative notes</h4><form className="admin-note-form" onSubmit={addNote}><textarea name="note" maxLength={1000} required placeholder="Private note visible only to instance administrators" /><button className="secondary-button small">Add note</button></form>{userDetail.notes.map((note) => <div className="admin-note" key={note.id}><div><strong>{note.authorName}</strong><span>{dateTime(note.createdAt)}</span></div><p>{note.note}</p><button type="button" className="danger-icon" onClick={() => void withBusy(async () => { await api(`/api/admin/notes/${note.id}`, { method: 'DELETE' }); await loadUserDetail(userDetail.user.id); })}><Trash2 size={14} /></button></div>)}</div>
          </>}
        </div>
      </div>
    </section>}

    {tab === 'bans' && <section className="admin-view">
      <label className="toggle-row admin-filter"><input type="checkbox" checked={showOnlyActiveBans} onChange={(event) => setShowOnlyActiveBans(event.target.checked)} /> Show active bans only</label>
      <div className="admin-table-list">{bans.map((ban) => <div className={`admin-ban-row ${ban.active ? 'active' : ''}`} key={ban.id}><div><strong>{ban.displayName} <span>@{ban.username}</span></strong><p>{ban.reason}</p><small>Applied by {ban.moderatorName} · {dateTime(ban.createdAt)} · {banExpiryLabel(ban)}</small>{ban.revokedAt && <small>Revoked by {ban.revokedByName ?? 'Administrator revoked'} at {dateTime(ban.revokedAt)}{ban.revokeReason ? ` · ${ban.revokeReason}` : ''}</small>}</div>{ban.active && <button type="button" className="secondary-button small" onClick={() => void revokeBan(ban)}>Revoke ban</button>}</div>)}{!bans.length && <div className="admin-empty">No bans in this view.</div>}</div>
    </section>}

    {tab === 'badges' && <section className="admin-view">
      <div className="admin-section-heading"><div><h3>Instance badges</h3><p>Images up to 1 MB. Profiles show only the icon; the badge name appears on hover.</p></div></div>
      <form className="admin-badge-create" onSubmit={createBadge}><input name="name" maxLength={32} placeholder="Badge name" required /><ImageUploadField name="image" label="BADGE IMAGE" required /><button className="primary-button">Create badge</button></form>
      <div className="admin-badge-grid">{badges.map((badge, index) => <div className="admin-badge-card" key={badge.id}>
        <div className="admin-badge-preview"><UserBadges badges={[badge]} /><div><strong>{badge.name}</strong><span>{badge.assignmentCount} user(s)</span></div></div>
        <form onSubmit={(event) => updateBadge(event, badge.id)}><input name="name" defaultValue={badge.name} maxLength={32} required /><ImageUploadField name="image" label="REPLACE IMAGE" currentUrl={badge.imagePath} /><button className="secondary-button small">Save</button></form>
        <div className="admin-badge-card-actions"><button type="button" className="icon-button" disabled={index === 0} onClick={() => void reorderBadge(index, -1)} title="Move up"><ChevronUp size={15} /></button><button type="button" className="icon-button" disabled={index === badges.length - 1} onClick={() => void reorderBadge(index, 1)} title="Move down"><ChevronDown size={15} /></button><button type="button" className="danger-icon" title="Delete" onClick={() => { if (!window.confirm(`Delete a badge ${badge.name}?`)) return; void withBusy(async () => { await api(`/api/admin/badges/${badge.id}`, { method: 'DELETE' }); await Promise.all([loadBadges(), loadUsers()]); notify('Badge deleted.'); }); }}><Trash2 size={15} /></button></div>
      </div>)}</div>
    </section>}

    {tab === 'premium' && <section className="admin-view premium-admin-view">
      <div className="admin-section-heading"><div><h3>Premium plan</h3><p>Name, identity, and benefits are fully controlled by the instance administration.</p></div></div>
      <div className="premium-admin-grid">
        <form className="form-stack settings-card-column" onSubmit={(event) => { event.preventDefault(); void withBusy(async () => { await api('/api/admin/premium', { method: 'PUT', body: JSON.stringify({ enabled: premium.enabled, name: premium.name, description: premium.description, color: premium.color, priceLabel: premium.priceLabel, defaultDurationDays: premium.defaultDurationDays, benefits: premium.benefits }) }); await loadPremium(); notify('Premium plan updated.'); }); }}>
          <h3>Identity</h3>
          <label className="toggle-row"><input type="checkbox" checked={premium.enabled} onChange={(event) => setPremium({ ...premium, enabled: event.target.checked })} /> System enabled</label>
          <label>NAME<input maxLength={40} value={premium.name} onChange={(event) => setPremium({ ...premium, name: event.target.value })} /></label>
          <label>DESCRIPTION<textarea maxLength={240} value={premium.description} onChange={(event) => setPremium({ ...premium, description: event.target.value })} /></label>
          <label>COLOR<input type="color" value={premium.color} onChange={(event) => setPremium({ ...premium, color: event.target.value })} /></label><label>PRICE / DISPLAY TEXT<input maxLength={80} value={premium.priceLabel} onChange={(event) => setPremium({ ...premium, priceLabel: event.target.value })} /></label><label>DEFAULT DURATION (DAYS)<input type="number" min="0" max="3650" value={premium.defaultDurationDays} onChange={(event) => setPremium({ ...premium, defaultDurationDays: Number(event.target.value) })} /><small>0 = permanent</small></label>
          <button className="primary-button">Save plan</button>
        </form>
        <form className="form-stack settings-card-column" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void withBusy(async () => { const result = await api<{ iconPath: string }>('/api/admin/premium/icon', { method: 'POST', body: new FormData(form) }); setPremium({ ...premium, iconPath: result.iconPath }); form.reset(); notify('Icon updated.'); }); }}>
          <h3>Icon</h3>{premium.iconPath ? <img className="premium-admin-icon" src={premium.iconPath} alt="" /> : <div className="premium-admin-icon placeholder"><Sparkles /></div>}
          <ImageUploadField name="icon" label="PLAN ICON" currentUrl={premium.iconPath} accept="image/png,image/jpeg,image/webp,image/gif" required /><button className="secondary-button">Upload icon</button>
        </form>
      </div>
      <form className="premium-benefits" onSubmit={(event) => { event.preventDefault(); void withBusy(async () => { await api('/api/admin/premium', { method: 'PUT', body: JSON.stringify({ enabled: premium.enabled, name: premium.name, description: premium.description, color: premium.color, priceLabel: premium.priceLabel, defaultDurationDays: premium.defaultDurationDays, benefits: premium.benefits }) }); await loadPremium(); notify('Benefits updated.'); }); }}>
        <h3>Benefits</h3><p>The toggles and limits below are enforced by the backend for users with an active membership.</p>
        <div className="premium-benefit-grid">
          {([
            ['animatedAvatar','Animated avatar'],['animatedBanner','Animated banner'],['externalEmojis','External emojis'],['screenShare1080p60','1080p/60 screen sharing'],['camera1080p60','1080p/60 camera'],['customProfileTheme','Profile theme'],['premiumBadge','Premium icon on profile'],['customJoinSound','Custom join sound'],['profileEffects','Profile effects'],['avatarDecoration','Avatar decoration'],['profileBackground','Profile background'],['externalReactions','External reactions'],['priorityVoice','Priority in full voice channels'],['specialIdentity','Special identity'],['perServerProfiles','Per-server profiles'],['premiumThemes','Premium themes'],['profileGradient','Profile gradient'],['advancedStatus','Advanced status']
          ] as Array<[keyof PremiumBenefits,string]>).map(([key,label]) => <label className="toggle-row premium-benefit-toggle" key={key}><input type="checkbox" checked={Boolean(premium.benefits[key])} onChange={(event) => updatePremiumBenefit(key, event.target.checked as PremiumBenefits[typeof key])} /> {label}</label>)}
        </div>
        <div className="premium-limit-grid">
          {([
            ['maxUploadMb','Maximum upload (MB)',1,500],['favoriteEmojiSlots','Favorite emoji slots',0,1000],['bioMaxLength','Bio character limit',190,4000],['maxServers','Created servers',0,5000],['maxDmGroups','DM groups',0,5000],['maxFilesPerMessage','Files per message',1,10],['profileHistoryDays','Profile history (days)',0,3650]
          ] as Array<[keyof PremiumBenefits,string,number,number]>).map(([key,label,min,max]) => <label key={key}>{label}<input type="number" min={min} max={max} value={Number(premium.benefits[key])} onChange={(event) => updatePremiumBenefit(key, Number(event.target.value) as PremiumBenefits[typeof key])} /></label>)}
        </div>
        <button className="primary-button">Save benefits</button>
      </form>
      <div className="admin-detail-section"><h4>Subscriptions</h4><div className="admin-table-list">{premium.subscribers.map((subscriber) => <div className="admin-backup-row" key={subscriber.userId}><div><strong>{subscriber.displayName} <span>@{subscriber.username}</span></strong><span>{subscriber.active ? (subscriber.expiresAt ? `Active until ${dateTime(subscriber.expiresAt)}` : 'Active permanently') : 'Expired'}</span></div><button className="danger-button small" type="button" onClick={() => void withBusy(async () => { await api(`/api/admin/users/${subscriber.userId}/premium`, { method: 'PUT', body: JSON.stringify({ active: false }) }); await loadPremium(); notify('Membership removed.'); })}>Remove</button></div>)}{!premium.subscribers.length && <div className="admin-empty">No memberships granted.</div>}</div></div>
    </section>}


    {tab === 'monetization' && <section className="admin-view">
      <div className="admin-section-heading"><div><h3>Monetization</h3><p>Connect OpenCord to external checkout, sponsorship, donation, or managed-hosting pages without storing payment data in this application.</p></div></div>
      <form className="form-stack settings-card-column" onSubmit={(event) => { event.preventDefault(); void withBusy(async () => { await api('/api/admin/monetization', { method: 'PUT', body: JSON.stringify(monetization) }); notify('Monetization settings saved.'); await loadMonetization(); }); }}>
        <label className="toggle-row"><input type="checkbox" checked={monetization.enabled} onChange={(event) => setMonetization({ ...monetization, enabled: event.target.checked })} /> Show monetization options to users</label>
        <div className="monetization-admin-grid">
          <div className="monetization-admin-card"><h4>Project support</h4><label>TITLE<input maxLength={60} value={monetization.supportTitle} onChange={(event) => setMonetization({ ...monetization, supportTitle: event.target.value })} /></label><label>DESCRIPTION<textarea maxLength={240} value={monetization.supportDescription} onChange={(event) => setMonetization({ ...monetization, supportDescription: event.target.value })} /></label><label>SUPPORT URL<input type="url" maxLength={500} placeholder="https://..." value={monetization.supportUrl} onChange={(event) => setMonetization({ ...monetization, supportUrl: event.target.value })} /></label><label>BUTTON LABEL<input maxLength={40} value={monetization.supportButtonLabel} onChange={(event) => setMonetization({ ...monetization, supportButtonLabel: event.target.value })} /></label></div>
          <div className="monetization-admin-card"><h4>Premium checkout</h4><p>Point this to a Stripe Payment Link, store page, Patreon tier, Ko-fi page, or your own billing frontend.</p><label>CHECKOUT URL<input type="url" maxLength={500} placeholder="https://..." value={monetization.premiumCheckoutUrl} onChange={(event) => setMonetization({ ...monetization, premiumCheckoutUrl: event.target.value })} /></label><label>BUTTON LABEL<input maxLength={40} value={monetization.premiumCheckoutLabel} onChange={(event) => setMonetization({ ...monetization, premiumCheckoutLabel: event.target.value })} /></label></div>
          <div className="monetization-admin-card"><h4>Managed hosting</h4><p>Optionally advertise a paid hosting/setup service for people who do not want to self-host.</p><label>HOSTING URL<input type="url" maxLength={500} placeholder="https://..." value={monetization.managedHostingUrl} onChange={(event) => setMonetization({ ...monetization, managedHostingUrl: event.target.value })} /></label><label>BUTTON LABEL<input maxLength={40} value={monetization.managedHostingLabel} onChange={(event) => setMonetization({ ...monetization, managedHostingLabel: event.target.value })} /></label></div>
        </div>
        <div className="admin-info-card"><strong>Payment handling</strong><span>OpenCord only displays the URLs you configure. Payments, refunds, taxes, subscription renewal, and fulfillment remain the responsibility of the external provider or your own billing system.</span></div>
        <button className="primary-button">Save monetization</button>
      </form>
      <section className="settings-card-column redeem-code-admin"><div className="admin-section-heading"><div><h3>Premium redemption codes</h3><p>Generate codes that can be sold or distributed through your external checkout. The complete code is shown only once after creation.</p></div></div>
        <form className="redeem-code-create" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void withBusy(async () => { const result = await api<{ id: number; code: string }>('/api/admin/monetization/codes', { method: 'POST', body: JSON.stringify({ durationDays: Number(form.get('durationDays') ?? 30), maxUses: Number(form.get('maxUses') ?? 1) }) }); setNewRedeemCode(result.code); await loadMonetization(); notify('Redemption code created. Copy it now; only its prefix is stored for display.'); }); }}><label>MEMBERSHIP DURATION (DAYS)<input name="durationDays" type="number" min="0" max="3650" defaultValue="30" required /><small>0 = permanent</small></label><label>MAXIMUM USES<input name="maxUses" type="number" min="1" max="1000" defaultValue="1" required /></label><button className="secondary-button">Generate code</button></form>
        {newRedeemCode && <div className="redeem-code-secret"><div><strong>New code</strong><code>{newRedeemCode}</code><span>Copy this value now. OpenCord stores only its cryptographic hash.</span></div><button type="button" className="primary-button small" onClick={() => { void navigator.clipboard.writeText(newRedeemCode); notify('Code copied.'); }}>Copy</button></div>}
        <div className="admin-table-list">{redeemCodes.map((code) => <div className="admin-backup-row" key={code.id}><div><strong>{code.prefix}…</strong><span>{code.durationMinutes == null ? 'Permanent membership' : `${Math.round(code.durationMinutes / 1440)} day(s)`} · {code.useCount}/{code.maxUses} uses · {code.disabled ? 'Disabled' : 'Active'}</span><small>Created {dateTime(code.createdAt)}</small></div>{!code.disabled && <button type="button" className="danger-button small" onClick={() => void withBusy(async () => { await api(`/api/admin/monetization/codes/${code.id}`, { method: 'DELETE' }); await loadMonetization(); notify('Redemption code disabled.'); })}>Disable</button>}</div>)}{!redeemCodes.length && <div className="admin-empty">No redemption codes created.</div>}</div>
      </section>
    </section>}

    {tab === 'servers' && <section className="admin-view">
      <form className="admin-search" onSubmit={(event) => { event.preventDefault(); void withBusy(() => loadServers(serverQuery)); }}><Search size={16} /><input value={serverQuery} onChange={(event) => setServerQuery(event.target.value)} placeholder="Search servers by name, ID, or owner" /><button className="secondary-button small">Search</button></form>
      <div className="admin-table-list">{servers.map((server) => <div className="admin-server-row" key={server.id}><div className="admin-server-icon">{server.iconPath ? <img src={server.iconPath} alt="" /> : server.name.slice(0, 2).toUpperCase()}</div><div><strong>{server.name}</strong><span>ID {server.id} · owner @{server.ownerUsername}</span><small>{server.memberCount} members · {server.channelCount} channels · {server.messageCount} messages</small></div><button type="button" className="danger-button small" onClick={() => { const reason = window.prompt(`Reason for deleting server ${server.name}:`, 'Rules violation')?.trim(); if (!reason) return; void withBusy(async () => { await api(`/api/admin/servers/${server.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) }); await Promise.all([loadServers(), loadStats()]); notify('Server deleted.'); }); }}><Trash2 size={14} /> Delete</button></div>)}{!servers.length && <div className="admin-empty">No servers found.</div>}</div>
    </section>}

    {tab === 'audit' && <section className="admin-view">
      <div className="admin-table-list audit-v3">{logs.map((log) => <div className="admin-audit-row" key={log.id}><div><strong>{actionNames[log.action] ?? log.action}</strong><span>{log.actorName}{log.actorUsername ? ` (@${log.actorUsername})` : ''} · {dateTime(log.createdAt)}</span><small>{log.targetType ? `${log.targetType}${log.targetId ? ` #${log.targetId}` : ''}` : 'Instance'}</small></div>{Object.keys(log.details).length > 0 && <pre>{JSON.stringify(log.details, null, 2)}</pre>}</div>)}{!logs.length && <div className="admin-empty">No administrative actions recorded.</div>}</div>
    </section>}

    {tab === 'settings' && <section className="admin-view">
      <form className="form-stack settings-card-column" onSubmit={(event) => { event.preventDefault(); void withBusy(async () => { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }); notify('Settings saved.'); await loadStats(); }); }}>
        <label>INSTANCE NAME<input value={settings.name} onChange={(event) => setSettings({ ...settings, name: event.target.value })} /></label>
        <label>DESCRIPTION<textarea value={settings.description} onChange={(event) => setSettings({ ...settings, description: event.target.value })} /></label>
        <label className="toggle-row"><input type="checkbox" checked={settings.registrationEnabled} onChange={(event) => setSettings({ ...settings, registrationEnabled: event.target.checked })} /> Allow new registrations</label>
        <label>SERVER LIMIT PER USER<input type="number" min="0" max="1000" value={settings.maxServersPerUser} onChange={(event) => setSettings({ ...settings, maxServersPerUser: Number(event.target.value) })} /><small>0 = unlimited</small></label>
        <label>FILE SIZE LIMIT (MB)<input type="number" min="1" max="50" value={settings.maxUploadMb} onChange={(event) => setSettings({ ...settings, maxUploadMb: Number(event.target.value) })} /></label>
        <button className="primary-button">Save settings</button>
      </form>
      <form className="form-stack settings-card-column" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void withBusy(async () => { const result = await api<{ logo: string }>('/api/admin/logo', { method: 'POST', body: new FormData(form) }); setSettings({ ...settings, logo: result.logo }); form.reset(); notify('Logo updated.'); }); }}><h3>Instance logo</h3>{settings.logo && <img src={settings.logo} alt="" className="instance-logo-preview" />}<ImageUploadField name="logo" label="INSTANCE LOGO" currentUrl={settings.logo} required /><button className="secondary-button">Upload logo</button></form>
    </section>}

    {tab === 'backups' && <section className="admin-view">
      <div className="admin-section-heading"><div><h3>Database backups</h3><p>SQLite backups can be downloaded and stored outside the server.</p></div><button type="button" className="primary-button" onClick={() => void withBusy(async () => { await api('/api/admin/backup', { method: 'POST' }); await loadBackups(); notify('Backup created.'); })}>Create backup</button></div>
      <div className="admin-table-list">{backups.map((backup) => <div className="admin-backup-row" key={backup.name}><div><strong>{backup.name}</strong><span>{bytes(backup.size)} · {dateTime(backup.modifiedAt)}</span></div><div><button type="button" className="secondary-button small" onClick={() => void downloadBackup(backup)}><Download size={14} /> Download</button><button type="button" className="danger-icon" onClick={() => { if (!window.confirm(`Delete ${backup.name}?`)) return; void withBusy(async () => { await api(`/api/admin/backups/${encodeURIComponent(backup.name)}`, { method: 'DELETE' }); await loadBackups(); }); }}><Trash2 size={14} /></button></div></div>)}{!backups.length && <div className="admin-empty">No backups available.</div>}</div>
    </section>}
  </div>;
}
