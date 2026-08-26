# Public Hosting

This guide publishes a OpenCord instance without Docker. The recommended layout is:

```text
Internet
   |
HTTPS :443
   |
Caddy
   |
127.0.0.1:4000
   |
OpenCord
```

Keeping the Node.js application behind a reverse proxy provides HTTPS, modern TLS, and a single public entry point.

## 1. Prepare a domain

Create an `A` record such as:

```text
chat.example.com -> YOUR_PUBLIC_IPV4
```

If you publish IPv6, add the appropriate `AAAA` record as well.

## 2. Configure OpenCord

For a reverse proxy running on the same computer, use:

```dotenv
HOST=127.0.0.1
PORT=4000
PUBLIC_URL=https://chat.example.com
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://chat.example.com
TRUST_PROXY=loopback
ICE_SERVERS_JSON=[]
```

Replace `chat.example.com` with your domain.

`COOKIE_SECURE=true` should be used when the public site is HTTPS.

## 3. Install Caddy

Install Caddy from its official distribution for your operating system. Copy `Caddyfile.example` to a working Caddyfile and replace the example domain.

```caddyfile
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4000
}
```

Start OpenCord first, then start Caddy.

Caddy can obtain and renew TLS certificates automatically when the domain resolves correctly and inbound ports are reachable.

## 4. Router and firewall

When hosting from a home connection, forward these TCP ports from the router to the machine running Caddy:

```text
80
443
```

Allow those ports through the host firewall. Do not forward port `4000` when Caddy and OpenCord are on the same machine.

Some residential internet providers use CGNAT. If inbound port forwarding is unavailable, use a reputable HTTPS tunnel or a VPS/reverse proxy you control.

## 5. WebRTC voice and video

HTTPS is required for reliable browser microphone, camera, and screen-capture permissions outside `localhost`.

STUN alone is not sufficient for every network. Users behind restrictive NAT, carrier networks, corporate networks, or symmetric NAT may require a TURN server.

OpenCord accepts standard WebRTC ICE configuration through `ICE_SERVERS_JSON`:

```dotenv
ICE_SERVERS_JSON=[{"urls":["stun:stun.example.com:3478"]},{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"opencord","credential":"CHANGE_THIS_TO_A_LONG_RANDOM_PASSWORD"}]
```

Use a TURN server you operate or trust. Configure authentication and bandwidth limits on the TURN server. TURN credentials delivered to browser clients are necessarily visible to authenticated clients, so use dedicated credentials and rotate them when appropriate.

If you operate coturn, its public listener and relay port range must also be allowed through the relevant firewall/router according to your coturn configuration.

## 6. Verify deployment

Check the following from a device that is not on the host machine:

1. `https://chat.example.com` loads without a certificate warning.
2. Registration/login works.
3. Real-time messages appear without refreshing.
4. Browser microphone permission is available.
5. Two users can hear each other.
6. Camera tracks appear for remote participants.
7. Screen sharing can enter fullscreen.
8. Uploads are available only through expected `/uploads/` URLs.

## 7. Production checklist

- Use HTTPS only.
- Keep Node.js and npm dependencies updated.
- Keep the operating system updated.
- Use a strong administrator password.
- Disable registration from the admin panel if the instance is private.
- Create regular database backups.
- Back up both `data/opencord.db` and `uploads/`.
- Do not expose the SQLite database or backup directory through a web server.
- Restrict remote administration access where possible.
- Use a dedicated TURN credential and rotate it periodically.
- Review audit logs after administrative changes.
- Define moderation rules appropriate for your community and jurisdiction.

## Local-network-only hosting

If the instance never needs to be public, leave:

```dotenv
HOST=0.0.0.0
PORT=4000
PUBLIC_URL=http://localhost:4000
COOKIE_SECURE=false
```

Then open `http://LAN-IP:4000` from another device on the same network. Camera and microphone may still be blocked by browsers because plain HTTP on a non-loopback address is not a secure context. HTTPS is recommended even for advanced LAN deployments that need voice/video.
