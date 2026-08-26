# Privacy Notice

OpenCord is self-hosted software. Privacy responsibilities depend on who operates the instance you use.

## Project maintainers

The OpenCord project maintainers do not receive the contents of third-party self-hosted instances by default. The application does not require a OpenCord cloud account, project analytics service, or central message relay operated by the project maintainers.

## Instance operators

A OpenCord instance stores information locally on the operator's server, including account data, password hashes, session records, messages, friendships, server memberships, moderation records, uploaded files, profile information, and instance audit records.

The instance database is stored in `data/opencord.db`. Uploaded files are stored under `uploads/`. Backups may be stored under `backups/`.

The operator is responsible for providing any legally required privacy notice, choosing retention periods, protecting backups, responding to lawful data requests, and determining the legal basis for processing personal data in the operator's jurisdiction.

## Passwords and sessions

Passwords are stored as password hashes rather than plaintext passwords. Authentication sessions use server-side session records and HTTP-only cookies.

## Voice and video

Voice, camera, and screen-sharing media use WebRTC between participating browsers when direct connectivity is possible. A configured TURN relay may relay encrypted WebRTC packets when direct peer connectivity fails. The TURN provider selected by the instance operator may process network metadata needed to provide that relay.

## Public deployment

A public reverse proxy, DNS provider, hosting provider, firewall, tunnel provider, or TURN provider may process connection metadata according to that provider's own terms and privacy practices. The instance operator chooses those providers independently.
