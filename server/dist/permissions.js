import { db } from './db.js';
export const Permission = {
    VIEW_CHANNEL: 1 << 0,
    SEND_MESSAGES: 1 << 1,
    CONNECT: 1 << 2,
    SPEAK: 1 << 3,
    VIDEO: 1 << 4,
    STREAM: 1 << 5,
    MENTION_EVERYONE: 1 << 6,
    MANAGE_MESSAGES: 1 << 7,
    KICK_MEMBERS: 1 << 8,
    BAN_MEMBERS: 1 << 9,
    MANAGE_CHANNELS: 1 << 10,
    MANAGE_ROLES: 1 << 11,
    MANAGE_SERVER: 1 << 12,
    ADMINISTRATOR: 1 << 13,
};
export const ALL_PERMISSIONS = Object.values(Permission).reduce((sum, value) => sum | value, 0);
export const DEFAULT_MEMBER_PERMISSIONS = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CONNECT | Permission.SPEAK | Permission.VIDEO | Permission.STREAM;
export function isServerOwner(userId, serverId) {
    return Boolean(db.prepare('SELECT 1 FROM servers WHERE id = ? AND owner_id = ?').get(serverId, userId));
}
export function getServerPermissions(userId, serverId) {
    if (isServerOwner(userId, serverId))
        return ALL_PERMISSIONS;
    const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
    if (!member)
        return 0;
    const rows = db.prepare(`
    SELECT r.permissions
    FROM roles r
    LEFT JOIN member_roles mr ON mr.role_id = r.id AND mr.server_id = r.server_id AND mr.user_id = ?
    WHERE r.server_id = ? AND (r.is_everyone = 1 OR mr.user_id IS NOT NULL)
  `).all(userId, serverId);
    return rows.reduce((permissions, row) => permissions | Number(row.permissions ?? 0), 0);
}
export function hasPermission(userId, serverId, permission) {
    const permissions = getServerPermissions(userId, serverId);
    return Boolean(permissions & Permission.ADMINISTRATOR) || Boolean(permissions & permission);
}
function applyChannelOverwrites(base, channelId, serverId, userId) {
    let permissions = base;
    const everyone = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_everyone = 1').get(serverId);
    if (everyone) {
        const overwrite = db.prepare("SELECT allow_permissions, deny_permissions FROM channel_permission_overwrites WHERE channel_id = ? AND target_type = 'ROLE' AND target_id = ?")
            .get(channelId, everyone.id);
        if (overwrite)
            permissions = (permissions & ~Number(overwrite.deny_permissions)) | Number(overwrite.allow_permissions);
    }
    const roles = db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(serverId, userId);
    let roleAllow = 0;
    let roleDeny = 0;
    for (const role of roles) {
        const overwrite = db.prepare("SELECT allow_permissions, deny_permissions FROM channel_permission_overwrites WHERE channel_id = ? AND target_type = 'ROLE' AND target_id = ?")
            .get(channelId, role.role_id);
        if (overwrite) {
            roleAllow |= Number(overwrite.allow_permissions);
            roleDeny |= Number(overwrite.deny_permissions);
        }
    }
    permissions = (permissions & ~roleDeny) | roleAllow;
    const memberOverwrite = db.prepare("SELECT allow_permissions, deny_permissions FROM channel_permission_overwrites WHERE channel_id = ? AND target_type = 'MEMBER' AND target_id = ?")
        .get(channelId, userId);
    if (memberOverwrite)
        permissions = (permissions & ~Number(memberOverwrite.deny_permissions)) | Number(memberOverwrite.allow_permissions);
    return permissions;
}
export function getChannelPermissions(userId, channelId) {
    const channel = db.prepare('SELECT id, server_id, parent_id, kind FROM channels WHERE id = ?').get(channelId);
    if (!channel)
        return 0;
    const serverId = Number(channel.server_id);
    if (isServerOwner(userId, serverId))
        return ALL_PERMISSIONS;
    let permissions = getServerPermissions(userId, serverId);
    if (permissions & Permission.ADMINISTRATOR)
        return ALL_PERMISSIONS;
    if (channel.parent_id) {
        const parent = db.prepare("SELECT id FROM channels WHERE id = ? AND server_id = ? AND kind = 'CATEGORY'").get(channel.parent_id, serverId);
        if (parent)
            permissions = applyChannelOverwrites(permissions, Number(parent.id), serverId, userId);
    }
    permissions = applyChannelOverwrites(permissions, channelId, serverId, userId);
    return permissions;
}
export function hasChannelPermission(userId, channelId, permission) {
    return Boolean(getChannelPermissions(userId, channelId) & permission);
}
