import { Sparkles } from 'lucide-react';
import type { PremiumMembership } from '../types';

export function PremiumMark({ premium, compact = false }: { premium: PremiumMembership | null | undefined; compact?: boolean }) {
  if (!premium?.active || !premium.benefits.premiumBadge) return null;
  return <span className={`premium-mark ${compact ? 'compact' : ''}`} data-tooltip={premium.name} style={{ '--premium-color': premium.color } as import('react').CSSProperties}>
    {premium.iconPath ? <img src={premium.iconPath} alt="" /> : <Sparkles size={compact ? 12 : 15} />}
  </span>;
}
