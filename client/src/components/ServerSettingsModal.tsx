import { FormEvent, useEffect, useState } from 'react';
import { Archive, Ban, Bell, Copy, GripVertical, Hash, List, Plus, Shield, Trash2, Upload, Volume2 } from 'lucide-react';
import { api } from '../lib/api';
import { ALL_PERMISSIONS, can, Permission, type Channel, type Role, type ServerDetail } from '../types';
import { Modal } from './Modal';
import { ImageUploadField } from './ImageUploadField';

const permissionOptions = [
  ['View channels', Permission.VIEW_CHANNEL], ['Send messages', Permission.SEND_MESSAGES], ['Connect to voice', Permission.CONNECT], ['Speak', Permission.SPEAK],
  ['Camera', Permission.VIDEO], ['Share screen', Permission.STREAM], ['Mention @everyone', Permission.MENTION_EVERYONE], ['Manage messages', Permission.MANAGE_MESSAGES],
  ['Kick members', Permission.KICK_MEMBERS], ['Ban members', Permission.BAN_MEMBERS], ['Manage channels', Permission.MANAGE_CHANNELS], ['Manage roles', Permission.MANAGE_ROLES],
  ['Manage server', Permission.MANAGE_SERVER], ['Administrator', Permission.ADMINISTRATOR],
] as const;

