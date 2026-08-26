import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from './socket';
import type { User } from '../types';
import { api } from './api';
import { loadPreferences } from './preferences';
import { playCustomSound, playSound } from './sound';

export type PeerVoiceState = {
  selfMuted?: boolean;
  selfDeafened?: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  cameraOn?: boolean;
  screenOn?: boolean;
};

export type RemotePeer = { socketId: string; user: User; stream: MediaStream; state?: PeerVoiceState };
export type VoiceParticipant = { socketId: string; user: User; state?: PeerVoiceState };

type VoiceJoinResponse = {
  error?: string;
  peers?: Array<{ socketId: string; user: User; state?: PeerVoiceState }>;
  channelId?: number;
};

type PeerContext = {
  connection: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  polite: boolean;
  pendingCandidates: RTCIceCandidateInit[];
};

export function useVoice() {
  const rtcConfigRef = useRef<RTCConfiguration>({ iceServers: [] });
  const [channelId, setChannelId] = useState<number | null>(null);
  const channelIdRef = useRef<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [serverMuted, setServerMuted] = useState(false);
  const [serverDeafened, setServerDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const cameraOnRef = useRef(false);
  const screenOnRef = useRef(false);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({});
  const [locallyMutedPeers, setLocallyMutedPeers] = useState<Set<string>>(new Set());

  const peerContexts = useRef(new Map<string, PeerContext>());
  const users = useRef(new Map<string, User>());
  const peerStates = useRef(new Map<string, PeerVoiceState>());
  const remoteStreams = useRef(new Map<string, MediaStream>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const serverMutedRef = useRef(false);
  const serverDeafenedRef = useRef(false);
  const pttPressedRef = useRef(false);
  const joinRef = useRef<(nextChannelId: number) => Promise<void>>(async () => undefined);

  const activeVideoTrack = useCallback(() => screenTrackRef.current ?? cameraTrackRef.current, []);

  const refreshLocalPreview = useCallback(() => {
    const tracks: MediaStreamTrack[] = [];
    const audio = localStreamRef.current?.getAudioTracks()[0];
    const video = activeVideoTrack();
    if (audio) tracks.push(audio);
    if (video) tracks.push(video);
    setLocalStream(tracks.length ? new MediaStream(tracks) : null);
  }, [activeVideoTrack]);

  const refreshAudioEnabled = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    const prefs = loadPreferences();
    track.enabled = !serverMutedRef.current && !mutedRef.current && (!prefs.pushToTalk || pttPressedRef.current);
  }, []);

  const upsertParticipant = useCallback((socketId: string, user: User, state?: PeerVoiceState) => {
    users.current.set(socketId, user);
    if (state) peerStates.current.set(socketId, state);
    setParticipants((current) => {
      const item: VoiceParticipant = { socketId, user, state: state ?? peerStates.current.get(socketId) };
      const index = current.findIndex((entry) => entry.socketId === socketId);
      if (index < 0) return [...current, item];
      const next = [...current];
      next[index] = item;
      return next;
    });
  }, []);

  const syncRemotePeer = useCallback((socketId: string) => {
    const stream = remoteStreams.current.get(socketId);
    const user = users.current.get(socketId);
    if (!stream || !user) return;
    setRemotePeers((current) => {
      const item: RemotePeer = { socketId, user, stream, state: peerStates.current.get(socketId) };
      const index = current.findIndex((entry) => entry.socketId === socketId);
      if (index < 0) return [...current, item];
      const next = [...current];
      next[index] = item;
      return next;
    });
  }, []);

  const closePeer = useCallback((socketId: string) => {
    const context = peerContexts.current.get(socketId);
    if (context && context.connection.signalingState !== 'closed') context.connection.close();
    peerContexts.current.delete(socketId);
    users.current.delete(socketId);
    peerStates.current.delete(socketId);
    const stream = remoteStreams.current.get(socketId);
    stream?.getTracks().forEach((track) => track.stop());
    remoteStreams.current.delete(socketId);
    setRemotePeers((current) => current.filter((item) => item.socketId !== socketId));
    setParticipants((current) => current.filter((item) => item.socketId !== socketId));
  }, []);

  const getVideoSender = useCallback((peer: RTCPeerConnection) => {
    return peer.getTransceivers().find((transceiver) => transceiver.receiver.track.kind === 'video')?.sender
      ?? peer.getSenders().find((sender) => sender.track?.kind === 'video');
  }, []);

  const ensurePeer = useCallback((socketId: string, user: User) => {
    const existing = peerContexts.current.get(socketId);
    if (existing) {
      users.current.set(socketId, user);
      return existing;
    }

    const peer = new RTCPeerConnection(rtcConfigRef.current);
    const context: PeerContext = {
      connection: peer,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      polite: String(socket.id ?? '') > socketId,
      pendingCandidates: [],
    };
    peerContexts.current.set(socketId, context);
    users.current.set(socketId, user);

    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) peer.addTrack(audioTrack, new MediaStream([audioTrack]));
    const videoTrack = activeVideoTrack();
    if (videoTrack) peer.addTrack(videoTrack, new MediaStream([videoTrack]));

    peer.onicecandidate = (event) => {
      if (event.candidate) socket.emit('webrtc:signal', { to: socketId, candidate: event.candidate.toJSON() });
    };

    peer.ontrack = (event) => {
      let stream = remoteStreams.current.get(socketId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.current.set(socketId, stream);
      }
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      event.track.onended = () => {
        const current = remoteStreams.current.get(socketId);
        current?.removeTrack(event.track);
        syncRemotePeer(socketId);
      };
      syncRemotePeer(socketId);
    };

    peer.onnegotiationneeded = async () => {
      try {
        context.makingOffer = true;
        await peer.setLocalDescription();
        if (peer.localDescription) socket.emit('webrtc:signal', { to: socketId, description: peer.localDescription });
      } catch (error) {
        console.error('WebRTC negotiation error', error);
      } finally {
        context.makingOffer = false;
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') {
        try { peer.restartIce(); } catch { closePeer(socketId); }
      }
      if (peer.connectionState === 'closed') closePeer(socketId);
    };

    return context;
  }, [activeVideoTrack, closePeer, syncRemotePeer]);

  const replaceOutgoingVideo = useCallback(async (track: MediaStreamTrack | null) => {
    await Promise.all([...peerContexts.current.values()].map(async ({ connection }) => {
      const sender = getVideoSender(connection);
      if (sender) {
        await sender.replaceTrack(track);
      } else if (track) {
        connection.addTrack(track, new MediaStream([track]));
      }
    }));
  }, [getVideoSender]);

  const leave = useCallback((silent = false) => {
    if (channelIdRef.current && !silent) playSound('disconnect');
    if (channelIdRef.current) socket.emit('voice:leave');
    for (const { connection } of peerContexts.current.values()) connection.close();
    peerContexts.current.clear();
    users.current.clear();
    peerStates.current.clear();
    remoteStreams.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenTrackRef.current?.stop();
    localStreamRef.current = null;
    cameraTrackRef.current = null;
    screenTrackRef.current = null;
    cameraOnRef.current = false;
    screenOnRef.current = false;
    channelIdRef.current = null;
    setLocalStream(null);
    setRemotePeers([]);
    setParticipants([]);
    setChannelId(null);
    setMuted(false);
    setDeafened(false);
    setServerMuted(false);
    setServerDeafened(false);
    mutedRef.current = false;
    deafenedRef.current = false;
    serverMutedRef.current = false;
    serverDeafenedRef.current = false;
    setCameraOn(false);
    setScreenOn(false);
  }, []);

  useEffect(() => {
    const onJoined = ({ socketId, user, state }: { socketId: string; user: User; state?: PeerVoiceState }) => {
      upsertParticipant(socketId, user, state ?? {});
      if (!(user.premium?.benefits.customJoinSound && playCustomSound(user.customJoinSoundPath))) playSound('join');
    };

    const onLeft = ({ socketId }: { socketId: string }) => {
      closePeer(socketId);
      playSound('leave');
    };

    const onPeerState = ({ socketId, state }: { socketId: string; state: PeerVoiceState }) => {
      peerStates.current.set(socketId, state);
      const user = users.current.get(socketId);
      if (user) upsertParticipant(socketId, user, state);
      setRemotePeers((current) => current.map((peer) => peer.socketId === socketId ? { ...peer, state } : peer));
    };

    const onSignal = async ({ from, user, description, candidate }: {
      from: string;
      user: User;
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    }) => {
      const context = ensurePeer(from, user);
      const peer = context.connection;
      try {
        if (description) {
          const readyForOffer = !context.makingOffer && (peer.signalingState === 'stable' || context.isSettingRemoteAnswerPending);
          const offerCollision = description.type === 'offer' && !readyForOffer;
          context.ignoreOffer = !context.polite && offerCollision;
          if (context.ignoreOffer) {
            context.pendingCandidates.length = 0;
            return;
          }

          context.isSettingRemoteAnswerPending = description.type === 'answer';
          await peer.setRemoteDescription(description);
          context.isSettingRemoteAnswerPending = false;

          if (context.pendingCandidates.length) {
            const queued = context.pendingCandidates.splice(0);
            for (const queuedCandidate of queued) await peer.addIceCandidate(queuedCandidate);
          }

          if (description.type === 'offer') {
            await peer.setLocalDescription();
            if (peer.localDescription) socket.emit('webrtc:signal', { to: from, description: peer.localDescription });
          }
        }

        if (candidate) {
          if (context.ignoreOffer) return;
          if (peer.remoteDescription) await peer.addIceCandidate(candidate);
          else context.pendingCandidates.push(candidate);
        }
      } catch (error) {
        if (!context.ignoreOffer) console.error('WebRTC signaling error', error);
      }
    };

    const onModeration = ({ serverMuted: nextMuted, serverDeafened: nextDeafened }: { serverMuted: boolean; serverDeafened: boolean }) => {
      serverMutedRef.current = nextMuted;
      serverDeafenedRef.current = nextDeafened;
      setServerMuted(nextMuted);
      setServerDeafened(nextDeafened);
      refreshAudioEnabled();
    };

    const onForcedDisconnect = () => leave(true);
    const onForcedMove = ({ channelId: next }: { channelId: number }) => { leave(true); void joinRef.current(next); };

    socket.on('voice:user-joined', onJoined);
    socket.on('voice:user-left', onLeft);
    socket.on('voice:peer-state', onPeerState);
    socket.on('webrtc:signal', onSignal);
    socket.on('voice:moderation', onModeration);
    socket.on('voice:forced-disconnect', onForcedDisconnect);
    socket.on('voice:forced-move', onForcedMove);
    return () => {
      socket.off('voice:user-joined', onJoined);
      socket.off('voice:user-left', onLeft);
      socket.off('voice:peer-state', onPeerState);
      socket.off('webrtc:signal', onSignal);
      socket.off('voice:moderation', onModeration);
      socket.off('voice:forced-disconnect', onForcedDisconnect);
      socket.off('voice:forced-move', onForcedMove);
    };
  }, [closePeer, ensurePeer, leave, refreshAudioEnabled, upsertParticipant]);

  const join = useCallback(async (nextChannelId: number) => {
    if (channelIdRef.current === nextChannelId) return;
    leave(true);

    try {
      const config = await api<{ iceServers: RTCIceServer[] }>('/api/config');
      rtcConfigRef.current = { iceServers: config.iceServers ?? [] };
    } catch {
      rtcConfigRef.current = { iceServers: [] };
    }

    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable. Use HTTPS or localhost and allow microphone access.');

    const prefs = loadPreferences();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined,
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        // Extra constraints for browsers that support them
        ...(({ googEchoCancellation: true, googNoiseSuppression: true, googHighpassFilter: true, googAutoGainControl: true, googNoiseSuppression2: true, googEchoCancellation2: true } as unknown) as MediaTrackConstraints),
      },
      video: false,
    });

    localStreamRef.current = stream;
    channelIdRef.current = nextChannelId;
    setChannelId(nextChannelId);
    refreshAudioEnabled();
    refreshLocalPreview();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        leave(true);
        reject(new Error('The voice call did not respond in time. Check your connection and try again.'));
      }, 10_000);

      socket.emit('voice:join', { channelId: nextChannelId, usePriority: loadPreferences().useVoicePriority }, (response: VoiceJoinResponse) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (response?.error) {
          leave(true);
          reject(new Error(response.error));
          return;
        }

        try {
          const initialParticipants = response.peers ?? [];
          setParticipants(initialParticipants.map((item) => ({ socketId: item.socketId, user: item.user, state: item.state ?? {} })));
          for (const item of initialParticipants) {
            users.current.set(item.socketId, item.user);
            peerStates.current.set(item.socketId, item.state ?? {});
            ensurePeer(item.socketId, item.user);
          }
          playSound('join');
          resolve();
        } catch (error) {
          leave(true);
          reject(error);
        }
      });
    });
  }, [ensurePeer, leave, refreshAudioEnabled, refreshLocalPreview]);

  joinRef.current = join;

  const emitOwnState = useCallback((patch: PeerVoiceState) => {
    if (!channelIdRef.current) return;
    socket.emit('voice:state-update', patch);
  }, []);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    refreshAudioEnabled();
    emitOwnState({ selfMuted: mutedRef.current, selfDeafened: deafenedRef.current });
    playSound(mutedRef.current ? 'mute' : 'unmute');
  }, [emitOwnState, refreshAudioEnabled]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    emitOwnState({ selfMuted: mutedRef.current, selfDeafened: next });
    playSound(next ? 'mute' : 'unmute');
  }, [emitOwnState]);

  const toggleCamera = useCallback(async () => {
    if (!channelIdRef.current) return;

    if (cameraTrackRef.current) {
      const track = cameraTrackRef.current;
      cameraTrackRef.current = null;
      cameraOnRef.current = false;
      setCameraOn(false);
      localStreamRef.current?.removeTrack(track);
      track.stop();
      if (!screenTrackRef.current) await replaceOutgoingVideo(null);
      refreshLocalPreview();
      emitOwnState({ cameraOn: false });
      playSound('camera');
      return;
    }

    const prefs = loadPreferences();
    let premium1080 = false;
    try { premium1080 = Boolean((await api<{ premium: User['premium'] }>('/api/me/premium')).premium?.benefits.camera1080p60); } catch { premium1080 = false; }
    let camera: MediaStream;
    try {
      camera = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: prefs.cameraDeviceId ? { exact: prefs.cameraDeviceId } : undefined,
          width: { ideal: premium1080 ? 1920 : 1280 },
          height: { ideal: premium1080 ? 1080 : 720 },
          frameRate: { ideal: premium1080 ? 60 : 30 },
        },
        audio: false,
      });
    } catch (error) {
      if (!premium1080) throw error;
      camera = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: prefs.cameraDeviceId ? { exact: prefs.cameraDeviceId } : undefined },
        audio: false,
      });
    }
    const track = camera.getVideoTracks()[0];
    if (!track) throw new Error('No camera is available.');
    cameraTrackRef.current = track;
    cameraOnRef.current = true;
    localStreamRef.current?.addTrack(track);
    setCameraOn(true);

    track.onended = () => {
      if (cameraTrackRef.current !== track) return;
      cameraTrackRef.current = null;
      cameraOnRef.current = false;
      setCameraOn(false);
      localStreamRef.current?.removeTrack(track);
      if (!screenTrackRef.current) void replaceOutgoingVideo(null);
      refreshLocalPreview();
      emitOwnState({ cameraOn: false });
    };

    if (!screenTrackRef.current) await replaceOutgoingVideo(track);
    refreshLocalPreview();
    emitOwnState({ cameraOn: true });
    playSound('camera');
  }, [emitOwnState, refreshLocalPreview, replaceOutgoingVideo]);

  const stopScreenShare = useCallback(async () => {
    const track = screenTrackRef.current;
    if (!track) return;
    screenTrackRef.current = null;
    screenOnRef.current = false;
    setScreenOn(false);
    track.onended = null;
    if (track.readyState !== 'ended') track.stop();
    await replaceOutgoingVideo(cameraTrackRef.current);
    refreshLocalPreview();
    emitOwnState({ screenOn: false });
  }, [emitOwnState, refreshLocalPreview, replaceOutgoingVideo]);

  const toggleScreen = useCallback(async () => {
    if (!channelIdRef.current) return;
    if (screenTrackRef.current) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported by this browser.');

    let premium1080 = false;
    try { premium1080 = Boolean((await api<{ premium: User['premium'] }>('/api/me/premium')).premium?.benefits.screenShare1080p60); } catch { premium1080 = false; }
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: premium1080 ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } : true, audio: false });
    } catch (error) {
      if (!premium1080) throw error;
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    const track = display.getVideoTracks()[0];
    if (!track) throw new Error('No screen was selected.');
    screenTrackRef.current = track;
    screenOnRef.current = true;
    setScreenOn(true);
    track.onended = () => { void stopScreenShare(); };
    await replaceOutgoingVideo(track);
    refreshLocalPreview();
    emitOwnState({ screenOn: true });
  }, [emitOwnState, refreshLocalPreview, replaceOutgoingVideo, stopScreenShare]);

  const switchInputDevice = useCallback(async (deviceId: string) => {
    if (!localStreamRef.current) return;
    const replacementStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        ...(({ googEchoCancellation: true, googNoiseSuppression: true, googHighpassFilter: true, googAutoGainControl: true, googNoiseSuppression2: true } as unknown) as MediaTrackConstraints),
      },
      video: false,
    });
    const replacement = replacementStream.getAudioTracks()[0];
    if (!replacement) throw new Error('Microphone unavailable.');
    const previous = localStreamRef.current.getAudioTracks()[0];
    if (previous) {
      localStreamRef.current.removeTrack(previous);
      previous.stop();
    }
    localStreamRef.current.addTrack(replacement);

    await Promise.all([...peerContexts.current.values()].map(async ({ connection }) => {
      const sender = connection.getSenders().find((item) => item.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(replacement);
      else connection.addTrack(replacement, new MediaStream([replacement]));
    }));

    refreshAudioEnabled();
    refreshLocalPreview();
  }, [refreshAudioEnabled, refreshLocalPreview]);

  const setPeerVolume = useCallback((socketId: string, volume: number) => {
    setPeerVolumes((current) => ({ ...current, [socketId]: Math.max(0, Math.min(1, volume)) }));
  }, []);

  const toggleLocalPeerMute = useCallback((socketId: string) => setLocallyMutedPeers((current) => {
    const next = new Set(current);
    if (next.has(socketId)) next.delete(socketId); else next.add(socketId);
    return next;
  }), []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const started = performance.now();
      socket.emit('latency:ping', () => setLatency(Math.round(performance.now() - started)));
    }, 4000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const prefs = loadPreferences();
      if (!prefs.pushToTalk || event.code !== prefs.pushToTalkKey || event.repeat) return;
      pttPressedRef.current = true;
      refreshAudioEnabled();
    };
    const up = (event: KeyboardEvent) => {
      const prefs = loadPreferences();
      if (!prefs.pushToTalk || event.code !== prefs.pushToTalkKey) return;
      pttPressedRef.current = false;
      refreshAudioEnabled();
    };
    const prefsChange = () => refreshAudioEnabled();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('opencord:preferences', prefsChange);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('opencord:preferences', prefsChange);
    };
  }, [refreshAudioEnabled]);

  useEffect(() => () => leave(true), [leave]);

  return {
    channelId,
    muted,
    deafened,
    serverMuted,
    serverDeafened,
    cameraOn,
    screenOn,
    remotePeers,
    participants,
    localStream,
    latency,
    peerVolumes,
    locallyMutedPeers,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreen,
    switchInputDevice,
    setPeerVolume,
    toggleLocalPeerMute,
  };
}
