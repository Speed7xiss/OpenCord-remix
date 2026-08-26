import type { User } from '../types';

type Props = { user: Pick<User, 'displayName' | 'avatarPath'>; size?: number; className?: string };

export function Avatar({ user, size = 36, className = '' }: Props) {
  const initials = user.displayName.trim().slice(0, 2).toUpperCase() || '?';
  return user.avatarPath ? (
    <img className={`avatar ${className}`} src={user.avatarPath} alt={user.displayName} width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <div className={`avatar avatar-fallback ${className}`} aria-label={user.displayName} style={{ width: size, height: size, fontSize: Math.max(11, size * 0.34) }}>{initials}</div>
  );
}
