import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  Bell, Check, ChevronDown, ChevronRight, CirclePlus, Copy, Edit3, FolderPlus, Hash, Headphones, Home, LogOut, Menu,
  MessageCircle, Mic, MicOff, MonitorUp, MoreHorizontal, PhoneOff, Pin, Plus, Search, Settings, Shield, Smile, Trash2,
  SendHorizontal, Star, UserPlus, Users, Video, VideoOff, Volume1, Volume2, VolumeX, X,
} from 'lucide-react';
import { api, ApiError } from './lib/api';
import { socket } from './lib/socket';
import { useVoice } from './lib/useVoice';
import { loadPreferences } from './lib/preferences';
import { playSound } from './lib/sound';
import {
  can, Permission, type Channel, type DirectMessage, type DmGroupDetail, type DmGroupMessage, type DmGroupSummary, type FriendEntry,
  type CustomEmoji, type FriendsPayload, type Member, type Message, type ServerDetail, type ServerSummary, type User, type VoiceState,
} from './types';
import { Avatar } from './components/Avatar';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { MessageRow } from './components/MessageRow';
import { Modal } from './components/Modal';
import { ServerSettingsModal } from './components/ServerSettingsModal';
import { StreamTile } from './components/StreamTile';
import { UserProfileModal } from './components/UserProfileModal';
import { UserSettingsModal } from './components/UserSettingsModal';
import { UserBadges } from './components/UserBadges';
import { PremiumMark } from './components/PremiumMark';
import { EmojiVisual, RichContent } from './components/RichContent';
import { PendingAttachment } from './components/PendingAttachment';
import { ImageUploadField } from './components/ImageUploadField';

const emptyFriends: FriendsPayload = { accepted: [], incoming: [], outgoing: [], blocked: [] };
type MenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

type ModalState =
  | { type: 'user-settings' }
  | { type: 'server' }
  | { type: 'server-settings' }
  | { type: 'user-profile'; userId: number }
  | { type: 'member-manage'; member: Member }
  | { type: 'server-profile' }
  | null;

