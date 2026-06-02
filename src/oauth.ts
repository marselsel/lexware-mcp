import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import * as jose from "jose";

/** Upper bound on the userinfo email cache to prevent unbounded growth. */
const MAX_EMAIL_CACHE_ENTRIES = 5000;

/** The OAuth slice of {@link import("./config.js").AuthConfig} (mode === "oauth"). */
export interface OAuthSettings {
  issuer: string;
  jwksUrl: string;
  resource: string;
  verifyAudience: boolean;
  allowedEmailDomains: string[];
  userinfoUrl: string;
}

/** True when `email`'s domain is in `allowed` (case-insensitive). Pure; unit-tested. */
export function isEmailDomainAllowed(email: string | undefined, allowed: string[]): boolean {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return allowed.map((d) => d.toLowerCase()).includes(domain);
}

/**
 * Authorization-server metadata advertised at `/.well-known/oauth-authorization-server`
 * (a convenience proxy; modern clients discover the AS via the protected-resource doc).
 */
export function buildOAuthMetadata(oauth: OAuthSettings): OAuthMetadata {
  // `issuer` must be exact; endpoints join onto a slash-free base.
  const base = oauth.issuer.replace(/\/+$/, "");
  return {
    issuer: oauth.issuer,
    authorization_endpoint: `${base}/oauth2/authorize`,
    token_endpoint: `${base}/oauth2/token`,
    registration_endpoint: `${base}/oauth2/register`,
    jwks_uri: oauth.jwksUrl,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email", "profile"],
  };
}

/** Fetch the user's email from the OIDC userinfo endpoint, or undefined on failure. */
async function fetchUserinfoEmail(
  token: string,
  userinfoUrl: string,
  fetchFn: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(userinfoUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    return typeof data.email === "string" ? data.email : undefined;
  } catch {
    return undefined;
  }
}

export interface VerifierDeps {
  /** JWKS resolver; injectable for tests. Defaults to a remote JWKS set. */
  jwks?: ReturnType<typeof jose.createRemoteJWKSet>;
  fetchFn?: typeof fetch;
}

/**
 * Build a `verifyAccessToken` for `requireBearerAuth`. It verifies the JWT
 * signature/issuer/audience via JWKS, then — if `allowedEmailDomains` is set —
 * enforces the user's email domain (reading the `email` claim, falling back to
 * the userinfo endpoint), failing closed if the email can't be established.
 */
export function createAccessTokenVerifier(oauth: OAuthSettings, deps: VerifierDeps = {}) {
  const jwks = deps.jwks ?? jose.createRemoteJWKSet(new URL(oauth.jwksUrl));
  const fetchFn = deps.fetchFn ?? fetch;
  // Caches only successful userinfo lookups (token -> email) to avoid re-hitting
  // userinfo on every request. Misses are never cached (see below).
  const emailCache = new Map<string, { email: string; exp: number }>();

  // Accept the audience with or without a trailing slash: the advertised
  // Resource Indicator (`new URL(resource)`) serializes a bare origin with a
  // trailing slash, but `resource` is stored normalized without one.
  const audiences = oauth.resource.endsWith("/")
    ? [oauth.resource, oauth.resource.slice(0, -1)]
    : [oauth.resource, `${oauth.resource}/`];

  return async function verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, jwks, {
        issuer: oauth.issuer,
        ...(oauth.verifyAudience ? { audience: audiences } : {}),
      }));
    } catch {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) throw new InvalidTokenError("Token is missing the sub claim");

    let email = typeof payload.email === "string" ? payload.email : undefined;

    if (oauth.allowedEmailDomains.length > 0) {
      if (!email) {
        const nowSec = Math.floor(Date.now() / 1000);
        const cached = emailCache.get(token);
        if (cached && cached.exp > nowSec) {
          email = cached.email;
        } else {
          email = await fetchUserinfoEmail(token, oauth.userinfoUrl, fetchFn);
          // Cache only positive results: caching a transient miss would lock out
          // a valid user until their token expires.
          if (email) {
            const exp = typeof payload.exp === "number" ? payload.exp : nowSec + 300;
            if (emailCache.size >= MAX_EMAIL_CACHE_ENTRIES) {
              // Evict expired entries; if still full, drop everything (it's just a cache).
              for (const [k, v] of emailCache) if (v.exp <= nowSec) emailCache.delete(k);
              if (emailCache.size >= MAX_EMAIL_CACHE_ENTRIES) emailCache.clear();
            }
            emailCache.set(token, { email, exp });
          }
        }
      }
      if (!isEmailDomainAllowed(email, oauth.allowedEmailDomains)) {
        throw new InvalidTokenError("Your email domain is not permitted to use this server");
      }
    }

    return {
      token,
      clientId: (payload.client_id ?? payload.azp ?? "") as string,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      extra: { sub, ...(email ? { email } : {}) },
    };
  };
}
