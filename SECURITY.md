# Security Policy

## Supported release

Security fixes are targeted at the latest published OpenCord release.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue before the maintainer has had a reasonable opportunity to investigate it.

Use GitHub's private vulnerability reporting / Security Advisory feature when it is enabled for the repository. Include:

- affected version
- affected component
- reproduction steps
- expected and actual behavior
- security impact
- logs or proof-of-concept details needed to reproduce the issue

Do not include real user credentials, session cookies, private messages, or unrelated personal data.

## Scope

Useful reports include authentication bypasses, authorization failures, SQL injection, stored or reflected script injection, unrestricted file access, path traversal, session compromise, cross-site request forgery, server-side request forgery, insecure WebRTC signaling, and privilege escalation.

## Deployment security

Self-hosted operators are responsible for TLS, host security, firewall rules, administrator credentials, dependency updates, backups, TURN configuration, and physical/network access to the host.
