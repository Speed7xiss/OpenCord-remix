import { useEffect, useState } from 'react';
import { Ban, MessageCircle, UserMinus, UserPlus, Users } from 'lucide-react';
import { api } from '../lib/api';
import type { User, UserProfilePayload } from '../types';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { UserBadges } from './UserBadges';
import { PremiumMark } from './PremiumMark';

export function UserProfileModal({
  me, userId, onClose, onOpenDm, reloadFriends, notify,
}: {
  me: User;
  userId: number;
  onClose: () => void;
  onOpenDm: (user: User) => void;
  reloadFriends: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [profile, setProfile] = useState<UserProfilePayload | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setProfile(await api<UserProfilePayload>(`/api/users/${userId}/profile`)); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to open profile.'); onClose(); }
  };
  useEffect(() => { void load(); }, [userId]);

  if (!profile) return <Modal title="Profile" onClose={onClose}><div className="loading-state">Loading profile...</div></Modal>;
  const user = profile.user;
  const mine = user.id === me.id;

  const action = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try { await fn(); if (success) notify(success); await reloadFriends(); await load(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Operation failed.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="User Profile" onClose={onClose}>
      <div className={`user-profile-card premium-profile-theme-${user.profileTheme || 'classic'} premium-effect-${user.profileEffect || 'none'}`} style={{ ...(user.profileBackgroundPath ? { backgroundImage: `linear-gradient(rgba(32,34,37,.78),rgba(32,34,37,.92)), url(${user.profileBackgroundPath})` } : {}), ...(user.profileGradient ? { borderImage: `${user.profileGradient} 1` } : {}) }}>
        <div className="user-profile-banner" style={user.bannerPath ? { backgroundImage: `url(${user.bannerPath})` } : undefined} />
        <div className="user-profile-avatar"><Avatar user={user} size={88} />{user.avatarDecorationPath && <img className="avatar-decoration" src={user.avatarDecorationPath} alt="" />}<span className={`presence-dot ${user.presence}`} /></div>
        <div className="user-profile-title"><h2>{user.displayName}</h2><span>@{user.username}</span><div className="profile-badge-line"><UserBadges badges={user.badges} /><PremiumMark premium={user.premium} /></div>{user.specialIdentity && <em className="special-identity">{user.specialIdentity}</em>}</div>
        {user.statusText && <div className="profile-status">{user.statusText}</div>}
        {user.bio && <section className="profile-section"><strong>ABOUT ME</strong><p>{user.bio}</p></section>}
        <section className="profile-section profile-stats"><div><strong>{profile.mutualFriends}</strong><span>mutual friends</span></div><div><strong>{profile.commonServers.length}</strong><span>common servers</span></div></section>
        {profile.commonServers.length > 0 && <section className="profile-section"><strong>MUTUAL SERVERS</strong><div className="common-servers">{profile.commonServers.map((server) => <span key={server.id}>{server.iconPath ? <img src={server.iconPath} alt="" /> : server.name.slice(0, 2).toUpperCase()} {server.name}</span>)}</div></section>}
        {!mine && <div className="profile-actions">
          {profile.relationship?.status === 'accepted' ? <>
            <button className="primary-button" onClick={() => { onOpenDm(user); onClose(); }}><MessageCircle size={17} /> Message</button>
            <button className="secondary-button" disabled={busy} onClick={() => action(() => api(`/api/friends/${profile.relationship!.id}`, { method: 'DELETE' }), 'Friend removed.')}><UserMinus size={17} /> Remove friend</button>
          </> : profile.relationship?.status === 'pending' && profile.relationship.incoming ? (
            <button className="primary-button" disabled={busy} onClick={() => action(() => api(`/api/friends/${profile.relationship!.id}/accept`, { method: 'POST' }), 'Friend request accepted.')}><Users size={17} /> Accept friend request</button>
          ) : profile.relationship?.status === 'pending' ? (
            <button className="secondary-button" disabled>Request sent</button>
          ) : !profile.blockedByMe ? (
            <button className="primary-button" disabled={busy} onClick={() => action(() => api(`/api/friends/request/${user.id}`, { method: 'POST' }), 'Friend request sent.')}><UserPlus size={17} /> Add friend</button>
          ) : null}
          {profile.blockedByMe ? <button className="secondary-button" disabled={busy} onClick={() => action(() => api(`/api/blocks/${user.id}`, { method: 'DELETE' }), 'User unblocked.')}><Ban size={17} /> Unblock</button> : <button className="danger-button" disabled={busy} onClick={() => action(() => api(`/api/blocks/${user.id}`, { method: 'PUT' }), 'User blocked.')}><Ban size={17} /> Block</button>}
        </div>}
        <div className="profile-footer">Account created on {new Date(user.createdAt).toLocaleDateString('en-US')}</div>
      </div>
    </Modal>
  );
}