export function ServerSettingsModal({ detail, meId, onClose, reload, notify, onServerGone }: {
  detail: ServerDetail;
  meId: number;
  onClose: () => void;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  onServerGone: () => void;
}) {
  const [tab, setTab] = useState<'general' | 'channels' | 'roles' | 'invites' | 'moderation' | 'audit' | 'notifications'>('general');
  const [invites, setInvites] = useState<Array<{ code: string; expiresAt: number | null; maxUses: number | null; uses: number }>>([]);
  const [bans, setBans] = useState<Array<{ userId: number; displayName: string; username: string; reason: string; createdAt: string }>>([]);
  const [logs, setLogs] = useState<Array<{ id: number; action: string; actor: { displayName: string } | null; details: Record<string, unknown>; createdAt: string }>>([]);
  const [notifications, setNotifications] = useState({ level: 'MENTIONS', muted: false });
  const canManageServer = can(detail.myPermissions, Permission.MANAGE_SERVER);
  const canChannels = can(detail.myPermissions, Permission.MANAGE_CHANNELS);
  const canRoles = can(detail.myPermissions, Permission.MANAGE_ROLES);
  const canBan = can(detail.myPermissions, Permission.BAN_MEMBERS);

  useEffect(() => {
    const allowed = (tab === 'general' && canManageServer) || (tab === 'channels' && canChannels) || (tab === 'roles' && canRoles) || (tab === 'invites' && canManageServer) || (tab === 'moderation' && canBan) || (tab === 'audit' && canManageServer) || tab === 'notifications';
    if (!allowed) setTab('notifications');
  }, [tab, canManageServer, canChannels, canRoles, canBan]);

  useEffect(() => {
    if (tab === 'invites' && canManageServer) void api<{ invites: typeof invites }>(`/api/servers/${detail.server.id}/invites`).then((r) => setInvites(r.invites)).catch(() => undefined);
    if (tab === 'moderation' && canBan) void api<{ bans: typeof bans }>(`/api/servers/${detail.server.id}/bans`).then((r) => setBans(r.bans)).catch(() => undefined);
    if (tab === 'audit' && canManageServer) void api<{ logs: typeof logs }>(`/api/servers/${detail.server.id}/audit`).then((r) => setLogs(r.logs)).catch(() => undefined);
    if (tab === 'notifications') void api<typeof notifications>(`/api/servers/${detail.server.id}/notifications`).then(setNotifications).catch(() => undefined);
  }, [tab, detail.server.id]);

  const saveGeneral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { await api(`/api/servers/${detail.server.id}`, { method: 'PATCH', body: JSON.stringify({ name: form.get('name'), description: form.get('description') }) }); await reload(); notify('Server updated.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Save failed.'); }
  };
  const media = async (event: FormEvent<HTMLFormElement>, kind: 'icon' | 'banner') => {
    event.preventDefault();
    try { await api(`/api/servers/${detail.server.id}/${kind}`, { method: 'POST', body: new FormData(event.currentTarget) }); await reload(); notify(`${kind === 'icon' ? 'Icon' : 'Banner'} updated.`); }
    catch (error) { notify(error instanceof Error ? error.message : 'Upload failed.'); }
  };
  const createChannel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const parent = String(form.get('parentId') ?? '');
    try { await api(`/api/servers/${detail.server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), kind: form.get('kind'), parentId: parent ? Number(parent) : null, topic: form.get('topic') }) }); event.currentTarget.reset(); await reload(); notify('Channel created.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to create channel.'); }
  };
  const createRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api(`/api/servers/${detail.server.id}/roles`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), color: form.get('color'), permissions: 0 }) }); event.currentTarget.reset(); await reload(); notify('Role created.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to create role.'); }
  };
  const updateRolePermission = async (role: Role, flag: number, checked: boolean) => {
    const permissions = checked ? (role.permissions | flag) : (role.permissions & ~flag);
    try { await api(`/api/roles/${role.id}`, { method: 'PATCH', body: JSON.stringify({ permissions: permissions & ALL_PERMISSIONS }) }); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to update role.'); }
  };
  const deleteRole = async (role: Role) => {
    if (!confirm(`Delete the role ${role.name}?`)) return;
    try { await api(`/api/roles/${role.id}`, { method: 'DELETE' }); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to delete role.'); }
  };
  const reorderRole = async (dragId: number, dropId: number) => {
    const roles = detail.roles.filter((r) => !r.isEveryone);
    const from = roles.findIndex((r) => r.id === dragId), to = roles.findIndex((r) => r.id === dropId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...roles]; const [item] = next.splice(from, 1); next.splice(to, 0, item);
    try { await api(`/api/servers/${detail.server.id}/roles/reorder`, { method: 'POST', body: JSON.stringify({ ids: next.map((r) => r.id) }) }); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to reorder.'); }
  };

  return <Modal title={`${detail.server.name} — Server Settings`} onClose={onClose} wide>
    <div className="settings-layout server-settings-layout">
      <nav className="settings-nav">
        {canManageServer && <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}><Shield size={17} /> Overview</button>}
        {canChannels && <button className={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}><Hash size={17} /> Channels</button>}
        {canRoles && <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}><List size={17} /> Roles</button>}
        {canManageServer && <button className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}><Copy size={17} /> Invites</button>}
        {canBan && <button className={tab === 'moderation' ? 'active' : ''} onClick={() => setTab('moderation')}><Ban size={17} /> Bans</button>}
        {canManageServer && <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}><Archive size={17} /> Audit log</button>}
        <button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}><Bell size={17} /> Notifications</button>
      </nav>
      <div className="settings-pane">
        {tab === 'general' && canManageServer && <>
          {detail.server.bannerPath && <img className="server-settings-banner" src={detail.server.bannerPath} alt="" />}
          <form className="form-stack" onSubmit={saveGeneral}><h2>Server Overview</h2><label>NAME<input name="name" defaultValue={detail.server.name} maxLength={60} required /></label><label>DESCRIPTION<textarea name="description" defaultValue={detail.server.description} maxLength={240} rows={3} /></label><button className="primary-button">Save</button></form>
          <div className="two-column-forms"><form className="form-stack" onSubmit={(e) => media(e, 'icon')}><ImageUploadField name="icon" label="SERVER ICON" currentUrl={detail.server.iconPath} required /><button className="secondary-button"><Upload size={16} /> Upload</button></form><form className="form-stack" onSubmit={(e) => media(e, 'banner')}><ImageUploadField name="banner" label="SERVER BANNER" currentUrl={detail.server.bannerPath} required /><button className="secondary-button"><Upload size={16} /> Upload</button></form></div>
          <div className="settings-card-column"><h3>Server backup</h3><p>Exports server structure, roles, and text history as JSON.</p><a className="secondary-button button-link" href={`/api/servers/${detail.server.id}/export`} download>Export server</a></div>
          {detail.server.ownerId === meId && detail.members.some((member) => member.id !== meId) && <form className="form-stack settings-card-column" onSubmit={async (event) => { event.preventDefault(); const userId = Number(new FormData(event.currentTarget).get('userId')); if (!userId || !confirm('Transfer ownership of this server?')) return; try { await api(`/api/servers/${detail.server.id}/transfer`, { method: 'POST', body: JSON.stringify({ userId }) }); await reload(); notify('Ownership transferred.'); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}><h3>Transfer ownership</h3><label>NEW OWNER<select name="userId" required>{detail.members.filter((member) => member.id !== meId).map((member) => <option key={member.id} value={member.id}>{member.nickname || member.displayName} (@{member.username})</option>)}</select></label><button className="secondary-button">Transfer ownership</button></form>}
          <div className="danger-zone"><h3>Danger zone</h3>{detail.server.ownerId === meId ? <button className="danger-button" onClick={async () => { if (!confirm('Permanently delete this server?')) return; try { await api(`/api/servers/${detail.server.id}`, { method: 'DELETE' }); onClose(); onServerGone(); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}><Trash2 size={17} /> Delete server</button> : <button className="danger-button" onClick={async () => { try { await api(`/api/servers/${detail.server.id}/leave`, { method: 'POST' }); onClose(); onServerGone(); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}>Leave server</button>}</div>
        </>}

        {tab === 'channels' && canChannels && <>
          <form className="form-stack" onSubmit={createChannel}><h2>Create channel or category</h2><label>NAME<input name="name" maxLength={48} required /></label><div className="inline-form"><select name="kind"><option value="TEXT">Text</option><option value="VOICE">Voice</option><option value="CATEGORY">Category</option></select><select name="parentId"><option value="">No category</option>{detail.channels.filter((c) => c.kind === 'CATEGORY').map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></div><label>TOPIC<input name="topic" maxLength={240} /></label><button className="primary-button"><Plus size={16} /> Create</button></form>
          <div className="channel-settings-list advanced">{detail.channels.map((channel) => <ChannelEditor key={channel.id} channel={channel} detail={detail} reload={reload} notify={notify} canRoles={canRoles} />)}</div>
        </>}

        {tab === 'roles' && canRoles && <>
          <form className="inline-form" onSubmit={createRole}><input name="name" placeholder="Role name" required maxLength={32} /><input name="color" type="color" defaultValue="#7289da" /><button className="primary-button"><Plus size={16} /> Create role</button></form>
          <p className="settings-hint">Drag roles to change their hierarchy.</p>
          <div className="role-editor-list">{detail.roles.map((role) => <RoleEditor key={role.id} role={role} onPermission={updateRolePermission} onDelete={deleteRole} onReload={reload} notify={notify} onDropRole={reorderRole} />)}</div>
        </>}

        {tab === 'invites' && canManageServer && <InvitesPanel serverId={detail.server.id} invites={invites} setInvites={setInvites} notify={notify} />}
        {tab === 'moderation' && canBan && <section><h2>Banned users</h2>{bans.length === 0 && <div className="empty-mini">No banned users.</div>}{bans.map((ban) => <div className="admin-row" key={ban.userId}><div><strong>{ban.displayName}</strong><span>@{ban.username} · {ban.reason || 'No reason'}</span></div><button className="secondary-button small" onClick={async () => { try { await api(`/api/servers/${detail.server.id}/bans/${ban.userId}`, { method: 'DELETE' }); setBans(bans.filter((b) => b.userId !== ban.userId)); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}>Unban</button></div>)}</section>}
        {tab === 'audit' && canManageServer && <section><h2>Audit log</h2><div className="audit-list">{logs.map((log) => <div key={log.id}><strong>{log.action.replaceAll('_', ' ')}</strong><span>{log.actor?.displayName ?? 'System'} · {new Date(`${log.createdAt.replace(' ', 'T')}Z`).toLocaleString('en-US')}</span></div>)}</div></section>}
        {tab === 'notifications' && <section className="form-stack"><h2>Server notifications</h2><label>LEVEL<select value={notifications.level} onChange={(e) => setNotifications({ ...notifications, level: e.target.value })}><option value="ALL">All messages</option><option value="MENTIONS">Mentions only</option><option value="NONE">Nothing</option></select></label><label className="toggle-row"><input type="checkbox" checked={notifications.muted} onChange={(e) => setNotifications({ ...notifications, muted: e.target.checked })} /> Mute server</label><button className="primary-button" onClick={async () => { try { await api(`/api/servers/${detail.server.id}/notifications`, { method: 'PUT', body: JSON.stringify(notifications) }); notify('Notifications saved.'); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}>Save</button>{detail.server.ownerId !== meId && <div className="danger-zone"><h3>Leave server</h3><button className="danger-button" onClick={async () => { if (!confirm('Leave this server?')) return; try { await api(`/api/servers/${detail.server.id}/leave`, { method: 'POST' }); onClose(); onServerGone(); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}>Leave server</button></div>}</section>}
      </div>
    </div>
  </Modal>;
}


function ChannelEditor({ channel, detail, reload, notify, canRoles }: { channel: Channel; detail: ServerDetail; reload: () => Promise<void>; notify: (message: string) => void; canRoles: boolean }) {
  const [open, setOpen] = useState(false);
  const [targetRoleId, setTargetRoleId] = useState(detail.roles.find((role) => role.isEveryone)?.id ?? detail.roles[0]?.id ?? 0);
  const overwrite = channel.overwrites.find((item) => item.targetType === 'ROLE' && item.targetId === targetRoleId);
  const [allow, setAllow] = useState(overwrite?.allow ?? 0);
  const [deny, setDeny] = useState(overwrite?.deny ?? 0);

  useEffect(() => {
    const current = channel.overwrites.find((item) => item.targetType === 'ROLE' && item.targetId === targetRoleId);
    setAllow(current?.allow ?? 0);
    setDeny(current?.deny ?? 0);
  }, [targetRoleId, channel.overwrites]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { name: form.get('name') };
    if (channel.kind !== 'CATEGORY') body.parentId = form.get('parentId') ? Number(form.get('parentId')) : null;
    if (channel.kind === 'TEXT') body.topic = form.get('topic') ?? '';
    if (channel.kind === 'VOICE') {
      body.userLimit = Number(form.get('userLimit') || 0);
      body.bitrate = Number(form.get('bitrate') || 64000);
    }
    try { await api(`/api/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify(body) }); await reload(); notify('Channel updated.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to update channel.'); }
  };

  const setPermissionMode = (flag: number, mode: 'inherit' | 'allow' | 'deny') => {
    setAllow((current) => mode === 'allow' ? current | flag : current & ~flag);
    setDeny((current) => mode === 'deny' ? current | flag : current & ~flag);
  };

  const savePermissions = async () => {
    if (!targetRoleId) return;
    try {
      await api(`/api/channels/${channel.id}/permissions`, { method: 'PUT', body: JSON.stringify({ targetType: 'ROLE', targetId: targetRoleId, allow: allow & ALL_PERMISSIONS, deny: deny & ALL_PERMISSIONS }) });
      await reload(); notify('Channel permissions updated.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Failed to save permissions.'); }
  };

  return <div className="channel-editor">
    <div className="channel-editor-head"><span>{channel.kind === 'TEXT' ? <Hash size={16} /> : channel.kind === 'VOICE' ? <Volume2 size={16} /> : <GripVertical size={16} />} {channel.name}</span><div><button className="link-button" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Edit'}</button><button className="danger-icon" onClick={async () => { if (!confirm(`Delete ${channel.name}?`)) return; try { await api(`/api/channels/${channel.id}`, { method: 'DELETE' }); await reload(); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}><Trash2 size={15} /></button></div></div>
    {open && <div className="channel-editor-body">
      <form className="form-stack" onSubmit={save}><label>NAME<input name="name" defaultValue={channel.name} maxLength={48} required /></label>{channel.kind !== 'CATEGORY' && <label>CATEGORY<select name="parentId" defaultValue={channel.parentId ?? ''}><option value="">No category</option>{detail.channels.filter((item) => item.kind === 'CATEGORY' && item.id !== channel.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}{channel.kind === 'TEXT' && <label>TOPIC<input name="topic" defaultValue={channel.topic} maxLength={240} /></label>}{channel.kind === 'VOICE' && <div className="inline-form"><label>USER LIMIT<input name="userLimit" type="number" min="0" max="99" defaultValue={channel.userLimit} /></label><label>BITRATE<select name="bitrate" defaultValue={channel.bitrate}><option value="32000">32 kbps</option><option value="64000">64 kbps</option><option value="96000">96 kbps</option><option value="128000">128 kbps</option><option value="192000">192 kbps</option><option value="256000">256 kbps</option><option value="384000">384 kbps</option></select></label></div>}<button className="secondary-button">Save channel</button></form>
      {canRoles && detail.roles.length > 0 && <div className="channel-permissions"><h3>Specific permissions {channel.kind === 'CATEGORY' ? 'for the category' : 'for the channel'}</h3><p className="settings-hint">Category rules are inherited by child channels; channel-specific rules take precedence.</p><label>ROLE<select value={targetRoleId} onChange={(event) => setTargetRoleId(Number(event.target.value))}>{detail.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><div className="channel-permission-grid">{permissionOptions.map(([label, flag]) => { const mode = (deny & flag) ? 'deny' : (allow & flag) ? 'allow' : 'inherit'; return <label key={flag}><span>{label}</span><select value={mode} onChange={(event) => setPermissionMode(flag, event.target.value as 'inherit' | 'allow' | 'deny')}><option value="inherit">Inherit</option><option value="allow">Allow</option><option value="deny">Deny</option></select></label>; })}</div><button className="primary-button" onClick={() => void savePermissions()}>Save permissions</button></div>}
    </div>}
  </div>;
}

function RoleEditor({ role, onPermission, onDelete, onReload, notify, onDropRole }: { role: Role; onPermission: (role: Role, flag: number, checked: boolean) => Promise<void>; onDelete: (role: Role) => Promise<void>; onReload: () => Promise<void>; notify: (message: string) => void; onDropRole: (dragId: number, dropId: number) => Promise<void> }) {
  const [open, setOpen] = useState(role.isEveryone);
  const [dragOver, setDragOver] = useState(false);
  return <div className={`role-editor ${dragOver ? 'drag-over' : ''}`} draggable={!role.isEveryone} onDragStart={(event) => event.dataTransfer.setData('text/role-id', String(role.id))} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); const id = Number(event.dataTransfer.getData('text/role-id')); if (id) void onDropRole(id, role.id); }}>
    <div className="role-editor-head"><GripVertical size={16} /><span className="role-color" style={{ background: role.color }} /><input key={`${role.id}-${role.name}`} defaultValue={role.name} disabled={role.isEveryone} onBlur={async (event) => { if (event.target.value === role.name) return; try { await api(`/api/roles/${role.id}`, { method: 'PATCH', body: JSON.stringify({ name: event.target.value }) }); await onReload(); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }} /><button className="link-button" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Permissions'}</button>{!role.isEveryone && <button className="danger-icon" onClick={() => void onDelete(role)}><Trash2 size={15} /></button>}</div>
    {open && <div className="permissions-grid">{permissionOptions.map(([label, flag]) => <label key={flag}><input type="checkbox" checked={Boolean(role.permissions & flag)} onChange={(event) => void onPermission(role, flag, event.target.checked)} /><span>{label}</span></label>)}</div>}
  </div>;
}

