import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, MonitorUp } from 'lucide-react';
import type { User } from '../types';
import { Avatar } from './Avatar';

type Props = {
  user: User;
  stream: MediaStream | null;
  muted?: boolean;
  local?: boolean;
  volume?: number;
  outputDeviceId?: string;
  forceSilent?: boolean;
  screenSharing?: boolean;
  videoEnabled?: boolean;
};

type SinkMedia = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

export function StreamTile({ user, stream, muted = false, local = false, volume = 1, outputDeviceId = '', forceSilent = false, screenSharing = false, videoEnabled = true }: Props) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);

  const videoTrack = videoEnabled ? (stream?.getVideoTracks().find((track) => track.readyState === 'live') ?? null) : null;
  const audioTrack = stream?.getAudioTracks().find((track) => track.readyState === 'live') ?? null;
  const videoStream = useMemo(() => videoTrack ? new MediaStream([videoTrack]) : null, [videoTrack]);
  const audioStream = useMemo(() => audioTrack ? new MediaStream([audioTrack]) : null, [audioTrack]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = videoStream;
    if (videoStream) void video.play().catch(() => undefined);
  }, [videoStream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = audioStream;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.muted = local || muted || forceSilent;
    const element = audio as SinkMedia;
    if (outputDeviceId && element.setSinkId) void element.setSinkId(outputDeviceId).catch(() => undefined);
    if (audioStream && !audio.muted) void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    else setAudioBlocked(false);
  }, [audioStream, forceSilent, local, muted, outputDeviceId, volume]);

  useEffect(() => {
    if (!audioStream || local) return;
    let context: AudioContext | null = null;
    let frame = 0;
    try {
      context = new AudioContext();
      const source = context.createMediaStreamSource(audioStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const average = data.reduce((sum, value) => sum + value, 0) / data.length;
        setSpeaking(average > 14);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch {
      setSpeaking(false);
    }
    return () => {
      cancelAnimationFrame(frame);
      context?.close().catch(() => undefined);
    };
  }, [audioStream, local]);

  useEffect(() => {
    if (!fallbackFullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [fallbackFullscreen]);

  const enableAudio = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try { await audio.play(); setAudioBlocked(false); } catch { setAudioBlocked(true); }
  };

  const enterFullscreen = async () => {
    const target = tileRef.current;
    if (!target) return;
    if (fallbackFullscreen) { setFallbackFullscreen(false); return; }
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => undefined); return; }
    if (typeof target.requestFullscreen === 'function') {
      try { await target.requestFullscreen(); return; } catch {}
    }
    setFallbackFullscreen(true);
  };

  return (
    <div ref={tileRef} className={`stream-tile ${speaking ? 'speaking' : ''} ${screenSharing ? 'screen-sharing' : ''} ${fallbackFullscreen ? 'fallback-fullscreen' : ''}`}>
      {videoStream ? <video ref={videoRef} autoPlay playsInline muted /> : (
        <div className="voice-avatar-placeholder">
          <Avatar user={user} size={96} />
          {speaking && <div className="speaking-ring" />}
        </div>
      )}
      <audio ref={audioRef} autoPlay />
      {audioBlocked && !local && <button type="button" className="audio-unlock-button" onClick={() => void enableAudio()}>Enable audio</button>}
      {screenSharing && <div className="screen-share-indicator"><MonitorUp size={14} /> Sharing screen</div>}
      {screenSharing && videoStream && <button className="stream-fullscreen-button" title="Fullscreen" onClick={enterFullscreen}><Maximize2 size={17} /></button>}
      <div className="stream-label">{user.displayName}{local ? ' (you)' : ''}{muted ? ' · muted' : ''}</div>
    </div>
  );
}
