import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

const PKG_ROOT = path.resolve(import.meta.dirname, "..");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

export interface Viewer {
  url: string;
  broadcast(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * Serves the three.js viewer and streams events to it over a WebSocket. Late joiners get
 * every event so far (only the latest observation images), so the page can replay the run.
 * `runDir` exposes a saved run's files under /run/ for replays.
 */
export async function startViewer(opts: { port: number; hello: Record<string, unknown>; runDir?: string }): Promise<Viewer> {
  const history: Record<string, unknown>[] = [];
  let latestObs: Record<string, unknown> | null = null;
  const statics: [string, string][] = [
    ["/vendor/three/", path.join(PKG_ROOT, "node_modules", "three")],
    ["/run/", opts.runDir ?? ""],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let file: string | null = null;
    if (url.pathname === "/") file = path.join(PKG_ROOT, "viewer", "index.html");
    else if (url.pathname === "/main.js") file = path.join(PKG_ROOT, "viewer", "main.js");
    else {
      for (const [prefix, root] of statics) {
        if (!root || !url.pathname.startsWith(prefix)) continue;
        const candidate = path.resolve(root, "." + decodeURIComponent(url.pathname.slice(prefix.length - 1)));
        if (candidate.startsWith(path.resolve(root) + path.sep)) file = candidate;
      }
    }
    if (!file) return void res.writeHead(404).end("not found");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  const clients = new Set<WebSocket>();

  let pending: Record<string, unknown>[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (!pending.length) return;
    const msg = JSON.stringify(pending);
    pending = [];
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  // Bind the port first (trying the next ones when it is taken), then attach the WebSocket server: attached earlier,
  // it re-emits the failed listen's EADDRINUSE as an unhandled error and the run crashes.
  const port = await listen(server, opts.port);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    const backlog = latestObs ? [...history, latestObs] : history;
    ws.send(JSON.stringify([opts.hello, ...backlog]));
  });
  return {
    url: `http://localhost:${port}/`,
    broadcast(event) {
      if (event.t === "obs") latestObs = event;
      else history.push(event);
      pending.push(event);
      timer ??= setTimeout(flush, 40);
    },
    close: () =>
      new Promise((resolve) => {
        flush();
        for (const ws of clients) ws.close();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

async function listen(server: http.Server, port: number): Promise<number> {
  for (let p = port; p < port + 20; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => resolve(true));
    });
    if (ok) return p;
  }
  throw new Error(`no free port in ${port}-${port + 19}`);
}