function InvitesPanel({ serverId, invites, setInvites, notify }: { serverId: number; invites: Array<{ code: string; expiresAt: number | null; maxUses: number | null; uses: number }>; setInvites: (value: typeof invites) => void; notify: (message: string) => void }) {
  const load = async () => { const result = await api<{ invites: typeof invites }>(`/api/servers/${serverId}/invites`); setInvites(result.invites); };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api(`/api/servers/${serverId}/invites`, { method: 'POST', body: JSON.stringify({ expiresInMinutes: Number(form.get('expires') || 0), maxUses: Number(form.get('uses') || 0) }) }); await load(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to create invite.'); }
  };
  return <section><h2>Invites</h2><form className="inline-form" onSubmit={create}><select name="expires"><option value="0">Never expires</option><option value="30">30 minutes</option><option value="1440">1 day</option><option value="10080">7 days</option></select><input name="uses" type="number" min="0" max="10000" placeholder="Uses (0 = unlimited)" /><button className="primary-button">Create invite</button></form><div className="invite-list">{invites.map((invite) => <div key={invite.code}><code>{invite.code}</code><span>{invite.uses}{invite.maxUses ? `/${invite.maxUses}` : ''} uses · {invite.expiresAt ? new Date(invite.expiresAt).toLocaleString('en-US') : 'no expiration'}</span><button className="icon-button" onClick={async () => { await navigator.clipboard.writeText(invite.code); notify('Invite copied.'); }}><Copy size={15} /></button><button className="danger-icon" onClick={async () => { try { await api(`/api/servers/${serverId}/invites/${invite.code}`, { method: 'DELETE' }); await load(); } catch (error) { notify(error instanceof Error ? error.message : 'Failed.'); } }}><Trash2 size={15} /></button></div>)}</div></section>;
}
