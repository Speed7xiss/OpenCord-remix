import { Download, Edit3, MoreHorizontal, Pin, Reply, Smile, Trash2 } from 'lucide-react';
import type { Message, User } from '../types';
import { Avatar } from './Avatar';
import { UserBadges } from './UserBadges';
import { PremiumMark } from './PremiumMark';
import { EmojiVisual, RichContent } from './RichContent';

function formatTime(value: string) {
  const normalized = value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function MessageRow({
  message, currentUser, canManage, onProfile, onReply, onEdit, onDelete, onPin, onReact, onContext,
}: {
  message: Message;
  currentUser: User;
  canManage: boolean;
  onProfile: (user: User) => void;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => void;
  onPin: (message: Message) => void;
  onReact: (message: Message, emoji: string, mine: boolean) => void;
  onContext: (event: React.MouseEvent, message: Message) => void;
}) {
  return (
    <article className={`message-row ${message.pinned ? 'pinned' : ''}`} onContextMenu={(event) => onContext(event, message)} id={`message-${message.id}`}>
      <button className="avatar-button" onClick={() => onProfile(message.author)}><Avatar user={message.author} size={40} /></button>
      <div className="message-body">
        {message.replyTo && <button className="reply-preview" onClick={() => document.getElementById(`message-${message.replyTo!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><Reply size={13} /><strong>{message.replyTo.author.displayName}</strong><span>{message.replyTo.content || '[file]'}</span></button>}
        <div className="message-meta"><button onClick={() => onProfile(message.author)}>{message.author.displayName}</button><UserBadges badges={message.author.badges} compact /><PremiumMark premium={message.author.premium} compact /><span>{formatTime(message.createdAt)}{message.editedAt ? ' · edited' : ''}</span>{message.pinned && <Pin size={13} />}</div>
        {message.content && <div className="message-content"><RichContent content={message.content} currentUser={currentUser} /></div>}
        {message.attachments.length > 0 && <div className="attachment-grid">{message.attachments.map((attachment) => attachment.mimeType.startsWith('image/') ? (
          <a href={attachment.path} target="_blank" rel="noreferrer" key={attachment.id}><img src={attachment.path} alt={attachment.name} loading="lazy" /></a>
        ) : (
          <a className="file-attachment" href={attachment.path} download={attachment.name} key={attachment.id}><Download size={22} /><div><strong>{attachment.name}</strong><span>{Math.max(1, Math.round(attachment.size / 1024))} KB</span></div></a>
        ))}</div>}
        {message.reactions.length > 0 && <div className="reactions">{message.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.mine ? 'mine' : ''} onClick={() => onReact(message, reaction.emoji, reaction.mine)}><EmojiVisual value={reaction.emoji} className="reaction-emoji" /> <span>{reaction.count}</span></button>)}</div>}
      </div>
      <div className="message-actions">
        <button title="React" onClick={() => onReact(message, '👍', false)}><Smile size={16} /></button>
        <button title="Reply" onClick={() => onReply(message)}><Reply size={16} /></button>
        {message.author.id === currentUser.id && <button title="Edit" onClick={() => onEdit(message)}><Edit3 size={16} /></button>}
        {(message.author.id === currentUser.id || canManage) && <button title="Delete" onClick={() => onDelete(message)}><Trash2 size={16} /></button>}
        {canManage && <button title={message.pinned ? 'Unpin' : 'Pin'} onClick={() => onPin(message)}><Pin size={16} /></button>}
        <button title="More" onClick={(event) => onContext(event, message)}><MoreHorizontal size={16} /></button>
      </div>
    </article>
  );
}
