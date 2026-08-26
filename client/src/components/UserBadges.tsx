import type { UserBadge } from '../types';

export function UserBadges({ badges, compact = false }: { badges: UserBadge[]; compact?: boolean }) {
  if (!badges?.length) return null;
  return (
    <span className={`user-badges ${compact ? 'compact' : ''}`} aria-label="User badges">
      {badges.map((badge) => (
        <span className="user-badge" key={badge.id} data-tooltip={badge.name} title={badge.name} aria-label={badge.name}>
          <img src={badge.imagePath || '/badges/default.svg'} alt="" loading="lazy" />
        </span>
      ))}
    </span>
  );
}
