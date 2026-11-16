import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Balance } from "../shared/types.js";
import type { ClientMessage } from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { RoomManager, type Connection } from "./rooms.js";
import { findPublicDir } from "./balance.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_MESSAGE_BYTES = 64 * 1024;
const VERSION = "0.1.0";

export interface GameServer {
  server: http.Server;
  wss: WebSocketServer;
  manager: RoomManager;
  close(): Promise<void>;
}

export function createGameServer(balance: Balance, publicDir = findPublicDir()): GameServer {
  const manager = new RoomManager(balance);
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    setSecurityHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      return;
    }

    if (url.pathname === "/api/health" || url.pathname === "/healthz") {
      const stats = manager.stats();
      json(res, 200, {
        status: "ok",
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        rooms: stats.rooms,
        players: stats.players,
        matches: stats.matches,
        tickHz: balance.match.tickHz,
        snapshotHz: balance.match.snapshotHz,
      });
      return;
    }

    if (url.pathname === "/api/balance") {
      json(res, 200, balance);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      json(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }

    serveStatic(req, res, url.pathname, publicDir);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    const connection: Connection = {
      socket: ws,
      room: null,
      slot: null,
      send(message) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(message));
          } catch {
            /* сокет закрывается */
          }
        }
      },
      close() {
        try {
          ws.close();
        } catch {
          /* уже закрыт */
        }
      },
    };

    connection.send({ t: "welcome", version: VERSION });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (text.length > MAX_MESSAGE_BYTES) {
        connection.send({ t: "error", message: "Слишком большое сообщение" });
        return;
      }
      let message: ClientMessage;
      try {
        message = JSON.parse(text) as ClientMessage;
      } catch {
        connection.send({ t: "error", message: "Некорректный JSON" });
        return;
      }
      if (!message || typeof message.t !== "string") {
        connection.send({ t: "error", message: "Некорректное сообщение" });
        return;
      }

      switch (message.t) {
        case "join": {
          if (connection.room) {
            connection.send({ t: "error", message: "Вы уже в комнате" });
            return;
          }
          manager.join(connection, message);
          return;
        }
        case "cmd": {
          if (!connection.room) {
            connection.send({ t: "error", message: "Сначала войдите в комнату" });
            return;
          }
          connection.room.handleCommand(connection, message.cmd);
          return;
        }
        case "chat": {
          if (!connection.room) return;
          connection.room.handleChat(connection, String(message.text ?? ""));
          return;
        }
        case "ping": {
          connection.send({ t: "pong", at: Number(message.at) || 0 });
          return;
        }
        case "leave": {
          connection.room?.handleClose(connection);
          connection.close();
          return;
        }
        default:
          connection.send({ t: "error", message: "Неизвестный тип сообщения" });
      }
    });

    const cleanup = (): void => {
      connection.room?.handleClose(connection);
      connection.room = null;
      connection.slot = null;
      alive.delete(ws);
    };
    ws.on("close", cleanup);
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      try {
        client.ping();
      } catch {
        /* сокет мёртв */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    for (const client of wss.clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, wss, manager, close };
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  publicDir: string,
): void {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    json(res, 400, { error: "bad_path" });
    return;
  }
  if (relative === "") relative = "index.html";

  const file = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (file !== root && !file.startsWith(root + path.sep)) {
    json(res, 403, { error: "forbidden" });
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      if (relative.startsWith("assets/")) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const index = path.join(root, "index.html");
      fs.readFile(index, (indexErr, content) => {
        if (indexErr) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Клиент не собран. Выполните npm run build или запустите npm run dev.");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[".html"]!,
          "Cache-Control": "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : content);
      });
      return;
    }

    const ext = path.extname(file).toLowerCase();
    const cache = relative.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : relative.startsWith("data/")
        ? "public, max-age=300"
        : "no-cache";
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": cache,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}