function getErrorMessage(error: unknown) {
  return error instanceof ApiError || error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function normalizedDate(value: string) {
  return new Date(value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`);
}

function useLongPressContext() {
  const timer = useRef<number | null>(null);
  const triggered = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cancel = useCallback(() => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; origin.current = null; }, []);
  const start = useCallback((event: ReactPointerEvent, callback: (event: ReactMouseEvent) => void) => {
    if (event.pointerType === 'mouse') return;
    cancel();
    triggered.current = false;
    const { clientX, clientY } = event;
    origin.current = { x: clientX, y: clientY };
    timer.current = window.setTimeout(() => {
      timer.current = null;
      origin.current = null;
      triggered.current = true;
      navigator.vibrate?.(18);
      callback({ clientX, clientY, preventDefault() {}, stopPropagation() {} } as unknown as ReactMouseEvent);
    }, 520);
  }, [cancel]);
  const move = useCallback((event: ReactPointerEvent) => {
    const startPoint = origin.current;
    if (!startPoint) return;
    if (Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 12) cancel();
  }, [cancel]);
  const consumeClick = useCallback(() => { const value = triggered.current; triggered.current = false; return value; }, []);
  useEffect(() => cancel, [cancel]);
  return { start, move, cancel, consumeClick };
}

export function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(() => Number(localStorage.getItem('opencord.lastServer')) || null);
  const [serverDetail, setServerDetail] = useState<ServerDetail | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [friends, setFriends] = useState<FriendsPayload>(emptyFriends);
  const [selectedDm, setSelectedDm] = useState<FriendEntry | null>(null);
  const [dmMessages, setDmMessages] = useState<DirectMessage[]>([]);
  const [dmHasMore, setDmHasMore] = useState(false);
  const [groups, setGroups] = useState<DmGroupSummary[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<DmGroupDetail | null>(null);
  const [groupMessages, setGroupMessages] = useState<DmGroupMessage[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [contextMenu, setContextMenu] = useState<MenuState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [friendQuery, setFriendQuery] = useState('');
  const [friendResults, setFriendResults] = useState<User[]>([]);
  const [typingUsers, setTypingUsers] = useState<User[]>([]);
  const [draftInsertion, setDraftInsertion] = useState<{ value: string; token: number } | null>(null);
  const [membersVisible, setMembersVisible] = useState(() => typeof window === 'undefined' ? true : window.innerWidth > 900);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const typingTimers = useRef(new Map<number, number>());
  const voice = useVoice();
  const longPress = useLongPressContext();
  const previousVoiceChannelId = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousVoiceChannelId.current;
    if (previous && !voice.channelId && selectedChannel?.kind === 'VOICE') {
      const fallback = serverDetail?.channels.find((channel) => channel.kind === 'TEXT') ?? null;
      if (fallback && serverDetail) localStorage.setItem(`opencord.server.${serverDetail.server.id}.channel`, String(fallback.id));
      setSelectedChannel(fallback);
    }
    previousVoiceChannelId.current = voice.channelId;
  }, [voice.channelId, selectedChannel?.kind, serverDetail]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const syncViewport = () => {
      if (media.matches) setMembersVisible(false);
      else setMobileNavOpen(false);
    };
    syncViewport();
    media.addEventListener('change', syncViewport);
    return () => media.removeEventListener('change', syncViewport);
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? null : current), 3400);
  }, []);

  const loadServers = useCallback(async () => {
    const data = await api<{ servers: ServerSummary[] }>('/api/servers');
    const storedOrder = JSON.parse(localStorage.getItem('opencord.serverOrder') ?? '[]') as number[];
    data.servers.sort((a, b) => {
      const ai = storedOrder.indexOf(a.id), bi = storedOrder.indexOf(b.id);
      if (ai < 0 && bi < 0) return 0;
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    });
    setServers(data.servers);
  }, []);

  const loadFriends = useCallback(async () => {
    const data = await api<FriendsPayload>('/api/friends');
    setFriends(data);
  }, []);

  const loadGroups = useCallback(async () => {
    const data = await api<{ groups: DmGroupSummary[] }>('/api/dm-groups');
    setGroups(data.groups);
  }, []);

  const loadServer = useCallback(async (serverId: number, preserveSelection = true) => {
    const data = await api<ServerDetail>(`/api/servers/${serverId}`);
    setServerDetail(data);
    setSelectedChannel((current) => {
      if (preserveSelection && current && data.channels.some((channel) => channel.id === current.id)) return current;
      const remembered = Number(localStorage.getItem(`opencord.server.${serverId}.channel`));
      return data.channels.find((channel) => channel.id === remembered && channel.kind !== 'CATEGORY')
        ?? data.channels.find((channel) => channel.kind === 'TEXT')
        ?? data.channels.find((channel) => channel.kind === 'VOICE')
        ?? null;
    });
  }, []);

  useEffect(() => {
    api<{ user: User }>('/api/me').then(({ user }) => setMe(user)).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!me) return;
    const prefs = loadPreferences();
    if ((prefs.theme === 'lavender' || prefs.theme === 'retro') && !me.premium?.benefits.premiumThemes) {
      const next = { ...prefs, theme: 'dark' as const };
      localStorage.setItem('opencord.preferences', JSON.stringify(next));
      document.documentElement.dataset.theme = 'dark';
    }
  }, [me]);

  useEffect(() => {
    const expiresAt = me?.premium?.expiresAt;
    if (!expiresAt) return;
    const delay = Math.min(2_147_000_000, Math.max(250, expiresAt - Date.now() + 500));
    const timer = window.setTimeout(() => {
      void api<{ user: User }>('/api/me').then(({ user }) => setMe(user)).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [me?.premium?.expiresAt]);

  useEffect(() => {
    if (!me) return;
    void loadServers().catch((error) => notify(getErrorMessage(error)));
    void loadFriends().catch((error) => notify(getErrorMessage(error)));
    void loadGroups().catch(() => undefined);
    socket.connect();
    return () => socket.disconnect();
  }, [me, loadFriends, loadGroups, loadServers, notify]);

  useEffect(() => {
    if (!me || !selectedServerId) {
      setServerDetail(null);
      setSelectedChannel(null);
      return;
    }
    localStorage.setItem('opencord.lastServer', String(selectedServerId));
    socket.emit('server:subscribe', selectedServerId);
    void loadServer(selectedServerId, false).catch((error) => {
      notify(getErrorMessage(error));
      setSelectedServerId(null);
      localStorage.removeItem('opencord.lastServer');
    });
    return () => { socket.emit('server:unsubscribe', selectedServerId); };
  }, [me, selectedServerId, loadServer, notify]);

  useEffect(() => {
    if (!selectedChannel || selectedChannel.kind !== 'TEXT') {
      setMessages([]); setMessagesHasMore(false); return;
    }
    localStorage.setItem(`opencord.server.${selectedChannel.serverId}.channel`, String(selectedChannel.id));
    socket.emit('channel:subscribe', selectedChannel.id);
    void api<{ messages: Message[]; hasMore: boolean }>(`/api/channels/${selectedChannel.id}/messages`).then((data) => {
      setMessages(data.messages); setMessagesHasMore(data.hasMore);
      void api(`/api/channels/${selectedChannel.id}/read`, { method: 'POST' }).catch(() => undefined);
      setServers((current) => current.map((server) => server.id === selectedChannel.serverId ? { ...server, unreadCount: 0 } : server));
    }).catch((error) => notify(getErrorMessage(error)));
    return () => { socket.emit('channel:unsubscribe', selectedChannel.id); };
  }, [selectedChannel?.id, notify]);

  useEffect(() => {
    if (!selectedDm) { setDmMessages([]); setDmHasMore(false); return; }
    void api<{ messages: DirectMessage[]; hasMore: boolean }>(`/api/dms/${selectedDm.user.id}`).then((data) => {
      setDmMessages(data.messages); setDmHasMore(data.hasMore);
      void api(`/api/dms/${selectedDm.user.id}/read`, { method: 'POST' }).catch(() => undefined);
      setFriends((current) => ({ ...current, accepted: current.accepted.map((entry) => entry.user.id === selectedDm.user.id ? { ...entry, unreadCount: 0 } : entry) }));
    }).catch((error) => notify(getErrorMessage(error)));
  }, [selectedDm?.user.id, notify]);

  useEffect(() => {
    if (!selectedGroup) { setGroupMessages([]); return; }
    void api<{ group: DmGroupDetail; messages: DmGroupMessage[] }>(`/api/dm-groups/${selectedGroup.id}`).then((data) => { setSelectedGroup(data.group); setGroupMessages(data.messages); }).catch((error) => notify(getErrorMessage(error)));
  }, [selectedGroup?.id, notify]);

  const browserNotify = useCallback((title: string, body: string) => {
    if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(title, { body, icon: '/favicon.ico' });
  }, []);

  useEffect(() => {
    if (!me) return;
    const onNewMessage = (message: Message) => {
      if (message.channelId === selectedChannel?.id) {
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
        if (message.author.id !== me.id) {
          const mention = message.content.includes(`@${me.username}`) || message.content.includes('@everyone');
          playSound(mention ? 'mention' : 'message');
          browserNotify(message.author.displayName, message.content || 'Sent a file');
          void api(`/api/channels/${message.channelId}/read`, { method: 'POST' }).catch(() => undefined);
        }
      }
    };
    const onEditedMessage = (message: Message) => { if (message.channelId === selectedChannel?.id) setMessages((current) => current.map((item) => item.id === message.id ? { ...item, ...message } : item)); };
    const onDeletedMessage = ({ id, channelId }: { id: number; channelId: number }) => { if (channelId === selectedChannel?.id) setMessages((current) => current.filter((item) => item.id !== id)); };
    const onReaction = ({ messageId, channelId, reactions }: { messageId: number; channelId: number; reactions: Message['reactions'] }) => { if (channelId === selectedChannel?.id) setMessages((current) => current.map((item) => item.id === messageId ? { ...item, reactions } : item)); };
    const onFriendsRefresh = () => void loadFriends().catch(() => undefined);
    const onGroupsRefresh = () => void loadGroups().catch(() => undefined);
    const onServerRefresh = ({ serverId }: { serverId: number }) => { void loadServers().catch(() => undefined); if (selectedServerId === serverId) void loadServer(serverId).catch(() => undefined); };
    const onServerUnread = ({ serverId, authorId }: { serverId: number; authorId: number }) => { if (authorId !== me.id && serverId !== selectedServerId) setServers((current) => current.map((s) => s.id === serverId ? { ...s, unreadCount: s.unreadCount + 1 } : s)); };
    const onServerNotification = ({ channelId, author, content, mentioned }: { serverId: number; channelId: number; author: User; content: string; mentioned: boolean }) => { if (channelId === selectedChannel?.id) return; playSound(mentioned ? 'mention' : 'message'); browserNotify(author.displayName, content); };
    const onDm = (message: DirectMessage) => {
      const relevant = selectedDm && ((message.sender.id === me.id && message.recipientId === selectedDm.user.id) || (message.sender.id === selectedDm.user.id && message.recipientId === me.id));
      if (relevant) {
        setDmMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
        if (message.sender.id !== me.id) void api(`/api/dms/${message.sender.id}/read`, { method: 'POST' }).catch(() => undefined);
      }
      if (message.sender.id !== me.id) { if (!relevant) void loadFriends().catch(() => undefined); playSound('message'); browserNotify(message.sender.displayName, message.content); }
    };
    const onDmEdited = ({ id, content, editedAt }: { id: number; content: string; editedAt: string }) => setDmMessages((current) => current.map((item) => item.id === id ? { ...item, content, editedAt } : item));
    const onDmDeleted = ({ id }: { id: number }) => setDmMessages((current) => current.filter((item) => item.id !== id));
    const onGroupMessage = (message: DmGroupMessage) => { if (selectedGroup?.id === message.threadId) setGroupMessages((current) => current.some((m) => m.id === message.id) ? current : [...current, message]); if (message.author.id !== me.id) playSound('message'); };
    const onUserUpdate = (user: User) => {
      if (user.id === me.id) setMe((current) => current ? { ...current, ...user, isInstanceAdmin: current.isInstanceAdmin } : current);
      setFriends((current) => ({ ...current, accepted: current.accepted.map((entry) => entry.user.id === user.id ? { ...entry, user: { ...entry.user, ...user } } : entry), incoming: current.incoming.map((entry) => entry.user.id === user.id ? { ...entry, user: { ...entry.user, ...user } } : entry), outgoing: current.outgoing.map((entry) => entry.user.id === user.id ? { ...entry, user: { ...entry.user, ...user } } : entry), blocked: current.blocked.map((item) => item.id === user.id ? { ...item, ...user } : item) }));
      setServerDetail((current) => current ? { ...current, members: current.members.map((member) => member.id === user.id ? { ...member, ...user } : member) } : current);
    };
    const onPresence = ({ userId, presence }: { userId: number; presence: User['presence'] }) => {
      setFriends((current) => ({ ...current, accepted: current.accepted.map((entry) => entry.user.id === userId ? { ...entry, user: { ...entry.user, presence } } : entry) }));
      setServerDetail((current) => current ? { ...current, members: current.members.map((member) => member.id === userId ? { ...member, presence } : member) } : current);
    };
    const onVoiceState = ({ serverId, states }: { serverId: number; states: VoiceState[] }) => { if (serverId === selectedServerId) setServerDetail((current) => current ? { ...current, voiceStates: states } : current); };
    const addTyping = (user: User) => {
      if (user.id === me.id) return;
      setTypingUsers((current) => [...current.filter((item) => item.id !== user.id), user]);
      const old = typingTimers.current.get(user.id); if (old) window.clearTimeout(old);
      typingTimers.current.set(user.id, window.setTimeout(() => setTypingUsers((current) => current.filter((item) => item.id !== user.id)), 2500));
    };
    const onTypingChannel = ({ channelId, user }: { channelId: number; user: User }) => { if (channelId === selectedChannel?.id) addTyping(user); };
    const onTypingDm = ({ user }: { user: User }) => { if (selectedDm?.user.id === user.id) addTyping(user); };
    const onRemoved = ({ serverId }: { serverId: number }) => { if (serverId === selectedServerId) openHome(); void loadServers(); notify('You are no longer a member of that server.'); };
    const onAccountDisabled = ({ reason }: { reason?: string } = {}) => { setMe(null); socket.disconnect(); notify(reason ? `This account was disabled: ${reason}` : 'This account was disabled by an administrator.'); };
    const onAccountBanned = ({ reason, expiresAt }: { reason?: string; expiresAt?: number | null } = {}) => {
      setMe(null); socket.disconnect();
      const expiry = expiresAt ? ` until ${new Date(expiresAt).toLocaleString('en-US')}` : ' permanentemente';
      notify(`Your account was banned${expiry}${reason ? `: ${reason}` : '.'}`);
    };
    const onAccountLogout = ({ reason }: { reason?: string } = {}) => { setMe(null); socket.disconnect(); notify(reason || 'Your session was ended by an administrator.'); };
    const onAccountDeleted = ({ reason }: { reason?: string } = {}) => { setMe(null); socket.disconnect(); notify(reason ? `Your account was deleted: ${reason}` : 'Your account was deleted by an administrator.'); };
    const onAccountAdmin = ({ isInstanceAdmin }: { isInstanceAdmin: boolean }) => setMe((current) => current ? { ...current, isInstanceAdmin } : current);
    const onBadgesRefresh = () => {
      void api<{ user: User }>('/api/me').then(({ user }) => setMe(user)).catch(() => undefined);
      void loadFriends().catch(() => undefined);
      if (selectedServerId) void loadServer(selectedServerId).catch(() => undefined);
    };
    const onPremiumRefresh = () => {
      void api<{ user: User }>('/api/me').then(({ user }) => setMe(user)).catch(() => undefined);
      void loadFriends().catch(() => undefined);
      if (selectedServerId) void loadServer(selectedServerId).catch(() => undefined);
    };

    socket.on('message:new', onNewMessage); socket.on('message:edited', onEditedMessage); socket.on('message:deleted', onDeletedMessage); socket.on('message:reaction', onReaction);
    socket.on('friends:refresh', onFriendsRefresh); socket.on('dm-groups:refresh', onGroupsRefresh); socket.on('server:refresh', onServerRefresh); socket.on('server:unread', onServerUnread); socket.on('server:notification', onServerNotification);
    socket.on('dm:new', onDm); socket.on('dm:edited', onDmEdited); socket.on('dm:deleted', onDmDeleted); socket.on('dm-group:new', onGroupMessage);
    socket.on('user:update', onUserUpdate); socket.on('presence:update', onPresence); socket.on('voice:state', onVoiceState); socket.on('typing:channel', onTypingChannel); socket.on('typing:dm', onTypingDm);
    socket.on('server:kicked', onRemoved); socket.on('server:banned', onRemoved); socket.on('server:deleted', onRemoved); socket.on('account:disabled', onAccountDisabled);
    socket.on('account:banned', onAccountBanned); socket.on('account:logout', onAccountLogout); socket.on('account:deleted', onAccountDeleted); socket.on('account:admin', onAccountAdmin); socket.on('badges:refresh', onBadgesRefresh); socket.on('premium:refresh', onPremiumRefresh);
    return () => {
      socket.off('message:new', onNewMessage); socket.off('message:edited', onEditedMessage); socket.off('message:deleted', onDeletedMessage); socket.off('message:reaction', onReaction);
      socket.off('friends:refresh', onFriendsRefresh); socket.off('dm-groups:refresh', onGroupsRefresh); socket.off('server:refresh', onServerRefresh); socket.off('server:unread', onServerUnread); socket.off('server:notification', onServerNotification);
      socket.off('dm:new', onDm); socket.off('dm:edited', onDmEdited); socket.off('dm:deleted', onDmDeleted); socket.off('dm-group:new', onGroupMessage);
      socket.off('user:update', onUserUpdate); socket.off('presence:update', onPresence); socket.off('voice:state', onVoiceState); socket.off('typing:channel', onTypingChannel); socket.off('typing:dm', onTypingDm);
      socket.off('server:kicked', onRemoved); socket.off('server:banned', onRemoved); socket.off('server:deleted', onRemoved); socket.off('account:disabled', onAccountDisabled);
      socket.off('account:banned', onAccountBanned); socket.off('account:logout', onAccountLogout); socket.off('account:deleted', onAccountDeleted); socket.off('account:admin', onAccountAdmin); socket.off('badges:refresh', onBadgesRefresh); socket.off('premium:refresh', onPremiumRefresh);
    };
  }, [browserNotify, loadFriends, loadGroups, loadServer, loadServers, me, selectedChannel?.id, selectedDm?.user.id, selectedGroup?.id, selectedServerId, notify]);

  useEffect(() => { messageEndRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, dmMessages.length, groupMessages.length]);

  const openHome = useCallback(() => {
    setMobileNavOpen(false);
    setSelectedServerId(null); setServerDetail(null); setSelectedChannel(null); setSelectedDm(null); setSelectedGroup(null); setTypingUsers([]);
    localStorage.removeItem('opencord.lastServer');
  }, []);

  const openDmUser = useCallback((user: User) => {
    const entry = friends.accepted.find((item) => item.user.id === user.id);
    if (!entry) return notify('Direct messages are available only between friends.');
    setSelectedServerId(null); setServerDetail(null); setSelectedChannel(null); setSelectedGroup(null); setSelectedDm(entry); setTypingUsers([]);
  }, [friends.accepted, notify]);

  const openDm = (entry: FriendEntry) => { setMobileNavOpen(false); openDmUser(entry.user); };
  const openGroup = async (group: DmGroupSummary) => {
    setMobileNavOpen(false);
    setSelectedServerId(null); setServerDetail(null); setSelectedChannel(null); setSelectedDm(null); setTypingUsers([]);
    try { const data = await api<{ group: DmGroupDetail; messages: DmGroupMessage[] }>(`/api/dm-groups/${group.id}`); setSelectedGroup(data.group); setGroupMessages(data.messages); }
    catch (error) { notify(getErrorMessage(error)); }
  };

  const openChannel = async (channel: Channel) => {
    setMobileNavOpen(false);
    setSelectedChannel(channel); setTypingUsers([]);
    if (channel.kind === 'VOICE') {
      try { await voice.join(channel.id); }
      catch (error) { notify(getErrorMessage(error)); const fallback = serverDetail?.channels.find((item) => item.kind === 'TEXT') ?? null; setSelectedChannel(fallback); }
    }
  };

  const leaveVoiceAndExit = useCallback(() => {
    voice.leave();
    setSelectedChannel((current) => {
      if (!current || current.kind !== 'VOICE') return current;
      const fallback = serverDetail?.channels.find((channel) => channel.kind === 'TEXT') ?? null;
      if (fallback && serverDetail) localStorage.setItem(`opencord.server.${serverDetail.server.id}.channel`, String(fallback.id));
      return fallback;
    });
  }, [serverDetail, voice]);

  const logout = useCallback(async () => {
    voice.leave(true); await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); socket.disconnect(); setMe(null); setServers([]); openHome();
  }, [openHome, voice]);

  const showContext = (event: ReactMouseEvent, items: ContextMenuItem[]) => { event.preventDefault(); event.stopPropagation(); setContextMenu({ x: event.clientX, y: event.clientY, items }); };

  const memberContext = (event: ReactMouseEvent, member: Member) => {
    if (!me || !serverDetail) return;
    const remotePeer = voice.remotePeers.find((peer) => peer.user.id === member.id);
    const items: ContextMenuItem[] = [
      { label: 'View profile', onClick: () => setModal({ type: 'user-profile', userId: member.id }) },
      { label: 'Send message', disabled: !friends.accepted.some((e) => e.user.id === member.id), onClick: () => openDmUser(member) },
      { label: friends.accepted.some((e) => e.user.id === member.id) ? 'Remove friend' : 'Add friend', disabled: member.id === me.id, onClick: async () => { try { const friendship = friends.accepted.find((e) => e.user.id === member.id); if (friendship) await api(`/api/friends/${friendship.friendshipId}`, { method: 'DELETE' }); else await api(`/api/friends/request/${member.id}`, { method: 'POST' }); await loadFriends(); } catch (error) { notify(getErrorMessage(error)); } } },
      { label: 'Mention', onClick: () => setDraftInsertion({ value: `@${member.username} `, token: Date.now() }) },
      { separator: true, label: '' },
      { label: 'Mute locally', disabled: !remotePeer, onClick: () => remotePeer && voice.toggleLocalPeerMute(remotePeer.socketId) },
      { label: 'Volume 50%', disabled: !remotePeer, onClick: () => remotePeer && voice.setPeerVolume(remotePeer.socketId, 0.5) },
      { label: 'Volume 100%', disabled: !remotePeer, onClick: () => remotePeer && voice.setPeerVolume(remotePeer.socketId, 1) },
      { label: 'Manage roles', disabled: member.id === me.id || !can(serverDetail.myPermissions, Permission.MANAGE_ROLES), onClick: () => setModal({ type: 'member-manage', member }) },
    ];
    if (member.id === me.id && me.premium?.benefits.perServerProfiles) items.splice(1, 0, { label: 'Edit server profile', onClick: () => setModal({ type: 'server-profile' }) });
    if (member.id !== me.id && can(serverDetail.myPermissions, Permission.KICK_MEMBERS)) items.push({ separator: true, label: '' }, { label: 'Kick', danger: true, onClick: () => void moderateMember(member, 'kick') });
    if (member.id !== me.id && can(serverDetail.myPermissions, Permission.BAN_MEMBERS)) items.push({ label: 'Ban', danger: true, onClick: () => void moderateMember(member, 'ban') });
    showContext(event, items);
  };

  const moderateMember = async (member: Member, action: 'kick' | 'ban') => {
    if (!serverDetail) return;
    const reason = prompt(`Reason to ${action === 'kick' ? 'kick' : 'ban'} ${member.displayName}:`, '') ?? '';
    try { await api(`/api/servers/${serverDetail.server.id}/members/${member.id}/${action}`, { method: 'POST', body: JSON.stringify({ reason }) }); await loadServer(serverDetail.server.id); notify(action === 'kick' ? 'Member kicked.' : 'Member banned.'); }
    catch (error) { notify(getErrorMessage(error)); }
  };

  const channelContext = (event: ReactMouseEvent, channel: Channel) => {
    if (!serverDetail || !can(serverDetail.myPermissions, Permission.MANAGE_CHANNELS)) return;
    showContext(event, [
      { label: channel.kind === 'CATEGORY' ? 'Create channel in this category' : 'Rename', onClick: async () => {
        if (channel.kind === 'CATEGORY') {
          const name = prompt('New channel name:'); if (!name) return;
          try { await api(`/api/servers/${serverDetail.server.id}/channels`, { method: 'POST', body: JSON.stringify({ name, kind: 'TEXT', parentId: channel.id }) }); await loadServer(serverDetail.server.id); } catch (error) { notify(getErrorMessage(error)); }
        } else {
          const name = prompt('New name:', channel.name); if (!name || name === channel.name) return;
          try { await api(`/api/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await loadServer(serverDetail.server.id); } catch (error) { notify(getErrorMessage(error)); }
        }
      } },
      { label: 'Delete', danger: true, onClick: async () => { if (!confirm(`Delete ${channel.name}?`)) return; try { await api(`/api/channels/${channel.id}`, { method: 'DELETE' }); await loadServer(serverDetail.server.id); } catch (error) { notify(getErrorMessage(error)); } } },
    ]);
  };

  const reorderChannel = async (dragId: number, dropId: number, parentId?: number | null) => {
    if (!serverDetail || !can(serverDetail.myPermissions, Permission.MANAGE_CHANNELS)) return;
    const list = [...serverDetail.channels].sort((a, b) => a.position - b.position);
    const from = list.findIndex((c) => c.id === dragId), to = list.findIndex((c) => c.id === dropId);
    if (from < 0 || to < 0) return;
    const [item] = list.splice(from, 1); list.splice(to, 0, { ...item, parentId: parentId !== undefined ? parentId : item.parentId });
    try { await api(`/api/servers/${serverDetail.server.id}/channels/reorder`, { method: 'POST', body: JSON.stringify({ items: list.map((c, index) => ({ id: c.id, position: index, parentId: c.kind === 'CATEGORY' ? null : c.parentId })) }) }); await loadServer(serverDetail.server.id); }
    catch (error) { notify(getErrorMessage(error)); }
  };

  const reorderServer = (dragId: number, dropId: number) => {
    const next = [...servers]; const from = next.findIndex((s) => s.id === dragId), to = next.findIndex((s) => s.id === dropId); if (from < 0 || to < 0 || from === to) return;
    const [item] = next.splice(from, 1); next.splice(to, 0, item); setServers(next); localStorage.setItem('opencord.serverOrder', JSON.stringify(next.map((s) => s.id)));
  };

  if (me === undefined) return <div className="splash"><div className="brand-mark">O</div><div>OpenCord</div></div>;
  if (!me) return <AuthScreen onAuthenticated={setMe} />;

  return (
    <div className={`app-shell ${mobileNavOpen ? 'mobile-nav-open' : ''} ${selectedChannel?.kind === 'VOICE' ? 'in-voice' : ''}`} onContextMenu={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
      <div className="mobile-topbar">
        <button className="icon-button" onClick={() => setMobileNavOpen((value) => !value)} aria-label="Open navigation"><Menu size={21} /></button>
        <div><strong>{serverDetail?.server.name ?? (selectedDm?.user.displayName || selectedGroup?.name || 'OpenCord')}</strong><span>{selectedChannel?.name ?? (selectedServerId ? 'Server' : 'Home')}</span></div>
        {selectedServerId && selectedChannel?.kind !== 'VOICE' ? <button className="icon-button" onClick={() => setMembersVisible((value) => !value)} aria-label="Members"><Users size={19} /></button> : <span />}
      </div>

      {mobileNavOpen && <button type="button" className="mobile-nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <aside className="server-rail">
        <button className={`server-button home-button ${selectedServerId === null && !selectedDm && !selectedGroup ? 'active' : ''}`} onClick={openHome} title="Home"><Home size={24} /></button>
        <div className="rail-divider" />
        {servers.map((serverItem) => <button key={serverItem.id} draggable className={`server-button ${selectedServerId === serverItem.id ? 'active' : ''}`} onDragStart={(event) => event.dataTransfer.setData('text/server-id', String(serverItem.id))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => reorderServer(Number(event.dataTransfer.getData('text/server-id')), serverItem.id)} onPointerDown={(event) => longPress.start(event, (contextEvent) => showContext(contextEvent, [
          { label: 'Open server', onClick: () => setSelectedServerId(serverItem.id) }, { label: 'Copy invite', onClick: () => void navigator.clipboard.writeText(serverItem.inviteCode).then(() => notify('Invite copied.')) }, { label: 'Settings', disabled: serverItem.id !== selectedServerId, onClick: () => setModal({ type: 'server-settings' }) },
        ]))} onPointerUp={longPress.cancel} onPointerCancel={longPress.cancel} onPointerMove={longPress.move} onClick={() => { if (longPress.consumeClick()) return; setMobileNavOpen(false); setSelectedDm(null); setSelectedGroup(null); setSelectedServerId(serverItem.id); }} onContextMenu={(event) => showContext(event, [
          { label: 'Open server', onClick: () => setSelectedServerId(serverItem.id) }, { label: 'Copy invite', onClick: () => void navigator.clipboard.writeText(serverItem.inviteCode).then(() => notify('Invite copied.')) }, { label: 'Settings', disabled: serverItem.id !== selectedServerId, onClick: () => setModal({ type: 'server-settings' }) },
        ])} title={serverItem.name}>
          {serverItem.iconPath ? <img src={serverItem.iconPath} alt="" /> : <span>{serverItem.name.slice(0, 2).toUpperCase()}</span>}{serverItem.unreadCount > 0 && <b className="server-unread">{Math.min(99, serverItem.unreadCount)}</b>}
        </button>)}
        <button className="server-button add-server" onClick={() => setModal({ type: 'server' })} title="Add server"><Plus size={24} /></button>
      </aside>

      <aside className="channel-sidebar">
        {selectedServerId && serverDetail ? <ServerSidebar detail={serverDetail} selectedChannelId={selectedChannel?.id ?? null} onChannel={openChannel} onSettings={() => setModal({ type: 'server-settings' })} onContext={channelContext} onMemberContext={memberContext} onProfile={(userId) => setModal({ type: 'user-profile', userId })} onReorder={reorderChannel} onMoveVoice={async (userId, channelId) => { if (!can(serverDetail.myPermissions, Permission.MANAGE_SERVER)) return; try { await api(`/api/servers/${serverDetail.server.id}/voice/${userId}`, { method: 'POST', body: JSON.stringify({ action: 'move', channelId }) }); } catch (error) { notify(getErrorMessage(error)); } }} /> : <HomeSidebar friends={friends} groups={groups} selectedDmId={selectedDm?.user.id ?? null} selectedGroupId={selectedGroup?.id ?? null} onDm={openDm} onGroup={openGroup} onFriends={() => { setSelectedDm(null); setSelectedGroup(null); }} onCreateGroup={() => setModal({ type: 'server' })} />}
        {voice.channelId && <div className="voice-status"><div><strong>Voice Connected</strong><span>{serverDetail?.channels.find((channel) => channel.id === voice.channelId)?.name ?? 'Voice'} · {voice.latency ?? '—'} ms</span></div><button className="icon-button danger" onClick={leaveVoiceAndExit} title="Disconnect"><PhoneOff size={18} /></button></div>}
        <div className="user-panel" onContextMenu={(event) => showContext(event, [{ label: 'My profile', onClick: () => setModal({ type: 'user-profile', userId: me.id }) }, { label: 'Settings', onClick: () => setModal({ type: 'user-settings' }) }, { label: 'Log out', danger: true, onClick: () => void logout() }])}>
          <button className="avatar-button" onClick={() => setModal({ type: 'user-profile', userId: me.id })}><Avatar user={me} size={34} /></button><div className="user-panel-name"><strong>{me.displayName}</strong><span>@{me.username}</span></div>
          <button className="icon-button" onClick={voice.toggleMute} disabled={!voice.channelId} title={voice.muted ? 'Enable microphone' : 'Mute'}>{voice.muted || voice.serverMuted ? <MicOff size={17} /> : <Mic size={17} />}</button>
          <button className="icon-button" onClick={voice.toggleDeafen} disabled={!voice.channelId} title={voice.deafened ? 'Ouvir' : 'Deafen'}>{voice.deafened ? <VolumeX size={17} /> : <Headphones size={17} />}</button>
          <button className="icon-button" onClick={() => setModal({ type: 'user-settings' })} title="Settings"><Settings size={17} /></button>
        </div>
      </aside>

      <main className="content-area">
        {selectedServerId && serverDetail ? selectedChannel?.kind === 'VOICE' ? <VoiceView me={me} channel={selectedChannel} detail={serverDetail} voice={voice} notify={notify} onLeave={leaveVoiceAndExit} /> : selectedChannel?.kind === 'TEXT' ? <ChatView me={me} channel={selectedChannel} server={serverDetail} messages={messages} hasMore={messagesHasMore} onOlder={async () => {
          const first = messages[0]; if (!first) return; const data = await api<{ messages: Message[]; hasMore: boolean }>(`/api/channels/${selectedChannel.id}/messages?before=${first.id}`); setMessages((current) => [...data.messages, ...current]); setMessagesHasMore(data.hasMore);
        }} onMessages={setMessages} onProfile={(user) => setModal({ type: 'user-profile', userId: user.id })} onContext={showContext} notify={notify} typingUsers={typingUsers} endRef={messageEndRef} draftInsertion={draftInsertion} toggleMembers={() => setMembersVisible((value) => !value)} /> : <EmptyState title="No channel" text="Create or select a channel to get started." />
        : selectedDm ? <DmView me={me} friend={selectedDm.user} messages={dmMessages} hasMore={dmHasMore} onMessages={setDmMessages} onOlder={async () => { const first = dmMessages[0]; if (!first) return; const data = await api<{ messages: DirectMessage[]; hasMore: boolean }>(`/api/dms/${selectedDm.user.id}?before=${first.id}`); setDmMessages((current) => [...data.messages, ...current]); setDmHasMore(data.hasMore); }} onProfile={(user) => setModal({ type: 'user-profile', userId: user.id })} typingUsers={typingUsers} endRef={messageEndRef} notify={notify} />
        : selectedGroup ? <GroupDmView me={me} group={selectedGroup} messages={groupMessages} setMessages={setGroupMessages} onProfile={(user) => setModal({ type: 'user-profile', userId: user.id })} endRef={messageEndRef} notify={notify} />
        : <FriendsView friends={friends} groups={groups} query={friendQuery} setQuery={setFriendQuery} results={friendResults} setResults={setFriendResults} reload={loadFriends} reloadGroups={loadGroups} onProfile={(user) => setModal({ type: 'user-profile', userId: user.id })} onDm={openDmUser} onGroup={openGroup} notify={notify} />}
      </main>

      {selectedServerId && serverDetail && membersVisible && selectedChannel?.kind !== 'VOICE' && <MembersPanel detail={serverDetail} onProfile={(member) => setModal({ type: 'user-profile', userId: member.id })} onContext={memberContext} />}

      {modal?.type === 'user-settings' && <UserSettingsModal me={me} onClose={() => setModal(null)} onUpdated={setMe} onLoggedOut={() => void logout()} notify={notify} switchInputDevice={voice.switchInputDevice} />}
      {modal?.type === 'server' && <ServerModal friends={friends} onClose={() => setModal(null)} afterChange={async (serverId) => { await loadServers(); setSelectedServerId(serverId); setModal(null); }} afterGroup={async (groupId) => { await loadGroups(); const group = (await api<{ groups: DmGroupSummary[] }>('/api/dm-groups')).groups.find((g) => g.id === groupId); if (group) await openGroup(group); setModal(null); }} notify={notify} />}
      {modal?.type === 'server-settings' && serverDetail && <ServerSettingsModal detail={serverDetail} meId={me.id} onClose={() => setModal(null)} reload={() => loadServer(serverDetail.server.id)} notify={notify} onServerGone={openHome} />}
      {modal?.type === 'user-profile' && <UserProfileModal me={me} userId={modal.userId} onClose={() => setModal(null)} onOpenDm={openDmUser} reloadFriends={loadFriends} notify={notify} />}
      {modal?.type === 'member-manage' && serverDetail && <MemberManageModal detail={serverDetail} member={modal.member} onClose={() => setModal(null)} reload={() => loadServer(serverDetail.server.id)} notify={notify} />}
      {modal?.type === 'server-profile' && serverDetail && <ServerProfileModal me={me} detail={serverDetail} onClose={() => setModal(null)} reload={() => loadServer(serverDetail.server.id)} notify={notify} />}
      {contextMenu && <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
      <button className="logout-fab" onClick={() => void logout()} title="Log out"><LogOut size={18} /></button>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [instance, setInstance] = useState({ name: 'OpenCord', logo: '' });
  useEffect(() => { void api<{ name: string; logo: string }>('/api/instance').then((data) => setInstance({ name: data.name, logo: data.logo })).catch(() => undefined); }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); const formData = new FormData(event.currentTarget); const body: Record<string, unknown> = Object.fromEntries(formData.entries()); if (mode === 'register') body.acceptTerms = formData.get('acceptTerms') === 'true';
    try { const data = await api<{ user: User }>(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) }); onAuthenticated(data.user); }
    catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  };
  return <div className="auth-page"><div className="auth-card"><div className="auth-brand">{instance.logo ? <img className="auth-instance-logo" src={instance.logo} alt="" /> : <div className="brand-mark">O</div>}<div><strong>{instance.name}</strong><span>your place to talk</span></div></div><h1>{mode === 'login' ? 'Welcome back.' : 'Create an account.'}</h1><p>{mode === 'login' ? 'We missed you.' : 'Join this self-hosted community.'}</p><form onSubmit={submit} className="form-stack">{mode === 'register' && <label>DISPLAY NAME<input name="displayName" minLength={1} maxLength={32} required autoComplete="nickname" /></label>}<label>USERNAME<input name="username" minLength={3} maxLength={24} required autoComplete="username" /></label><label>PASSWORD<input name="password" type="password" minLength={8} maxLength={128} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>{mode === 'register' && <label className="legal-consent"><input type="checkbox" name="acceptTerms" value="true" required /><span>I agree to the <a href="/legal/terms.html" target="_blank" rel="noreferrer">Terms of Use</a> and <a href="/legal/acceptable-use.html" target="_blank" rel="noreferrer">Acceptable Use Policy</a>.</span></label>}{error && <div className="form-error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Please wait...' : mode === 'login' ? 'Login' : 'Create account'}</button></form><button className="link-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Need an account? Register' : 'Already have an account? Login'}</button><div className="auth-legal-links"><a href="/legal/terms.html" target="_blank" rel="noreferrer">Terms</a><span>·</span><a href="/legal/acceptable-use.html" target="_blank" rel="noreferrer">Acceptable Use</a><span>·</span><a href="/legal/privacy.html" target="_blank" rel="noreferrer">Privacy</a></div></div></div>;
}

function HomeSidebar({ friends, groups, selectedDmId, selectedGroupId, onDm, onGroup, onFriends, onCreateGroup }: { friends: FriendsPayload; groups: DmGroupSummary[]; selectedDmId: number | null; selectedGroupId: number | null; onDm: (entry: FriendEntry) => void; onGroup: (group: DmGroupSummary) => void; onFriends: () => void; onCreateGroup: () => void }) {
  return <><div className="sidebar-title">Direct Messages</div><div className="sidebar-scroll"><button className={`nav-row ${selectedDmId === null && selectedGroupId === null ? 'active' : ''}`} onClick={onFriends}><Users size={18} /><span>Friends</span>{friends.incoming.length > 0 && <b className="badge">{friends.incoming.length}</b>}</button><div className="section-label"><span>DIRECT MESSAGES</span><button className="mini-icon" onClick={onCreateGroup} title="New group"><CirclePlus size={14} /></button></div>{friends.accepted.map((entry) => <button key={entry.friendshipId} className={`dm-row ${selectedDmId === entry.user.id ? 'active' : ''}`} onClick={() => onDm(entry)}><div className="avatar-wrap"><Avatar user={entry.user} size={30} /><span className={`presence-dot small ${entry.user.presence}`} /></div><div><strong>{entry.user.displayName}</strong><span>{entry.user.statusText || `@${entry.user.username}`}</span></div>{entry.unreadCount > 0 && <b className="badge dm-unread">{Math.min(99, entry.unreadCount)}</b>}</button>)}{groups.map((group) => <button key={`g-${group.id}`} className={`dm-row ${selectedGroupId === group.id ? 'active' : ''}`} onClick={() => onGroup(group)}><div className="group-avatar"><Users size={16} /></div><div><strong>{group.name}</strong><span>{group.memberCount} members</span></div></button>)}</div></>;
}

function ServerSidebar({ detail, selectedChannelId, onChannel, onSettings, onContext, onMemberContext, onProfile, onReorder, onMoveVoice }: { detail: ServerDetail; selectedChannelId: number | null; onChannel: (channel: Channel) => void; onSettings: () => void; onContext: (event: ReactMouseEvent, channel: Channel) => void; onMemberContext: (event: ReactMouseEvent, member: Member) => void; onProfile: (userId: number) => void; onReorder: (dragId: number, dropId: number, parentId?: number | null) => Promise<void>; onMoveVoice: (userId: number, channelId: number) => Promise<void> }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set(JSON.parse(localStorage.getItem(`opencord.collapsed.${detail.server.id}`) ?? '[]')));
  const longPress = useLongPressContext();
  const categories = detail.channels.filter((channel) => channel.kind === 'CATEGORY').sort((a, b) => a.position - b.position);
  const orphans = detail.channels.filter((channel) => channel.kind !== 'CATEGORY' && !channel.parentId).sort((a, b) => a.position - b.position);
  const toggle = (id: number) => setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); localStorage.setItem(`opencord.collapsed.${detail.server.id}`, JSON.stringify([...next])); return next; });
  return <><button className="server-header" onClick={onSettings}><span>{detail.server.name}</span><ChevronDown size={16} /></button>{detail.server.bannerPath && <div className="sidebar-server-banner" style={{ backgroundImage: `url(${detail.server.bannerPath})` }} />}<div className="sidebar-scroll channel-list">{orphans.map((channel) => <ChannelRow key={channel.id} channel={channel} active={selectedChannelId === channel.id} voiceStates={detail.voiceStates} members={detail.members} onClick={() => onChannel(channel)} onContext={onContext} onMemberContext={onMemberContext} onProfile={onProfile} onReorder={onReorder} onMoveVoice={onMoveVoice} />)}{categories.map((category) => <section key={category.id} className="channel-category" draggable={can(detail.myPermissions, Permission.MANAGE_CHANNELS)} onDragStart={(event) => event.dataTransfer.setData('text/channel-id', String(category.id))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = Number(event.dataTransfer.getData('text/channel-id')); if (id && id !== category.id) void onReorder(id, category.id, category.id); }}><button className="section-label category-button" onPointerDown={(event) => longPress.start(event, (contextEvent) => onContext(contextEvent, category))} onPointerUp={longPress.cancel} onPointerCancel={longPress.cancel} onPointerMove={longPress.move} onClick={() => { if (longPress.consumeClick()) return; toggle(category.id); }} onContextMenu={(event) => onContext(event, category)}>{collapsed.has(category.id) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}<span>{category.name}</span></button>{!collapsed.has(category.id) && detail.channels.filter((channel) => channel.parentId === category.id).sort((a, b) => a.position - b.position).map((channel) => <ChannelRow key={channel.id} channel={channel} active={selectedChannelId === channel.id} voiceStates={detail.voiceStates} members={detail.members} onClick={() => onChannel(channel)} onContext={onContext} onMemberContext={onMemberContext} onProfile={onProfile} onReorder={onReorder} onMoveVoice={onMoveVoice} />)}</section>)}</div></>;
}

