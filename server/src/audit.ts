import { db } from './db.js';

export function audit(serverId: number, actorId: number | null, action: string, targetType?: string, targetId?: number, details: Record<string, unknown> = {}) {
  db.prepare('INSERT INTO audit_logs (server_id, actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(serverId, actorId, action, targetType ?? null, targetId ?? null, JSON.stringify(details));
}
