import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bell, Code2, Crown, Database, ExternalLink, Headphones, Heart, LogOut, Mic, Palette, RefreshCw, Shield, Sparkles, UserCog } from 'lucide-react';
import { api } from '../lib/api';
import { loadPreferences, savePreferences, type Preferences } from '../lib/preferences';
import type { CustomEmoji, PremiumBenefits, User } from '../types';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { AdminPanel } from './AdminPanel';
import { ImageUploadField } from './ImageUploadField';

type DeviceLists = { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] };
type PremiumSystem = { enabled: boolean; name: string; description: string; color: string; iconPath: string | null; priceLabel: string; defaultDurationDays: number; benefits: PremiumBenefits };
type MonetizationConfig = { enabled: boolean; supportTitle: string; supportDescription: string; supportUrl: string; supportButtonLabel: string; premiumCheckoutUrl: string; premiumCheckoutLabel: string; managedHostingUrl: string; managedHostingLabel: string };

export function UserSettingsModal({ me, onClose, onUpdated, onLoggedOut, notify, switchInputDevice }: {
  me: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
  onLoggedOut: () => void;
  notify: (message: string) => void;
  switchInputDevice: (deviceId: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<'profile' | 'voice' | 'appearance' | 'premium' | 'security' | 'credits' | 'admin'>('profile');
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [], cameras: [] });
  const [meter, setMeter] = useState(0);
  const [myEmojis, setMyEmojis] = useState<CustomEmoji[]>([]);
  const [profileHistory, setProfileHistory] = useState<Array<{ id: number; snapshot: Record<string, unknown>; createdAt: number }>>([]);
  const [premiumSystem, setPremiumSystem] = useState<PremiumSystem | null>(null);
  const [monetization, setMonetization] = useState<MonetizationConfig | null>(null);
  const testCleanup = useRef<(() => void) | null>(null);

  const updatePrefs = (patch: Partial<Preferences>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePreferences(next);
  };

  const loadDevices = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({ inputs: list.filter((d) => d.kind === 'audioinput'), outputs: list.filter((d) => d.kind === 'audiooutput'), cameras: list.filter((d) => d.kind === 'videoinput') });
    } catch { notify('Could not list media devices.'); }
  };
  useEffect(() => {
    void loadDevices();
    void api<{ system: PremiumSystem }>('/api/me/premium').then((data) => setPremiumSystem(data.system)).catch(() => setPremiumSystem(null));
    void api<MonetizationConfig>('/api/monetization').then(setMonetization).catch(() => setMonetization(null));
    return () => testCleanup.current?.();
  }, []);

  useEffect(() => {
    if (tab !== 'premium' || !me.premium) return;
    if (me.premium.benefits.externalEmojis) void api<{ emojis: CustomEmoji[] }>('/api/emojis?mine=1').then((data) => setMyEmojis(data.emojis.filter((emoji) => emoji.userId === me.id))).catch(() => setMyEmojis([]));
    if (me.premium.benefits.profileHistoryDays > 0) void api<{ history: Array<{ id: number; snapshot: Record<string, unknown>; createdAt: number }> }>('/api/me/profile-history').then((data) => setProfileHistory(data.history)).catch(() => setProfileHistory([]));
  }, [tab, me.id, me.premium]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = await api<{ user: User }>('/api/me', { method: 'PATCH', body: JSON.stringify({ username: form.get('username'), displayName: form.get('displayName'), statusText: form.get('statusText'), bio: form.get('bio'), presence: form.get('presence') }) });
      onUpdated(data.user); notify('Profile saved.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Failed to save profile.'); }
  };

  const upload = async (event: FormEvent<HTMLFormElement>, kind: 'avatar' | 'banner') => {
    event.preventDefault();
    try {
      const data = await api<{ user: User }>(`/api/me/${kind}`, { method: 'POST', body: new FormData(event.currentTarget) });
      onUpdated(data.user); notify(kind === 'avatar' ? 'Avatar updated.' : 'Banner updated.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Upload failed.'); }
  };


  const savePremiumProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = await api<{ user: User }>('/api/me/premium-profile', { method: 'PATCH', body: JSON.stringify({
        profileTheme: form.get('profileTheme'), profileGradient: form.get('profileGradient'), profileEffect: form.get('profileEffect'), specialIdentity: form.get('specialIdentity'),
      }) });
      onUpdated(data.user); notify('Premium customization saved.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Failed to save customization.'); }
  };

  const uploadPremiumAsset = async (event: FormEvent<HTMLFormElement>, endpoint: string) => {
    event.preventDefault();
    try {
      const data = await api<{ user: User }>(endpoint, { method: 'POST', body: new FormData(event.currentTarget) });
      onUpdated(data.user); event.currentTarget.reset(); notify('File updated.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Upload failed.'); }
  };

  const uploadEmoji = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await api<{ emoji: CustomEmoji }>('/api/me/emojis', { method: 'POST', body: new FormData(form) });
      setMyEmojis((current) => [...current, data.emoji].sort((a, b) => a.name.localeCompare(b.name)));
      form.reset();
      notify('Custom emoji created.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Failed to create custom emoji.'); }
  };

  const deleteEmoji = async (emoji: CustomEmoji) => {
    if (!window.confirm(`Delete :${emoji.name}:?`)) return;
    try {
      await api(`/api/me/emojis/${emoji.id}`, { method: 'DELETE' });
      setMyEmojis((current) => current.filter((item) => item.id !== emoji.id));
      notify('Emoji deleted.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Failed to delete emoji.'); }
  };

  const redeemPremiumCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get('code') ?? '').trim();
    if (!code) return;
    try {
      const data = await api<{ user: User }>('/api/me/premium/redeem', { method: 'POST', body: JSON.stringify({ code }) });
      onUpdated(data.user);
      form.reset();
      notify('Premium code redeemed successfully.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not redeem this code.'); }
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('newPassword') ?? '');
    if (newPassword !== String(form.get('confirmPassword') ?? '')) return notify('The new passwords do not match.');
    try {
      await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword }) });
      notify('Password changed. Please sign in again.'); onLoggedOut();
    } catch (error) { notify(error instanceof Error ? error.message : 'Failed to change password.'); }
  };

  const logoutAll = async () => {
    try { await api('/api/auth/logout-all', { method: 'POST' }); onLoggedOut(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Failed to close sessions.'); }
  };

  const testMicrophone = async () => {
    testCleanup.current?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined }, video: false });
      await loadDevices();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let frame = 0;
      const tick = () => {
        analyser.getByteFrequencyData(data);
        setMeter(Math.min(100, Math.round((data.reduce((a, b) => a + b, 0) / data.length) * 1.3)));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      testCleanup.current = () => { cancelAnimationFrame(frame); stream.getTracks().forEach((track) => track.stop()); void context.close(); setMeter(0); testCleanup.current = null; };
      window.setTimeout(() => testCleanup.current?.(), 7000);
    } catch { notify('Allow microphone access to run the test.'); }
  };

  return (
    <Modal title="User Settings" onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}><UserCog size={17} /> My account</button>
          <button className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}><Headphones size={17} /> Voice & Video</button>
          <button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}><Palette size={17} /> Appearance</button>
          {premiumSystem?.enabled && <button className={tab === 'premium' ? 'active' : ''} onClick={() => setTab('premium')}><Sparkles size={17} /> {premiumSystem.name}</button>}
          <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}><Shield size={17} /> Security</button>
          <button className={tab === 'credits' ? 'active' : ''} onClick={() => setTab('credits')}><Heart size={17} /> Credits</button>
          {me.isInstanceAdmin && <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}><Database size={17} /> Instance</button>}
        </nav>
        <div className="settings-pane">
          {tab === 'profile' && <>
            <div className="profile-preview compact-profile"><div className="profile-banner" style={me.bannerPath ? { backgroundImage: `url(${me.bannerPath})` } : undefined} /><Avatar user={me} size={82} /><h3>{me.displayName}</h3><span>@{me.username}</span></div>
            <div className="two-column-forms">
              <form className="form-stack" onSubmit={(event) => upload(event, 'avatar')}><ImageUploadField name="avatar" label="AVATAR" currentUrl={me.avatarPath} accept={me.premium?.benefits.animatedAvatar ? "image/png,image/jpeg,image/webp,image/gif" : "image/png,image/jpeg,image/webp"} required /><button className="secondary-button">Upload avatar</button></form>
              <form className="form-stack" onSubmit={(event) => upload(event, 'banner')}><ImageUploadField name="banner" label="BANNER" currentUrl={me.bannerPath} accept={me.premium?.benefits.animatedBanner ? "image/png,image/jpeg,image/webp,image/gif" : "image/png,image/jpeg,image/webp"} required /><button className="secondary-button">Upload banner</button></form>
            </div>
            <form className="form-stack" onSubmit={saveProfile}>
              <label>USERNAME<input name="username" defaultValue={me.username} minLength={3} maxLength={24} required /></label>
              <label>DISPLAY NAME<input name="displayName" defaultValue={me.displayName} maxLength={32} required /></label>
              <label>PRESENCE<select name="presence" defaultValue={me.presence === 'offline' ? 'online' : me.presence}><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">Do Not Disturb</option><option value="invisible">Invisible</option></select></label>
              <label>STATUS<input name="statusText" defaultValue={me.statusText} maxLength={me.premium?.benefits.advancedStatus ? 160 : 64} placeholder="What are you doing?" /></label>
              <label>ABOUT ME<textarea name="bio" defaultValue={me.bio} maxLength={me.premium?.benefits.bioMaxLength ?? 190} rows={4} /></label>
              <button className="primary-button">Save changes</button>
            </form>
          </>}

          {tab === 'voice' && <>
            <div className="settings-heading"><div><h2>Voice & Video</h2><p>Device preferences are stored only in this browser.</p></div><button className="icon-button" onClick={loadDevices}><RefreshCw size={17} /></button></div>
            <div className="form-stack">
              <label>INPUT DEVICE<select value={prefs.inputDeviceId} onChange={async (event) => { updatePrefs({ inputDeviceId: event.target.value }); await switchInputDevice(event.target.value).catch(() => undefined); }}><option value="">System default</option>{devices.inputs.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>
              <label>OUTPUT DEVICE<select value={prefs.outputDeviceId} onChange={(event) => updatePrefs({ outputDeviceId: event.target.value })}><option value="">System default</option>{devices.outputs.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Output ${index + 1}`}</option>)}</select></label>
              <label>CAMERA<select value={prefs.cameraDeviceId} onChange={(event) => updatePrefs({ cameraDeviceId: event.target.value })}><option value="">System default</option>{devices.cameras.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>
              <div className="mic-test"><button className="secondary-button" onClick={testMicrophone}><Mic size={17} /> Test microphone</button><div className="meter"><span style={{ width: `${meter}%` }} /></div></div>
              <label>SENSITIVITY<input type="range" min="0" max="0.12" step="0.005" value={prefs.inputSensitivity} onChange={(event) => updatePrefs({ inputSensitivity: Number(event.target.value) })} /></label>
              <label className="toggle-row"><input type="checkbox" checked={prefs.pushToTalk} onChange={(event) => updatePrefs({ pushToTalk: event.target.checked })} /><span>Push-to-talk</span></label>
              {me.premium?.benefits.priorityVoice && <label className="toggle-row"><input type="checkbox" checked={prefs.useVoicePriority} onChange={(event) => updatePrefs({ useVoicePriority: event.target.checked })} /><span>Use priority when joining full voice channels</span></label>}
              {prefs.pushToTalk && <label>PUSH-TO-TALK KEY<input value={prefs.pushToTalkKey} readOnly onKeyDown={(event) => { event.preventDefault(); updatePrefs({ pushToTalkKey: event.code }); }} onFocus={(event) => event.currentTarget.select()} /></label>}
            </div>
          </>}

          {tab === 'appearance' && <div className="form-stack">
            <h2>Appearance & notifications</h2>
            <label>THEME<select value={prefs.theme} onChange={(event) => updatePrefs({ theme: event.target.value as Preferences['theme'] })}><option value="dark">Classic Dark</option><option value="light">Light</option><option value="midnight">Midnight</option><option value="amoled">AMOLED</option><option value="ocean">Ocean</option><option value="forest">Forest</option><option value="sunset">Sunset</option><option value="lavender" disabled={!me.premium?.benefits.premiumThemes}>Lavender · {me.premium?.name ?? "Premium"}</option><option value="retro" disabled={!me.premium?.benefits.premiumThemes}>Retro 2016 · {me.premium?.name ?? "Premium"}</option></select></label>
            <label className="toggle-row"><input type="checkbox" checked={prefs.sounds} onChange={(event) => updatePrefs({ sounds: event.target.checked })} /><span>Sound effects</span></label>
            <label>SOUND EFFECT VOLUME<input type="range" min="0" max="1" step="0.05" value={prefs.soundVolume} onChange={(event) => updatePrefs({ soundVolume: Number(event.target.value) })} /></label>
            <div className="settings-card"><Bell size={20} /><div><strong>Browser notifications</strong><p>Receive alerts while OpenCord is in the background.</p></div><button className="secondary-button" onClick={async () => { if (!('Notification' in window)) return notify('Your browser does not support notifications.'); const result = await Notification.requestPermission(); notify(result === 'granted' ? 'Notifications enabled.' : 'Permission not granted.'); }}>Enable</button></div>
          </div>}

          {tab === 'premium' && me.premium && <div className="premium-settings-page" style={{ '--premium-color': me.premium.color } as import('react').CSSProperties}>
            <div className="premium-hero">{me.premium.iconPath ? <img src={me.premium.iconPath} alt="" /> : <Crown size={30} />}<div><h2>{me.premium.name}</h2><p>{me.premium.description}</p><span>{me.premium.expiresAt ? `Active until ${new Date(me.premium.expiresAt).toLocaleString('en-US')}` : 'Permanent membership'}</span></div></div>
            <form className="form-stack" onSubmit={savePremiumProfile}>
              <h3>Advanced profile</h3>
              <label>PROFILE THEME<select name="profileTheme" defaultValue={me.profileTheme || 'classic'} disabled={!me.premium.benefits.customProfileTheme}><option value="classic">Classic</option><option value="midnight">Midnight</option><option value="glass">Glass</option><option value="neon">Neon</option><option value="minimal">Minimal</option></select></label>
              <label>CSS GRADIENT<input name="profileGradient" defaultValue={me.profileGradient} maxLength={160} disabled={!me.premium.benefits.profileGradient} placeholder="linear-gradient(135deg, #7289da, #f47fff)" /></label>
              <label>EFFECT<select name="profileEffect" defaultValue={me.profileEffect} disabled={!me.premium.benefits.profileEffects}><option value="">None</option><option value="glow">Glow</option><option value="pulse">Pulse</option><option value="stars">Stars</option></select></label>
              <label>SPECIAL IDENTITY<input name="specialIdentity" defaultValue={me.specialIdentity} maxLength={48} disabled={!me.premium.benefits.specialIdentity} placeholder="Short text displayed on your profile" /></label>
              <button className="primary-button">Save customization</button>
            </form>
            <div className="two-column-forms premium-assets">
              <form className="form-stack" onSubmit={(event) => uploadPremiumAsset(event, '/api/me/avatar-decoration')}><ImageUploadField name="image" label="AVATAR DECORATION" currentUrl={me.avatarDecorationPath} accept="image/png,image/jpeg,image/webp,image/gif" required disabled={!me.premium.benefits.avatarDecoration} /><button className="secondary-button" disabled={!me.premium.benefits.avatarDecoration}>Upload decoration</button></form>
              <form className="form-stack" onSubmit={(event) => uploadPremiumAsset(event, '/api/me/profile-background')}><ImageUploadField name="image" label="PROFILE BACKGROUND" currentUrl={me.profileBackgroundPath} accept="image/png,image/jpeg,image/webp,image/gif" required disabled={!me.premium.benefits.profileBackground} /><button className="secondary-button" disabled={!me.premium.benefits.profileBackground}>Upload background</button></form>
              <form className="form-stack" onSubmit={(event) => uploadPremiumAsset(event, '/api/me/custom-join-sound')}><label>CUSTOM CALL JOIN SOUND<input type="file" name="sound" accept="audio/mpeg,audio/ogg,audio/wav" required disabled={!me.premium.benefits.customJoinSound} /></label><button className="secondary-button" disabled={!me.premium.benefits.customJoinSound}>Upload sound</button></form>
            </div>
            {me.premium.benefits.externalEmojis && <section className="premium-emoji-manager"><div className="settings-heading"><div><h3>Custom emojis</h3><p>Use your emojis in any server or conversation and favorite instance emojis from the picker.</p></div><span>{myEmojis.length}/100</span></div><form className="premium-emoji-upload" onSubmit={uploadEmoji}><input name="name" minLength={2} maxLength={32} pattern="[A-Za-z0-9_]+" placeholder="emoji_name" required /><ImageUploadField name="image" label="EMOJI IMAGE" accept="image/png,image/jpeg,image/webp,image/gif" required /><button className="secondary-button">Add emoji</button></form><div className="premium-emoji-grid">{myEmojis.map((emoji) => <div key={emoji.id} className="premium-emoji-card"><img src={emoji.imagePath} alt={`:${emoji.name}:`} /><span>:{emoji.name}:</span><button type="button" className="icon-button danger" title="Delete" onClick={() => void deleteEmoji(emoji)}>×</button></div>)}</div></section>}
            {me.premium.benefits.profileHistoryDays > 0 && <section className="profile-history"><h3>Profile history</h3><p>Changes retained for the last {me.premium.benefits.profileHistoryDays} days.</p><div>{profileHistory.slice(0, 12).map((entry) => <details key={entry.id}><summary>{new Date(entry.createdAt).toLocaleString('en-US')}</summary><pre>{JSON.stringify(entry.snapshot, null, 2)}</pre></details>)}{profileHistory.length === 0 && <span className="muted-text">No profile changes recorded yet.</span>}</div></section>}
            <div className="premium-benefit-summary"><h3>Active benefits</h3><div>{Object.entries(me.premium.benefits).filter(([,value]) => value === true || (typeof value === 'number' && value > 0)).map(([key,value]) => <span key={key}>{key}: {String(value)}</span>)}</div></div>
          </div>}

          {tab === 'premium' && !me.premium && premiumSystem?.enabled && <div className="premium-settings-page" style={{ '--premium-color': premiumSystem.color } as import('react').CSSProperties}>
            <div className="premium-hero">{premiumSystem.iconPath ? <img src={premiumSystem.iconPath} alt="" /> : <Crown size={30} />}<div><h2>{premiumSystem.name}</h2><p>{premiumSystem.description}</p><span>{premiumSystem.priceLabel}</span></div></div>
            <div className="settings-card premium-inactive-card"><Sparkles size={24} /><div><strong>Plan not active on this account</strong><p>Access is controlled by the instance operator. Available benefits remain active for the duration of a membership.</p></div>{monetization?.enabled && monetization.premiumCheckoutUrl && <a className="primary-button button-link" href={monetization.premiumCheckoutUrl} target="_blank" rel="noreferrer noopener">{monetization.premiumCheckoutLabel}<ExternalLink size={15} /></a>}</div>
            <form className="premium-redeem-form" onSubmit={redeemPremiumCode}><div><strong>Have a redemption code?</strong><span>Enter a code issued by this instance.</span></div><input name="code" minLength={8} maxLength={80} autoComplete="off" spellCheck={false} placeholder="OPEN-XXXXXX-XXXXXX-XXXXXX" required /><button className="secondary-button">Redeem</button></form>
            <div className="premium-benefit-summary"><h3>Available benefits</h3><div>{Object.entries(premiumSystem.benefits).filter(([,value]) => value === true || (typeof value === 'number' && value > 0)).map(([key,value]) => <span key={key}>{key}: {String(value)}</span>)}</div></div>
          </div>}

          {tab === 'security' && <>
            <form className="form-stack" onSubmit={changePassword}><h2>Change password</h2><label>CURRENT PASSWORD<input name="currentPassword" type="password" required /></label><label>NEW PASSWORD<input name="newPassword" type="password" minLength={8} required /></label><label>CONFIRM NEW PASSWORD<input name="confirmPassword" type="password" minLength={8} required /></label><button className="primary-button">Change password</button></form>
            <div className="danger-zone"><h3>Sessions</h3><p>Signs your account out of every browser and device.</p><button className="danger-button" onClick={logoutAll}><LogOut size={17} /> Sign out everywhere</button></div>
          </>}


          {tab === 'credits' && <div className="credits-page">
            <div className="credits-hero"><div className="credits-logo">O</div><div><h2>OpenCord</h2><p>Comunicação comunitária em tempo real, independente e auto-hospedada.</p><span>Version 0.6.0 · Feito com ❤️</span></div></div>
            <div className="credits-grid">
              <section className="credits-card"><Code2 size={24} /><div><h3>Criado por você</h3><p>Este OpenCord foi configurado e personalizado por <strong>{me.displayName}</strong>. O projeto é open-source e auto-hospedado.</p></div></section>
              <section className="credits-card"><Heart size={24} /><div><h3>Contribuidores open-source</h3><p>Obrigado a todos que reportam problemas, revisam código, melhoram a documentação e contribuem para o ecossistema do OpenCord.</p></div></section>
            </div>
            {monetization?.enabled && <section className="support-project-card"><div><h3>{monetization.supportTitle}</h3><p>{monetization.supportDescription}</p></div><div className="support-project-actions">{monetization.supportUrl && <a className="primary-button button-link" href={monetization.supportUrl} target="_blank" rel="noreferrer noopener">{monetization.supportButtonLabel}<ExternalLink size={15} /></a>}{monetization.managedHostingUrl && <a className="secondary-button button-link" href={monetization.managedHostingUrl} target="_blank" rel="noreferrer noopener">{monetization.managedHostingLabel}<ExternalLink size={15} /></a>}</div></section>}
            <div className="credits-links"><a href="/legal/terms.html" target="_blank" rel="noreferrer">Termos de Uso</a><a href="/legal/acceptable-use.html" target="_blank" rel="noreferrer">Política de Uso Aceitável</a><a href="/legal/privacy.html" target="_blank" rel="noreferrer">Privacidade</a><a href="https://opensource.org/license/mit" target="_blank" rel="noreferrer">Licença MIT</a></div>
          </div>}

          {tab === 'admin' && me.isInstanceAdmin && <AdminPanel notify={notify} />}
        </div>
      </div>
    </Modal>
  );
}
