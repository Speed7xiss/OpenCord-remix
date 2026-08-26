import type { ReactNode } from 'react';
import type { User } from '../types';

const tokenPattern = /(<:[a-zA-Z0-9_]{2,32}:\d+>|https?:\/\/[^\s]+|@[a-zA-Z0-9_.-]+|@everyone)/g;
const customEmojiPattern = /^<:([a-zA-Z0-9_]{2,32}):(\d+)>$/;

export function customEmojiInfo(value: string) {
  const match = customEmojiPattern.exec(value);
  return match ? { name: match[1], id: Number(match[2]) } : null;
}

export function EmojiVisual({ value, className = '' }: { value: string; className?: string }) {
  const custom = customEmojiInfo(value);
  if (!custom) return <>{value}</>;
  return <img className={`custom-emoji ${className}`.trim()} src={`/api/emojis/${custom.id}/image`} alt={`:${custom.name}:`} title={`:${custom.name}:`} loading="lazy" />;
}

export function RichContent({ content, currentUser }: { content: string; currentUser: User }) {
  const parts = content.split(tokenPattern);
  const rendered: ReactNode[] = [];
  parts.forEach((part, index) => {
    const custom = customEmojiInfo(part);
    if (custom) {
      rendered.push(<EmojiVisual key={index} value={part} />);
      return;
    }
    if (/^https?:\/\//.test(part)) {
      rendered.push(<a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>);
      return;
    }
    if (part.startsWith('@')) {
      rendered.push(<span key={index} className={part === `@${currentUser.username}` || part === '@everyone' ? 'mention mention-me' : 'mention'}>{part}</span>);
      return;
    }
    rendered.push(part);
  });
  return <>{rendered}</>;
}
