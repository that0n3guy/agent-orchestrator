/**
 * Unified server — runs Next.js + terminal WebSocket on a single port.
 * Handles WebSocket upgrade for /ao-terminal-ws path, proxies to the
 * direct terminal server internally.
 *
 * This enables the dashboard to work behind a single-port reverse proxy
 * (e.g., Cloudflare Tunnel) without needing separate ports for WebSocket.
 */

import { createServer } from "node:http";
import { parse } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDirectTerminalServer } from "./direct-terminal-ws.js";

const require = createRequire(import.meta.url);
const nextCreate = require("next") as (opts: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => {
  prepare(): Promise<void>;
  getRequestHandler(): (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    parsedUrl?: import("node:url").UrlWithParsedQuery,
  ) => Promise<void>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");

const port = parseInt(process.env["PORT"] || "4200", 10);
const hostname = process.env["HOSTNAME"] || "0.0.0.0";
const dev = process.env["NODE_ENV"] !== "production";

// Initialize Next.js
const app = nextCreate({ dev, dir: pkgRoot, hostname, port });
const handle = app.getRequestHandler();

// Initialize direct terminal WebSocket server (no listen — we'll attach manually)
const directTerminal = createDirectTerminalServer();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "/", true);

    // Health check for terminal
    if (parsedUrl.pathname === "/ao-terminal-health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Everything else goes to Next.js
    handle(req, res, parsedUrl);
  });

  // Handle WebSocket upgrades
  server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = parse(req.url || "/", true);

    if (pathname === "/ao-terminal-ws") {
      // Rewrite the URL so the direct terminal server sees /ws?session=...
      req.url = `/ws?session=${query["session"] || ""}`;
      directTerminal.wss.handleUpgrade(req, socket, head, (ws) => {
        directTerminal.wss.emit("connection", ws, req);
      });
    } else {
      // Let Next.js handle other WebSocket upgrades (HMR in dev mode)
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`[unified] Dashboard + terminal listening on http://${hostname}:${port}`);
  });

  // Graceful shutdown
  function cleanup() {
    directTerminal.shutdown();
    server.close();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
});
