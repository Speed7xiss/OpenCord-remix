export type Presence = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';


export type PremiumBenefits = {
  animatedAvatar: boolean;
  animatedBanner: boolean;
  maxUploadMb: number;
  externalEmojis: boolean;
  favoriteEmojiSlots: number;
  screenShare1080p60: boolean;
  camera1080p60: boolean;
  customProfileTheme: boolean;
  premiumBadge: boolean;
  bioMaxLength: number;
  maxServers: number;
  maxDmGroups: number;
  customJoinSound: boolean;
  profileEffects: boolean;
  avatarDecoration: boolean;
  profileBackground: boolean;
  externalReactions: boolean;
  maxFilesPerMessage: number;
  priorityVoice: boolean;
  specialIdentity: boolean;
  perServerProfiles: boolean;
  premiumThemes: boolean;
  profileGradient: boolean;
  advancedStatus: boolean;
  profileHistoryDays: number;
};

export type PremiumMembership = {
  active: boolean;
  name: string;
  description: string;
  color: string;
  iconPath: string | null;
  expiresAt: number | null;
  benefits: PremiumBenefits;
};

export type UserBadge = {
  id: number;
  name: string;
  imagePath: string | null;
};

export type User = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  statusText: string;
  avatarPath: string | null;
  bannerPath: string | null;
  profileTheme: string;
  profileGradient: string;
  profileEffect: string;
  avatarDecorationPath: string | null;
  profileBackgroundPath: string | null;
  customJoinSoundPath: string | null;
  specialIdentity: string;
  presence: Presence;
  createdAt: string;
  isInstanceAdmin?: boolean;
  badges: UserBadge[];
  premium: PremiumMembership | null;
};

export type ServerSummary = {
  id: number;
  name: string;
  description: string;
  iconPath: string | null;
  bannerPath: string | null;
  inviteCode: string;
  ownerId: number;
  nickname: string | null;
  unreadCount: number;
};

export type Channel = {
  id: number;
  serverId: number;
  name: string;
  kind: 'CATEGORY' | 'TEXT' | 'VOICE';
  parentId: number | null;
  position: number;
  topic: string;
  userLimit: number;
  bitrate: number;
  permissions: number;
  overwrites: Array<{ targetType: 'ROLE' | 'MEMBER'; targetId: number; allow: number; deny: number }>;
};

export type Role = {
  id: number;
  name: string;
  color: string;
  permissions: number;
  position: number;
  isEveryone: boolean;
};

export type Member = User & {
  nickname: string | null;
  joinedAt: string;
  roles: Role[];
};

export type VoiceState = {
  userId: number;
  user: User;
  channelId: number;
  serverId: number;
  selfMuted: boolean;
  selfDeafened: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  cameraOn: boolean;
  screenOn: boolean;
};

export type ServerDetail = {
  server: {
    id: number;
    name: string;
    description: string;
    ownerId: number;
    inviteCode: string;
    iconPath: string | null;
    bannerPath: string | null;
  };
  channels: Channel[];
  members: Member[];
  roles: Role[];
  myPermissions: number;
  voiceStates: VoiceState[];
};

export type Attachment = {
  id: number;
  path: string;
  name: string;
  mimeType: string;
  size: number;
};

export type Reaction = { emoji: string; count: number; mine: boolean };

export type Message = {
  id: number;
  channelId: number;
  author: User;
  content: string;
  createdAt: string;
  editedAt: string | null;
  pinned: boolean;
  replyTo: { id: number; content: string; author: User } | null;
  attachments: Attachment[];
  reactions: Reaction[];
};

export type FriendEntry = { friendshipId: number; unreadCount: number; user: User };
export type FriendsPayload = {
  accepted: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
  blocked: User[];
};

export type DirectMessage = {
  id: number;
  sender: User;
  recipientId: number;
  content: string;
  createdAt: string;
  editedAt: string | null;
  replyToId: number | null;
};

export type UserProfilePayload = {
  user: User;
  relationship: { id: number; status: 'pending' | 'accepted'; incoming: boolean } | null;
  blockedByMe: boolean;
  mutualFriends: number;
  commonServers: Array<{ id: number; name: string; iconPath: string | null }>;
};

export type DmGroupSummary = { id: number; name: string; iconPath: string | null; ownerId: number; memberCount: number };
export type DmGroupMessage = { id: number; threadId: number; author: User; content: string; createdAt: string; editedAt: string | null };
export type DmGroupDetail = { id: number; name: string; iconPath: string | null; ownerId: number; members: User[] };

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
} as const;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((sum, value) => sum | value, 0);
export function can(permissions: number, permission: number) {
  return Boolean(permissions & Permission.ADMINISTRATOR) || Boolean(permissions & permission);
}

export type CustomEmoji = {
  id: number;
  userId: number;
  name: string;
  imagePath: string;
  token: string;
};
