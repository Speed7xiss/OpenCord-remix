# OpenCord

OpenCord is a self-hosted real-time community chat application inspired by the compact desktop layout of mid-2010s chat clients. It provides servers, text and voice channels, direct messages, friendships, roles, permissions, profiles, moderation, instance administration, custom badges, a configurable premium system, custom emojis, file uploads, voice/video calls, and screen sharing.

OpenCord is designed to be easy to host without Docker. It uses Node.js, React, Socket.IO, WebRTC, and a local SQLite database.

> OpenCord is an independent project. It is not affiliated with, endorsed by, sponsored by, or operated by Discord Inc. No Discord trademarks, logos, proprietary artwork, or private APIs are required by this project.

## Features

- Self-hosted accounts with secure HTTP-only sessions
- Servers, categories, text channels, and voice channels
- Real-time messages, replies, edits, deletes, reactions, pins, search, typing indicators, and attachments
- Image previews before sending attachments
- Direct messages, group DMs, friendships, blocks, and presence
- WebRTC voice, camera, and screen sharing with fullscreen presentation mode
- Per-user volume, mute, deafen, push-to-talk, device selection, and speaking indicators
- Roles, permission inheritance, channel/category overrides, bans, kicks, and audit logs
- Clickable profiles, banners, status, bio, mutual friends, and common servers
- Image-based badges with hover tooltips and administrator assignment
- Configurable premium system with custom name, icon, color, benefits, limits, and expiration
- Custom emojis and favorites
- Complete instance administration panel
- Built-in Credits area with creator attribution
- Admin-configurable monetization links for premium checkout, sponsorship/donations, and managed hosting
- Premium redemption codes with configurable duration and usage limits
- Temporary/permanent instance bans with reasons and audit history
- Local SQLite backups and restore support
- Responsive desktop, tablet, and mobile layouts
- Touch/long-press context menus
- Dark, light, classic, midnight, and premium theme support
- Windows graphical launcher
- No Docker, PostgreSQL, Redis, or external database required

## Requirements

- Node.js 24 or newer
- npm
- Windows 10/11, Linux, or macOS
- A modern browser with WebRTC support

## Quick start

### Windows

1. Download or clone this repository.
2. Run `launcher.bat`.
3. Select **Install / Update** once.
4. Select **Start**.
5. Select **Open browser**.
6. Register the first account. The first account becomes the instance administrator.

You can also use a terminal:

```powershell
npm install
npm run build
npm start
```

Open `http://localhost:4000`.

### Linux or macOS

```bash
chmod +x install.sh start.sh
./install.sh
./start.sh
```

Or:

```bash
npm install
npm run build
npm start
```

Open `http://localhost:4000`.

## Development

```bash
npm install
npm run dev
```

The Vite frontend runs on `http://localhost:5173` and proxies API traffic to the local backend.

## Data locations

OpenCord stores instance data locally:

```text
data/opencord.db
uploads/
backups/
logs/
```

Back up `data/opencord.db` and `uploads/` before upgrading or moving an instance.

## Configuration

Copy `.env.example` to `.env`. The launcher does this automatically when necessary.

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` | Backend bind address | `0.0.0.0` |
| `PORT` | HTTP port | `4000` |
| `PUBLIC_URL` | Canonical URL used for origin validation | `http://localhost:4000` |
| `COOKIE_SECURE` | Require HTTPS for session cookies | `false` |
| `ALLOWED_ORIGINS` | Comma-separated additional trusted browser origins | empty |
| `TRUST_PROXY` | Express trusted proxy setting | `loopback` |
| `ICE_SERVERS_JSON` | JSON array of STUN/TURN servers for WebRTC | `[]` |

For public hosting, do not simply expose an unencrypted HTTP port. Use HTTPS and a reverse proxy. See [Public hosting](docs/PUBLIC_HOSTING.md).

## Public access

For devices on the same trusted LAN, other users can open:

```text
http://YOUR-LAN-IP:4000
```

Text chat works over local HTTP, but browsers normally require a secure context for camera and microphone access when the page is not `localhost`. For public use, configure a domain and HTTPS.

See:

- [Public hosting guide](docs/PUBLIC_HOSTING.md)
- [Security policy](SECURITY.md)
- [Privacy notice](PRIVACY.md)


## Monetization

OpenCord does not process payments or store payment-card data. Instance administrators can configure external HTTPS links in **User Settings → Instance → Monetization**.

Supported monetization paths:

- **Premium checkout:** link the configurable premium plan to Stripe Payment Links, Patreon, Ko-fi, Mercado Pago, your own storefront, or another billing system.
- **Redemption codes:** generate one-time or limited-use premium codes with temporary or permanent membership duration, then distribute them after external payment.
- **Project support:** display an optional support/donation button in the Credits area.
- **Managed hosting:** advertise a paid deployment, maintenance, or managed-hosting service for users who do not want to self-host.

OpenCord only displays the configured links. Payment processing, taxes, refunds, renewals, entitlement automation, and legal obligations remain with the instance operator and chosen payment provider. See [MONETIZATION.md](MONETIZATION.md).

## Credits

OpenCord was created by **Harukai33**. The in-app Credits area is available from **User Settings → Credits**. See [CREDITS.md](CREDITS.md).

## Rebrand upgrade note

When upgrading an installation from a release before 0.6.0, copy the previous database into the new `data/` directory and rename it to `opencord.db` before the first start. Preserve `uploads/` as well. Browser preferences use new OpenCord storage keys and session cookies, so users may need to sign in again after the rebrand.

## Updating

1. Stop OpenCord.
2. Back up `data/opencord.db` and `uploads/`.
3. Replace application files with the new release.
4. Preserve your `data/`, `uploads/`, and `.env`.
5. Run:

```bash
npm install
npm run build
npm start
```

Database migrations run automatically at startup.

## Legal and acceptable use

New accounts must accept the project Terms of Use and Acceptable Use Policy during registration.

- [Terms of Use](TERMS_OF_USE.md)
- [Acceptable Use Policy](ACCEPTABLE_USE_POLICY.md)
- [Privacy Notice](PRIVACY.md)
- [License](LICENSE)

OpenCord is infrastructure software. Operators of self-hosted instances are independent from the project maintainers and are responsible for their own instance, users, content, moderation, data handling, security, and legal compliance. The software must not be used to facilitate unlawful activity.

The included legal documents are general project terms and are not a substitute for advice from a qualified lawyer in the maintainer's jurisdiction.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Do not publish security vulnerabilities as public issues. See [SECURITY.md](SECURITY.md) for the preferred reporting process.

## License

OpenCord is distributed under the MIT License. See [LICENSE](LICENSE).
