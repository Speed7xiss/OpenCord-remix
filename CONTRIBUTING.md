# Contributing

Thank you for improving OpenCord.

## Development setup

```bash
npm install
npm run dev
```

## Before opening a pull request

- Keep changes focused and maintainable.
- Preserve server-side authorization checks for privileged actions.
- Validate all untrusted API input.
- Keep the desktop and mobile interfaces functional.
- Do not add Docker as a required dependency.
- Do not commit `data/opencord.db`, uploaded user files, backups, logs, `.env`, tokens, passwords, or TURN credentials.
- Run `npm run build`.
- Explain schema migrations and backwards-compatibility considerations in the pull request.

## Code style

Use clear names, small cohesive functions, and existing project conventions. Avoid redundant inline comments; prefer code that communicates intent through structure and naming.

## Security changes

Potential security vulnerabilities should follow `SECURITY.md` instead of being discussed in a public issue first.