function ChannelRow({ channel, active, voiceStates, members, onClick, onContext, onMemberContext, onProfile, onReorder, onMoveVoice }: { channel: Channel; active: boolean; voiceStates: VoiceState[]; members: Member[]; onClick: () => void; onContext: (event: ReactMouseEvent, channel: Channel) => void; onMemberContext: (event: ReactMouseEvent, member: Member) => void; onProfile: (userId: number) => void; onReorder: (dragId: number, dropId: number, parentId?: number | null) => Promise<void>; onMoveVoice: (userId: number, channelId: number) => Promise<void> }) {
  const states = channel.kind === 'VOICE' ? voiceStates.filter((state) => state.channelId === channel.id) : [];
  const longPress = useLongPressContext();
  return <div className="channel-with-users"><button draggable className={`channel-row ${active ? 'active' : ''}`} onDragStart={(event) => event.dataTransfer.setData('text/channel-id', String(channel.id))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const voiceUserId = Number(event.dataTransfer.getData('text/voice-user-id')); if (voiceUserId && channel.kind === 'VOICE') { void onMoveVoice(voiceUserId, channel.id); return; } const id = Number(event.dataTransfer.getData('text/channel-id')); if (id && id !== channel.id) void onReorder(id, channel.id, channel.parentId); }} onPointerDown={(event) => longPress.start(event, (contextEvent) => onContext(contextEvent, channel))} onPointerUp={longPress.cancel} onPointerCancel={longPress.cancel} onPointerMove={longPress.move} onClick={() => { if (longPress.consumeClick()) return; onClick(); }} onContextMenu={(event) => onContext(event, channel)}>{channel.kind === 'TEXT' ? <Hash size={17} /> : <Volume2 size={17} />}<span>{channel.name}</span>{channel.kind === 'VOICE' && channel.userLimit > 0 && <small>{states.length}/{channel.userLimit}</small>}</button>{states.map((state) => { const member = members.find((m) => m.id === state.userId); if (!member) return null; return <button draggable className="voice-user-row" key={`${channel.id}-${state.userId}`} onDragStart={(event) => event.dataTransfer.setData('text/voice-user-id', String(member.id))} onPointerDown={(event) => longPress.start(event, (contextEvent) => onMemberContext(contextEvent, member))} onPointerUp={longPress.cancel} onPointerCancel={longPress.cancel} onPointerMove={longPress.move} onClick={() => { if (longPress.consumeClick()) return; onProfile(member.id); }} onContextMenu={(event) => onMemberContext(event, member)}><Avatar user={member} size={24} /><span>{member.nickname || member.displayName}</span>{state.selfMuted || state.serverMuted ? <MicOff size={13} /> : null}{state.selfDeafened || state.serverDeafened ? <VolumeX size={13} /> : null}</button>; })}</div>;
}

