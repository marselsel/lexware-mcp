import type { Request, Response } from "express";
import { mcpAuthMetadataRouter, McpServer, requireBearerAuth } from "skybridge/server";
import { bearerAuthMiddleware } from "./auth.js";
import { ConfigError, describeCapabilities, loadConfig } from "./config.js";
import { LexwareClient } from "./lexware/client.js";
import { buildOAuthMetadata, createAccessTokenVerifier } from "./oauth.js";
import { registerTools } from "./tools/index.js";

// Fail fast with a clear, secret-free message on any misconfiguration.
let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Skybridge's `run()` binds `process.env.__PORT` (default 3000). When running the
// built server directly (`node dist/server.js`) there's no `skybridge start` to
// bridge ports, so make our validated `config.port` (which reads `PORT`, default
// 8080) authoritative. `skybridge dev` sets `__PORT` itself, so only set it when
// it isn't already provided.
if (!process.env.__PORT) {
  process.env.__PORT = String(config.port);
}

const client = new LexwareClient({
  baseUrl: config.lexwareApiBaseUrl,
  apiKey: config.lexwareApiKey,
  debug: config.debugLogging,
});

const server = new McpServer(
  {
    name: "lexware-office",
    version: "0.1.2",
  },
  { capabilities: {} },
);

// Unauthenticated health check. Use `/status`, not `/healthz`: Google Front End
// intercepts `/healthz` on Cloud Run (it never reaches the container).
server.express.get("/status", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Gate the MCP endpoint according to the configured auth mode.
if (config.auth.mode === "oauth") {
  const oauth = config.auth;
  // Advertise the authorization server so MCP clients can discover and sign in.
  server.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildOAuthMetadata(oauth),
      resourceServerUrl: new URL(oauth.resource),
    }),
  );
  // RFC 9728: the protected-resource metadata path is the well-known segment
  // followed by the resource's path (so a path-bearing resource resolves correctly).
  const resUrl = new URL(oauth.resource);
  const resPath = resUrl.pathname === "/" ? "" : resUrl.pathname.replace(/\/$/, "");
  server.use(
    "/mcp",
    requireBearerAuth({
      verifier: { verifyAccessToken: createAccessTokenVerifier(oauth) },
      resourceMetadataUrl: `${resUrl.origin}/.well-known/oauth-protected-resource${resPath}`,
    }),
  );
} else if (config.auth.mode === "static") {
  server.use("/mcp", bearerAuthMiddleware(config.auth.token));
}
// mode "none": no gate (operator explicitly opted into unauthenticated).

registerTools(server, client, config);

console.error(`[lexware-mcp] starting — ${describeCapabilities(config)}`);
if (config.auth.mode === "oauth" && config.auth.allowedEmailDomains.length === 0) {
  console.error(
    "[lexware-mcp] WARNING: OAuth mode with no OAUTH_ALLOWED_EMAIL_DOMAINS — ANY user who can " +
      "authenticate with your issuer can reach this server. Set OAUTH_ALLOWED_EMAIL_DOMAINS to restrict access.",
  );
}

export default await server.run();

export type AppType = typeof server;
