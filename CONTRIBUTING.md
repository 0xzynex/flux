# Contributing to FLUX

Small fixes, bug reports, and pump / DEX parser improvements are all welcome.

## Reporting a bug

Open an issue with:

- What you tried (mint address, RPC provider, browser).
- What you saw versus what you expected.
- Any relevant console output from the terminal running `npm start` and the
  browser dev tools.

If a specific transaction was misparsed or missed, include the signature — that
makes it debuggable in one paste.

## Sending a pull request

1. Fork the repo and create a branch.
2. Make your change. Keep it focused — one fix or one feature per PR.
3. Test locally against a real, active pump.fun or Raydium token.
4. Do not commit `.env`, `node_modules/`, or your Helius key.
5. Open the PR against `main` with a short description of what changed and why.

## Style

- Node.js, plain CommonJS. No TypeScript, no bundler.
- Front-end is a single `public/index.html` — keep it that way unless you have a
  strong reason to split it.
- Prefer readable code over clever code.

## Security

If you find a security issue (a way to exfiltrate a user's key, a proxy trick,
anything similar), please open a private security advisory on GitHub instead of a
public issue.
