# Security Policy

## Reporting a vulnerability

Please report security issues privately. Open a [GitHub security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainers. Do **not** open a public issue for
a vulnerability. We aim to acknowledge reports within a few business days.

## Operating this server securely

This server brokers access to **real accounting data**. When you self-host it:

- **Protect `/mcp`.** Always set a strong `MCP_AUTH_TOKEN` (e.g. `openssl rand -hex 32`).
  The server refuses to start without one unless you explicitly set
  `MCP_ALLOW_UNAUTHENTICATED=true` — only ever do that for trusted local testing.
- **Treat `LEXWARE_API_KEY` like banking credentials.** Store it in a secret
  manager (e.g. Google Secret Manager), never in the image or in version control.
- **Use the least capability you need.** Leave `LEXWARE_ENABLE_FINALIZE=false`
  unless you intend to let the agent issue legally binding invoices; consider
  `LEXWARE_READ_ONLY=true` for read-only deployments.
- **Keep logs clean.** The server never logs secrets or request/response bodies
  unless you opt into `LEXWARE_DEBUG_LOGGING=true`.
- **Serve over HTTPS.** Terminate TLS in front of the server (Cloud Run does this
  for you).
