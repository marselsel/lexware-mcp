# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial open-source release of the Lexware Office MCP server (Skybridge MCP App) —
  a remote/hosted, OAuth-capable connector for the Claude app, claude.ai web, and ChatGPT.
- **~40 tools** across read / draft / finalize tiers:
  - **Read** (always on): profile; contacts & articles (list/get); voucherlist; full
    documents (invoices, quotations, credit notes, order confirmations, delivery notes,
    dunnings, down-payment invoices, vouchers); payments; reference data (countries,
    payment conditions, posting categories, print layouts); recurring templates; event
    subscriptions; document deeplinks.
  - **Drafts/writes** (`LEXWARE_ENABLE_DRAFTS`, on): create draft invoices/quotations/
    credit-notes/order-confirmations/delivery-notes/dunnings; create & update contacts and
    articles (optimistic locking); create event subscriptions.
  - **Finalize** (`LEXWARE_ENABLE_FINALIZE`, off): issue legally-binding finalized
    documents (confirmation-gated); irreversible deletes (e.g. delete event subscriptions).
- Authentication on `/mcp`, fail-closed, in two modes:
  - **Static bearer token** (`MCP_AUTH_TOKEN`) for Claude Code/Desktop.
  - **OAuth 2.1** (`OAUTH_ISSUER`, …) via any provider (e.g. WorkOS AuthKit) — exposes
    `/.well-known/oauth-protected-resource`, validates JWT access tokens against the
    provider's JWKS, and optionally restricts `OAUTH_ALLOWED_EMAIL_DOMAINS` (enforced
    server-side). Enables use as a custom connector in the Claude app and on claude.ai web.
- `~2 req/s` rate limiting with 429/`Retry-After` backoff, and capability tiers via env flags.
- Docker image, `docker-compose.yml`, Cloud Run guide, CI, and tests.

### Known limitations
- `get-document-link` returns a Lexware web-app deeplink; fetching raw PDF bytes
  is not yet implemented.