function ChatView({ me, channel, server, messages, hasMore, onOlder, onMessages, onProfile, onContext, notify, typingUsers, endRef, draftInsertion, toggleMembers }: { me: User; channel: Channel; server: ServerDetail; messages: Message[]; hasMore: boolean; onOlder: () => Promise<void>; onMessages: React.Dispatch<React.SetStateAction<Message[]>>; onProfile: (user: User) => void; onContext: (event: ReactMouseEvent, items: ContextMenuItem[]) => void; notify: (message: string) => void; typingUsers: User[]; endRef: RefObject<HTMLDivElement | null>; draftInsertion: { value: string; token: number } | null; toggleMembers: () => void }) {
  const [replying, setReplying] = useState<Message | null>(null); const [searchOpen, setSearchOpen] = useState(false); const [pinsOpen, setPinsOpen] = useState(false); const [searchResults, setSearchResults] = useState<Message[]>([]); const [pins, setPins] = useState<Message[]>([]);
  const canManage = can(server.myPermissions, Permission.MANAGE_MESSAGES);
  const send = async (content: string, files: File[]) => {
    const form = new FormData(); form.set('content', content); if (replying) form.set('replyToId', String(replying.id)); for (const file of files) form.append('files', file);
    try { await api(`/api/channels/${channel.id}/messages`, { method: 'POST', body: form }); setReplying(null); }
    catch (error) { notify(getErrorMessage(error)); throw error; }
  };
  const edit = async (message: Message) => { const content = prompt('Edit message:', message.content); if (!content || content === message.content) return; try { await api(`/api/messages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }); } catch (error) { notify(getErrorMessage(error)); } };
  const remove = async (message: Message) => { if (!confirm('Delete this message?')) return; try { await api(`/api/messages/${message.id}`, { method: 'DELETE' }); } catch (error) { notify(getErrorMessage(error)); } };
  const pin = async (message: Message) => { try { await api(`/api/messages/${message.id}/pin`, { method: message.pinned ? 'DELETE' : 'PUT' }); } catch (error) { notify(getErrorMessage(error)); } };
  const react = async (message: Message, emoji: string, mine: boolean) => {
    let selected = emoji === '__pick__' ? prompt('Emoji or :custom_name:', '👍') : emoji;
    if (!selected) return;
    const named = /^:([a-z0-9_]{2,32}):$/i.exec(selected.trim());
    if (named) {
      if (!me.premium?.benefits.externalReactions) return notify('Your plan does not include custom emoji reactions.');
      try {
        const data = await api<{ emojis: CustomEmoji[] }>(`/api/emojis?search=${encodeURIComponent(named[1])}`);
        const match = data.emojis.find((item) => item.name.toLowerCase() === named[1].toLowerCase());
        if (!match) return notify('Custom emoji not found.');
        selected = match.token;
      } catch (error) { return notify(getErrorMessage(error)); }
    }
    try { await api(`/api/messages/${message.id}/reactions/${encodeURIComponent(selected)}`, { method: mine ? 'DELETE' : 'PUT' }); } catch (error) { notify(getErrorMessage(error)); }
  };
  const messageContext = (event: ReactMouseEvent, message: Message) => onContext(event, [
    { label: 'Reply', onClick: () => setReplying(message) }, { label: 'Add reaction', onClick: () => void react(message, '__pick__', false) }, { label: message.pinned ? 'Unpin' : 'Pin', disabled: !canManage, onClick: () => void pin(message) }, { separator: true, label: '' }, { label: 'Edit', disabled: message.author.id !== me.id, onClick: () => void edit(message) }, { label: 'Delete', danger: true, disabled: message.author.id !== me.id && !canManage, onClick: () => void remove(message) },
  ]);
  const search = async (query: string) => { if (query.trim().length < 2) return setSearchResults([]); try { setSearchResults((await api<{ messages: Message[] }>(`/api/channels/${channel.id}/messages/search?q=${encodeURIComponent(query)}`)).messages); } catch (error) { notify(getErrorMessage(error)); } };
  const loadPins = async () => { try { setPins((await api<{ messages: Message[] }>(`/api/channels/${channel.id}/pins`)).messages); setPinsOpen(true); } catch (error) { notify(getErrorMessage(error)); } };
  return <div className="chat-layout"><header className="content-header"><Hash size={20} /><strong>{channel.name}</strong><span>{channel.topic || server.server.name}</span><div className="header-actions"><button className="icon-button" onClick={loadPins} title="Pinned messages"><Pin size={18} /></button><button className="icon-button" onClick={() => setSearchOpen(!searchOpen)} title="Search"><Search size={18} /></button><button className="icon-button" onClick={toggleMembers} title="Members"><Users size={18} /></button></div></header>{searchOpen && <div className="search-bar"><Search size={17} /><input autoFocus placeholder="Search this channel" onChange={(e) => void search(e.target.value)} /><button className="icon-button" onClick={() => { setSearchOpen(false); setSearchResults([]); }}><X size={17} /></button></div>}<div className="messages-scroll">{hasMore && <button className="load-older" onClick={() => void onOlder()}>Load older messages</button>}<div className="channel-welcome"><div className="welcome-icon"><Hash size={30} /></div><h2>Welcome to #{channel.name}</h2><p>{channel.topic || 'This is the start of the channel.'}</p></div>{(searchOpen && searchResults.length ? searchResults : messages).map((message) => <MessageRow key={message.id} message={message} currentUser={me} canManage={canManage} onProfile={onProfile} onReply={setReplying} onEdit={(m) => void edit(m)} onDelete={(m) => void remove(m)} onPin={(m) => void pin(m)} onReact={(m, e, mine) => void react(m, e, mine)} onContext={messageContext} />)}<div ref={endRef} /></div>{typingUsers.length > 0 && <div className="typing-indicator"><b>{typingUsers.slice(0, 2).map((u) => u.displayName).join(', ')}</b> {typingUsers.length > 2 ? 'and others are' : typingUsers.length > 1 ? 'are' : 'is'} typing...</div>}<MessageComposer currentUser={me} placeholder={`Message #${channel.name}`} onSend={send} allowFiles reply={replying} onCancelReply={() => setReplying(null)} onTyping={() => socket.emit('typing:channel', { channelId: channel.id })} insertion={draftInsertion} />{pinsOpen && <SideDrawer title="Pinned messages" onClose={() => setPinsOpen(false)}>{pins.length ? pins.map((message) => <MessageRow key={message.id} message={message} currentUser={me} canManage={canManage} onProfile={onProfile} onReply={setReplying} onEdit={(m) => void edit(m)} onDelete={(m) => void remove(m)} onPin={(m) => void pin(m)} onReact={(m, e, mine) => void react(m, e, mine)} onContext={messageContext} />) : <div className="empty-mini">No pinned messages.</div>}</SideDrawer>}</div>;
}

function MessageComposer({ currentUser, placeholder, onSend, reply, onCancelReply, onTyping, insertion, allowFiles = false }: { currentUser: User; placeholder: string; onSend: (content: string, files: File[]) => Promise<void> | void; reply?: Message | null; onCancelReply?: () => void; onTyping?: () => void; insertion?: { value: string; token: number } | null; allowFiles?: boolean }) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState('');
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoriteLimit, setFavoriteLimit] = useState(20);
  const [sending, setSending] = useState(false);
  const [fileNotice, setFileNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const fileLimit = currentUser.premium?.benefits.maxFilesPerMessage ?? 5;

  useEffect(() => {
    if (!insertion?.value) return;
    setValue((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${insertion.value}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [insertion?.token]);

  const loadEmojis = useCallback(async (search = '') => {
    try {
      const data = await api<{ emojis: CustomEmoji[]; favorites: string[]; favoriteLimit: number }>(`/api/emojis?search=${encodeURIComponent(search)}`);
      setEmojis(data.emojis); setFavorites(data.favorites); setFavoriteLimit(data.favoriteLimit);
    } catch { setEmojis([]); }
  }, []);

  useEffect(() => {
    if (!emojiOpen) return;
    const timer = window.setTimeout(() => void loadEmojis(emojiSearch), 160);
    return () => window.clearTimeout(timer);
  }, [emojiOpen, emojiSearch, loadEmojis]);

  const insertEmoji = (token: string) => {
    setValue((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${token} `);
    setEmojiOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const toggleFavorite = async (token: string) => {
    const isFavorite = favorites.includes(token);
    try {
      await api('/api/me/emoji-favorites', { method: isFavorite ? 'DELETE' : 'PUT', body: JSON.stringify({ value: token }) });
      setFavorites((current) => isFavorite ? current.filter((item) => item !== token) : [token, ...current]);
    } catch (error) { window.alert(getErrorMessage(error)); }
  };

  const sendCurrent = async () => {
    if (sending || (!value.trim() && files.length === 0)) return;
    setSending(true);
    try {
      await onSend(value.trim(), files);
      setValue('');
      setFiles([]);
      setFileNotice('');
      if (fileRef.current) fileRef.current.value = '';
      if (textareaRef.current) textareaRef.current.style.height = '';
    } finally {
      setSending(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await sendCurrent();
  };

  const selectFiles = (selected: FileList | null) => {
    if (!selected) return;
    const incoming = [...selected];
    const next = [...files, ...incoming].slice(0, fileLimit);
    setFiles(next);
    setFileNotice(files.length + incoming.length > fileLimit ? `You can attach up to ${fileLimit} files per message.` : '');
    if (fileRef.current) fileRef.current.value = '';
  };

  const baseEmojis = ['👍', '❤️', '😂', '🔥', '🎉', '😎', '😭', '💀', '✅', '✨'];
  return <div className="composer-wrap">
    {reply && <div className="replying-bar"><span>Replying to <strong>{reply.author.displayName}</strong></span><button type="button" className="icon-button" onClick={onCancelReply} aria-label="Cancel reply"><X size={15} /></button></div>}
    {files.length > 0 && <div className="pending-files"><div className="pending-files-head"><strong>Attachments</strong><span>{files.length}/{fileLimit}</span></div><div className="pending-files-grid">{files.map((file, index) => <PendingAttachment key={`${file.name}-${file.lastModified}-${index}`} file={file} onRemove={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</div></div>}
    {fileNotice && <div className="composer-notice">{fileNotice}</div>}
    {emojiOpen && <div className="emoji-picker">
      <div className="emoji-picker-head"><strong>Emojis</strong><span>{favorites.length}/{favoriteLimit} favorites</span></div>
      <input value={emojiSearch} onChange={(event) => setEmojiSearch(event.target.value)} placeholder="Search emojis" autoFocus />
      {favorites.length > 0 && <><div className="emoji-picker-section-title">Favorites</div><div className="emoji-favorites-grid">{favorites.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} title={emoji}><EmojiVisual value={emoji} /></button>)}</div></>}
      <div className="emoji-picker-section-title">Default</div>
      <div className="emoji-base-grid">{baseEmojis.map((emoji) => <div className="emoji-base-item" key={emoji}><button type="button" className="emoji-base-main" onClick={() => insertEmoji(emoji)}>{emoji}</button><button type="button" className={`emoji-base-star ${favorites.includes(emoji) ? 'active' : ''}`} onClick={() => void toggleFavorite(emoji)} title="Favorite"><Star size={10} fill={favorites.includes(emoji) ? 'currentColor' : 'none'} /></button></div>)}</div>
      {currentUser.premium?.benefits.externalEmojis && <div className="custom-emoji-list">{emojis.map((emoji) => <div className="emoji-picker-item" key={emoji.id}><button type="button" className="emoji-main" onClick={() => insertEmoji(emoji.token)}><img src={emoji.imagePath} alt={`:${emoji.name}:`} /><span>:{emoji.name}:</span></button><button type="button" className={`emoji-favorite ${favorites.includes(emoji.token) ? 'active' : ''}`} title="Favorite" onClick={() => void toggleFavorite(emoji.token)}><Star size={14} fill={favorites.includes(emoji.token) ? 'currentColor' : 'none'} /></button></div>)}</div>}
      {!currentUser.premium?.benefits.externalEmojis && <div className="emoji-premium-hint">Custom emojis are available with this instance's premium plan.</div>}
    </div>}
    <form className="composer" onSubmit={submit}>
      {allowFiles && <><button type="button" className="composer-plus" onClick={() => fileRef.current?.click()} title="Attach files" aria-label="Attach files"><Plus size={20} /></button><input ref={fileRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,application/zip,audio/mpeg,audio/ogg,video/mp4" onChange={(event) => selectFiles(event.target.files)} /></>}
      <textarea ref={textareaRef} name="message" rows={1} value={value} onChange={(event) => { setValue(event.target.value); if (onTyping && Date.now() - lastTyping.current > 900) { lastTyping.current = Date.now(); onTyping(); } }} onInput={(event) => { const target = event.currentTarget; target.style.height = 'auto'; target.style.height = `${Math.min(target.scrollHeight, 144)}px`; }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendCurrent(); } }} maxLength={4000} autoComplete="off" placeholder={placeholder} />
      <button type="button" className={`composer-emoji ${emojiOpen ? 'active' : ''}`} onClick={() => setEmojiOpen((open) => !open)} title="Emojis" aria-label="Open emoji picker"><Smile size={20} /></button>
      <button type="submit" className="composer-send" disabled={sending || (!value.trim() && files.length === 0)} title="Send message" aria-label="Send message"><SendHorizontal size={18} /></button>
    </form>
  </div>;
}

function DmView({ me, friend, messages, hasMore, onMessages, onOlder, onProfile, typingUsers, endRef, notify }: { me: User; friend: User; messages: DirectMessage[]; hasMore: boolean; onMessages: React.Dispatch<React.SetStateAction<DirectMessage[]>>; onOlder: () => Promise<void>; onProfile: (user: User) => void; typingUsers: User[]; endRef: RefObject<HTMLDivElement | null>; notify: (message: string) => void }) {
  const send = async (content: string) => { try { await api(`/api/dms/${friend.id}`, { method: 'POST', body: JSON.stringify({ content }) }); } catch (error) { notify(getErrorMessage(error)); throw error; } };
  const edit = async (message: DirectMessage) => { const content = prompt('Edit message:', message.content); if (!content || content === message.content) return; try { await api(`/api/dms/messages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }); } catch (error) { notify(getErrorMessage(error)); } };
  const remove = async (message: DirectMessage) => { if (!confirm('Delete this message?')) return; try { await api(`/api/dms/messages/${message.id}`, { method: 'DELETE' }); onMessages((current) => current.filter((m) => m.id !== message.id)); } catch (error) { notify(getErrorMessage(error)); } };
  return <div className="chat-layout"><header className="content-header"><button className="avatar-button" onClick={() => onProfile(friend)}><Avatar user={friend} size={26} /></button><strong>{friend.displayName}</strong><span>@{friend.username}</span></header><div className="messages-scroll">{hasMore && <button className="load-older" onClick={() => void onOlder()}>Load older messages</button>}<div className="dm-welcome"><button className="avatar-button" onClick={() => onProfile(friend)}><Avatar user={friend} size={74} /></button><h2>{friend.displayName}</h2><p>This is the beginning of your direct message history with @{friend.username}.</p></div>{messages.map((message) => <div className="message-row" key={message.id}><button className="avatar-button" onClick={() => onProfile(message.sender)}><Avatar user={message.sender} size={40} /></button><div className="message-body"><div className="message-meta"><strong>{message.sender.displayName}</strong><span>{normalizedDate(message.createdAt).toLocaleString('en-US')}{message.editedAt ? ' · edited' : ''}</span></div><div className="message-content"><RichContent content={message.content} currentUser={me} /></div></div>{message.sender.id === me.id && <div className="message-actions"><button onClick={() => void edit(message)}><Edit3 size={15} /></button><button onClick={() => void remove(message)}><Trash2 size={15} /></button></div>}</div>)}<div ref={endRef} /></div>{typingUsers.length > 0 && <div className="typing-indicator"><b>{typingUsers[0].displayName}</b> is typing...</div>}<MessageComposer currentUser={me} placeholder={`Message @${friend.username}`} onSend={(content) => send(content)} onTyping={() => socket.emit('typing:dm', { userId: friend.id })} /></div>;
}

function GroupDmView({ me, group, messages, setMessages, onProfile, endRef, notify }: { me: User; group: DmGroupDetail; messages: DmGroupMessage[]; setMessages: React.Dispatch<React.SetStateAction<DmGroupMessage[]>>; onProfile: (user: User) => void; endRef: RefObject<HTMLDivElement | null>; notify: (message: string) => void }) {
  const send = async (content: string) => { try { const data = await api<{ message: DmGroupMessage }>(`/api/dm-groups/${group.id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }); setMessages((current) => current.some((m) => m.id === data.message.id) ? current : [...current, data.message]); } catch (error) { notify(getErrorMessage(error)); throw error; } };
  return <div className="chat-layout"><header className="content-header"><Users size={20} /><strong>{group.name}</strong><span>{group.members.length} members</span></header><div className="messages-scroll"><div className="dm-welcome"><div className="group-avatar large"><Users /></div><h2>{group.name}</h2><p>Group with {group.members.map((m) => m.displayName).join(', ')}.</p></div>{messages.map((message) => <div className="message-row" key={message.id}><button className="avatar-button" onClick={() => onProfile(message.author)}><Avatar user={message.author} size={40} /></button><div className="message-body"><div className="message-meta"><strong>{message.author.displayName}</strong><span>{normalizedDate(message.createdAt).toLocaleString('en-US')}</span></div><div className="message-content"><RichContent content={message.content} currentUser={me} /></div></div>{message.author.id === me.id && <span className="mine-marker">you</span>}</div>)}<div ref={endRef} /></div><MessageComposer currentUser={me} placeholder={`Message ${group.name}`} onSend={(content) => send(content)} /></div>;
}

function ServerProfileModal({ me, detail, onClose, reload, notify }: { me: User; detail: ServerDetail; onClose: () => void; reload: () => Promise<void>; notify: (message: string) => void }) {
  const member = detail.members.find((item) => item.id === me.id);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api(`/api/servers/${detail.server.id}/me-profile`, { method: 'PUT', body: new FormData(event.currentTarget) });
      await reload();
      notify('Server profile updated.');
      onClose();
    } catch (error) { notify(getErrorMessage(error)); }
  };
  return <Modal title={`Profile in ${detail.server.name}`} onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <div className="server-profile-preview"><Avatar user={member ?? me} size={72} /><div><strong>{member?.nickname || member?.displayName || me.displayName}</strong><span>Server-specific profile</span></div></div>
      <label>SERVER DISPLAY NAME<input name="displayName" maxLength={32} defaultValue={member?.displayName ?? me.displayName} /></label>
      <label>SERVER BIO<textarea name="bio" maxLength={600} rows={4} defaultValue={member?.bio ?? me.bio} /></label>
      <ImageUploadField name="avatar" label="SERVER-SPECIFIC AVATAR" currentUrl={member?.avatarPath} accept="image/png,image/jpeg,image/webp,image/gif" />
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button">Save profile</button></div>
    </form>
  </Modal>;
}

function FriendsView({ friends, groups, query, setQuery, results, setResults, reload, reloadGroups, onProfile, onDm, onGroup, notify }: { friends: FriendsPayload; groups: DmGroupSummary[]; query: string; setQuery: (value: string) => void; results: User[]; setResults: (users: User[]) => void; reload: () => Promise<void>; reloadGroups: () => Promise<void>; onProfile: (user: User) => void; onDm: (user: User) => void; onGroup: (group: DmGroupSummary) => void; notify: (message: string) => void }) {
  const [filter, setFilter] = useState<'online' | 'all' | 'pending' | 'blocked'>('online');
  const search = async (event: FormEvent) => { event.preventDefault(); if (query.trim().length < 2) return; try { setResults((await api<{ users: User[] }>(`/api/users/search?q=${encodeURIComponent(query.trim())}`)).users); } catch (error) { notify(getErrorMessage(error)); } };
  const request = async (userId: number) => { try { await api(`/api/friends/request/${userId}`, { method: 'POST' }); notify('Friend request sent.'); await reload(); } catch (error) { notify(getErrorMessage(error)); } };
  const accept = async (friendshipId: number) => { try { await api(`/api/friends/${friendshipId}/accept`, { method: 'POST' }); await reload(); } catch (error) { notify(getErrorMessage(error)); } };
  const list = filter === 'online' ? friends.accepted.filter((e) => e.user.presence !== 'offline') : friends.accepted;
  return <div className="friends-page"><header className="content-header"><Users size={20} /><strong>Friends</strong><div className="friends-tabs"><button className={filter === 'online' ? 'active' : ''} onClick={() => setFilter('online')}>Online</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>Pending {friends.incoming.length > 0 && <b>{friends.incoming.length}</b>}</button><button className={filter === 'blocked' ? 'active' : ''} onClick={() => setFilter('blocked')}>Blocked</button></div></header><div className="friends-content"><h2>Add Friend</h2><p>Add someone by their OpenCord username.</p><form className="friend-search" onSubmit={search}><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by username" /><button>Search</button></form>{results.length > 0 && <section className="friend-section"><h3>SEARCH RESULTS — {results.length}</h3>{results.map((user) => <div className="friend-row" key={user.id}><button className="avatar-button" onClick={() => onProfile(user)}><Avatar user={user} /></button><div><strong>{user.displayName}</strong><span>@{user.username}</span></div><button className="round-action" onClick={() => request(user.id)}><UserPlus size={18} /></button></div>)}</section>}{filter === 'pending' && <>{friends.incoming.length > 0 && <section className="friend-section"><h3>INCOMING — {friends.incoming.length}</h3>{friends.incoming.map((entry) => <div className="friend-row" key={entry.friendshipId}><button className="avatar-button" onClick={() => onProfile(entry.user)}><Avatar user={entry.user} /></button><div><strong>{entry.user.displayName}</strong><span>Incoming friend request</span></div><button className="round-action accept" onClick={() => accept(entry.friendshipId)}><Check size={18} /></button></div>)}</section>}<section className="friend-section"><h3>OUTGOING — {friends.outgoing.length}</h3>{friends.outgoing.map((entry) => <div className="friend-row" key={entry.friendshipId}><Avatar user={entry.user} /><div><strong>{entry.user.displayName}</strong><span>Request sent</span></div></div>)}</section></>}{filter === 'blocked' ? <section className="friend-section"><h3>BLOCKED — {friends.blocked.length}</h3>{friends.blocked.map((user) => <div className="friend-row" key={user.id}><Avatar user={user} /><div><strong>{user.displayName}</strong><span>@{user.username}</span></div><button className="secondary-button small" onClick={async () => { await api(`/api/blocks/${user.id}`, { method: 'DELETE' }); await reload(); }}>Unblock</button></div>)}</section> : filter !== 'pending' && <section className="friend-section"><h3>{filter === 'online' ? 'ONLINE' : 'ALL FRIENDS'} — {list.length}</h3>{list.map((entry) => <div className="friend-row" key={entry.friendshipId}><button className="avatar-button" onClick={() => onProfile(entry.user)}><div className="avatar-wrap"><Avatar user={entry.user} /><span className={`presence-dot ${entry.user.presence}`} /></div></button><div><strong>{entry.user.displayName}</strong><span>{entry.user.statusText || `@${entry.user.username}`}</span></div><button className="round-action" onClick={() => onDm(entry.user)}><MessageCircle size={18} /></button></div>)}</section>}{groups.length > 0 && <section className="friend-section"><h3>GROUP DMS — {groups.length}</h3>{groups.map((group) => <button className="friend-row clickable-row" onClick={() => onGroup(group)} key={group.id}><div className="group-avatar"><Users size={16} /></div><div><strong>{group.name}</strong><span>{group.memberCount} members</span></div></button>)}</section>}</div></div>;
}

function MembersPanel({ detail, onProfile, onContext }: { detail: ServerDetail; onProfile: (member: Member) => void; onContext: (event: ReactMouseEvent, member: Member) => void }) {
  const longPress = useLongPressContext();
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; color?: string; members: Member[]; position: number }>();
    for (const member of detail.members) {
      const role = member.roles.filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position)[0];
      const key = member.presence === 'offline' ? '__offline' : role ? `role:${role.id}` : '__online';
      const current = map.get(key) ?? { label: member.presence === 'offline' ? 'OFFLINE' : role?.name.toUpperCase() ?? 'ONLINE', color: role?.color, members: [], position: member.presence === 'offline' ? -9999 : role?.position ?? 0 };
      current.members.push(member); map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.position - a.position);
  }, [detail.members]);
  return <aside className="members-panel">{groups.map((group) => <section key={group.label}><div className="member-group-label" style={group.color ? { color: group.color } : undefined}>{group.label} — {group.members.length}</div>{group.members.sort((a, b) => (a.nickname || a.displayName).localeCompare(b.nickname || b.displayName)).map((member) => <button className={`member-row ${member.presence === 'offline' ? 'offline' : ''}`} key={member.id} onPointerDown={(event) => longPress.start(event, (contextEvent) => onContext(contextEvent, member))} onPointerUp={longPress.cancel} onPointerCancel={longPress.cancel} onPointerMove={longPress.move} onClick={() => { if (longPress.consumeClick()) return; onProfile(member); }} onContextMenu={(event) => onContext(event, member)}><div className="avatar-wrap"><Avatar user={member} size={32} /><span className={`presence-dot ${member.presence}`} /></div><div><strong>{member.nickname || member.displayName}</strong><span className="member-badges"><UserBadges badges={member.badges} compact /><PremiumMark premium={member.premium} compact /></span><span>{member.statusText}</span></div></button>)}</section>)}</aside>;
}

function VoiceView({ me, channel, detail, voice, notify, onLeave }: { me: User; channel: Channel; detail: ServerDetail; voice: ReturnType<typeof useVoice>; notify: (message: string) => void; onLeave: () => void }) {
  const prefs = loadPreferences();
  const moderate = async (userId: number, action: 'disconnect' | 'mute' | 'unmute' | 'deafen' | 'undeafen') => {
    try {
      await api(`/api/servers/${detail.server.id}/voice/${userId}`, { method: 'POST', body: JSON.stringify({ action }) });
    } catch (error) {
      notify(getErrorMessage(error));
    }
  };

  const remoteBySocket = new Map(voice.remotePeers.map((peer) => [peer.socketId, peer]));
  const participants = [
    {
      socketId: 'self',
      user: me,
      state: {
        selfMuted: voice.muted,
        selfDeafened: voice.deafened,
        serverMuted: voice.serverMuted,
        serverDeafened: voice.serverDeafened,
        cameraOn: voice.cameraOn,
        screenOn: voice.screenOn,
      },
    },
    ...voice.participants,
  ];

  return <div className="voice-view">
    <header className="content-header">
      <Volume2 size={20} />
      <strong>{channel.name}</strong>
      <span>{participants.length} {participants.length === 1 ? 'participante' : 'participantes'} · {voice.latency ?? '—'} ms · {channel.bitrate / 1000} kbps</span>
    </header>

    {/* Stage: grid de vídeo ocupa 100% da largura */}
    <div className="voice-stage-full">
      <div className="voice-grid-full">
        {/* Tile do próprio usuário */}
        <div className="peer-tile-wrap">
          <StreamTile user={me} stream={voice.localStream} local forceSilent screenSharing={voice.screenOn} />
        </div>

        {/* Tiles dos outros participantes */}
        {voice.participants.map((participant) => {
          const peer = remoteBySocket.get(participant.socketId);
          const locallyMuted = voice.locallyMutedPeers.has(participant.socketId);
          return (
            <div className="peer-tile-wrap" key={participant.socketId}>
              <StreamTile
                user={participant.user}
                stream={peer?.stream ?? null}
                muted={locallyMuted}
                forceSilent={voice.deafened || voice.serverDeafened}
                volume={voice.peerVolumes[participant.socketId] ?? 1}
                outputDeviceId={prefs.outputDeviceId}
                screenSharing={Boolean(participant.state?.screenOn)}
                videoEnabled={Boolean(participant.state?.cameraOn || participant.state?.screenOn)}
              />
              <div className="peer-controls">
                <button className="icon-button" title={locallyMuted ? 'Ativar som' : 'Mutar localmente'} onClick={() => voice.toggleLocalPeerMute(participant.socketId)}>
                  {locallyMuted ? <VolumeX size={15} /> : <Volume1 size={15} />}
                </button>
                <input aria-label={`Volume de ${participant.user.displayName}`} type="range" min="0" max="1" step="0.05"
                  value={voice.peerVolumes[participant.socketId] ?? 1}
                  onChange={(e) => voice.setPeerVolume(participant.socketId, Number(e.target.value))} />
                {can(detail.myPermissions, Permission.MANAGE_SERVER) && <>
                  <button className="icon-button" title={participant.state?.serverMuted ? 'Remover mute' : 'Server mute'}
                    onClick={() => void moderate(participant.user.id, participant.state?.serverMuted ? 'unmute' : 'mute')}>
                    {participant.state?.serverMuted ? <MicOff size={15} /> : <Mic size={15} />}
                  </button>
                  <button className="icon-button" title="Desconectar" onClick={() => void moderate(participant.user.id, 'disconnect')}>
                    <PhoneOff size={15} />
                  </button>
                </>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Barra de participantes sobreposta no topo-direito */}
      <div className="voice-participants-overlay">
        <div className="voice-participants-overlay-title">
          <Users size={12} />
          NA CALL — {participants.length}
        </div>
        <div className="voice-participants-overlay-list">
          {participants.map((participant) => (
            <div className="voice-participant-chip" key={participant.socketId}>
              <div className="voice-participant-chip-avatar">
                <Avatar user={participant.user} size={36} />
                {(participant.state?.selfMuted || participant.state?.serverMuted) && (
                  <div className="voice-participant-chip-muted"><MicOff size={10} /></div>
                )}
              </div>
              <div className="voice-participant-chip-info">
                <strong>{participant.user.displayName}{participant.socketId === 'self' ? ' (você)' : ''}</strong>
                <span>
                  {participant.state?.serverMuted ? 'Mutado pelo server' :
                   participant.state?.selfMuted ? 'Mutado' :
                   participant.state?.screenOn ? 'Compartilhando tela' :
                   participant.state?.cameraOn ? 'Câmera ligada' : 'Conectado'}
                </span>
              </div>
              <div className="voice-participant-chip-icons">
                {(participant.state?.selfMuted || participant.state?.serverMuted) && <MicOff size={13} className="icon-muted" />}
                {(participant.state?.selfDeafened || participant.state?.serverDeafened) && <VolumeX size={13} className="icon-muted" />}
                {participant.state?.screenOn && <MonitorUp size={13} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Barra de controles na parte inferior */}
    <div className="call-controls">
      <button
        className={voice.muted || voice.serverMuted ? 'control-button active-danger' : 'control-button'}
        onClick={voice.toggleMute}
        title={voice.muted ? 'Ativar microfone' : 'Mutar'}>
        {voice.muted || voice.serverMuted ? <MicOff size={22} /> : <Mic size={22} />}
      </button>
      <button
        className={voice.deafened || voice.serverDeafened ? 'control-button active-danger' : 'control-button'}
        onClick={voice.toggleDeafen}
        title={voice.deafened ? 'Ouvir' : 'Ensurdecer'}>
        {voice.deafened || voice.serverDeafened ? <VolumeX size={22} /> : <Headphones size={22} />}
      </button>
      <button
        className={voice.cameraOn ? 'control-button active' : 'control-button'}
        onClick={() => voice.toggleCamera().catch((e) => notify(getErrorMessage(e)))}
        title="Câmera">
        {voice.cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
      </button>
      <button
        className={voice.screenOn ? 'control-button active' : 'control-button'}
        onClick={() => voice.toggleScreen().catch((e) => notify(getErrorMessage(e)))}
        title="Compartilhar tela">
        <MonitorUp size={22} />
      </button>
      <button className="control-button hangup" onClick={onLeave} title="Sair da call">
        <PhoneOff size={22} />
      </button>
    </div>
  </div>;
}

function EmptyState({ title, text }: { title: string; text: string }) { return <div className="empty-state"><div className="welcome-icon"><Hash size={30} /></div><h2>{title}</h2><p>{text}</p></div>; }
function SideDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <aside className="side-drawer"><header><strong>{title}</strong><button className="icon-button" onClick={onClose}><X size={18} /></button></header><div>{children}</div></aside>; }

function ServerModal({ friends, onClose, afterChange, afterGroup, notify }: { friends: FriendsPayload; onClose: () => void; afterChange: (serverId: number) => Promise<void>; afterGroup: (groupId: number) => Promise<void>; notify: (message: string) => void }) {
  const [tab, setTab] = useState<'server' | 'group'>('server');
  const create = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get('name') ?? ''); try { const data = await api<{ serverId: number }>('/api/servers', { method: 'POST', body: JSON.stringify({ name }) }); await afterChange(data.serverId); } catch (error) { notify(getErrorMessage(error)); } };
  const join = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const inviteCode = String(new FormData(event.currentTarget).get('inviteCode') ?? ''); try { const data = await api<{ serverId: number }>('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode }) }); await afterChange(data.serverId); } catch (error) { notify(getErrorMessage(error)); } };
  const importServer = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const file = new FormData(event.currentTarget).get('file'); if (!(file instanceof File)) return; try { const body = JSON.parse(await file.text()); const data = await api<{ serverId: number }>('/api/servers/import', { method: 'POST', body: JSON.stringify(body) }); await afterChange(data.serverId); } catch (error) { notify(getErrorMessage(error)); } };
  const createGroup = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const memberIds = form.getAll('members').map(Number); try { const data = await api<{ threadId: number }>('/api/dm-groups', { method: 'POST', body: JSON.stringify({ name: form.get('name'), memberIds }) }); await afterGroup(data.threadId); } catch (error) { notify(getErrorMessage(error)); } };
  return <Modal title="Create / Join" onClose={onClose}><div className="modal-tabs"><button className={tab === 'server' ? 'active' : ''} onClick={() => setTab('server')}>Server</button><button className={tab === 'group' ? 'active' : ''} onClick={() => setTab('group')}>DM Group</button></div>{tab === 'server' ? <><div className="dual-cards"><form className="choice-card" onSubmit={create}><div className="choice-icon">+</div><h3>Create</h3><p>Start a new community on this host.</p><input name="name" maxLength={60} placeholder="Server name" required /><button className="primary-button">Create Server</button></form><form className="choice-card" onSubmit={join}><div className="choice-icon">→</div><h3>Join</h3><p>Connect with an invite code.</p><input name="inviteCode" placeholder="Invite code" required /><button className="secondary-button">Join Server</button></form></div><form className="form-stack import-server" onSubmit={importServer}><label>IMPORT JSON BACKUP<input type="file" name="file" accept="application/json,.json" required /></label><button className="secondary-button">Import server</button></form></> : <form className="form-stack" onSubmit={createGroup}><label>GROUP NAME<input name="name" required maxLength={48} /></label><label>MEMBERS</label><div className="group-member-picker">{friends.accepted.map((entry) => <label key={entry.user.id}><input type="checkbox" name="members" value={entry.user.id} /><Avatar user={entry.user} size={28} /> {entry.user.displayName}</label>)}</div><button className="primary-button">Create group</button></form>}</Modal>;
}

function MemberManageModal({ detail, member, onClose, reload, notify }: { detail: ServerDetail; member: Member; onClose: () => void; reload: () => Promise<void>; notify: (message: string) => void }) {
  const assigned = new Set(member.roles.map((role) => role.id));
  const toggleRole = async (roleId: number, checked: boolean) => { try { await api(`/api/servers/${detail.server.id}/members/${member.id}/roles/${roleId}`, { method: checked ? 'PUT' : 'DELETE' }); await reload(); } catch (error) { notify(getErrorMessage(error)); } };
  const nickname = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get('nickname') ?? ''); try { await api(`/api/servers/${detail.server.id}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ nickname: value || null }) }); await reload(); notify('Nickname updated.'); } catch (error) { notify(getErrorMessage(error)); } };
  return <Modal title={`Manage ${member.displayName}`} onClose={onClose}><form className="form-stack" onSubmit={nickname}><label>SERVER NICKNAME<input name="nickname" defaultValue={member.nickname ?? ''} maxLength={32} /></label><button className="secondary-button">Save nickname</button></form><div className="modal-separator" /><h3>Roles</h3><div className="permissions-grid role-assignment">{detail.roles.filter((role) => !role.isEveryone).map((role) => <label key={role.id}><input type="checkbox" checked={assigned.has(role.id)} onChange={(event) => void toggleRole(role.id, event.target.checked)} /><span className="role-dot" style={{ background: role.color }} />{role.name}</label>)}</div></Modal>;
}
