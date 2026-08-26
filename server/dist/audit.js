import { db } from './db.js';
export function audit(serverId, actorId, action, targetType, targetId, details = {}) {
    db.prepare('INSERT INTO audit_logs (server_id, actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(serverId, actorId, action, targetType ?? null, targetId ?? null, JSON.stringify(details));
}
