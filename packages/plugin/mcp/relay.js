#!/usr/bin/env node

// packages/mcp/src/relay/main.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// packages/core/src/env-names.ts
var ENV_RENAMES = [
  ["FEEDBACK_BASE_URL", "CW_BASE_URL"],
  ["FEEDBACK_AGENT_NAME", "CW_AGENT_NAME"],
  ["FEEDBACK_AUTHOR", "CW_AUTHOR"],
  ["LIVE_FEEDBACK_SUMMARY_API_KEY", "CW_SUMMARY_API_KEY"]
];
var LEGACY_OF = new Map(ENV_RENAMES.map(([legacy, current]) => [current, legacy]));
function present(v) {
  return v !== undefined && v.trim() !== "";
}
function readRenamedEnv(env, current) {
  const direct = env[current];
  if (present(direct))
    return direct;
  const legacy = LEGACY_OF.get(current);
  if (legacy !== undefined) {
    const old = env[legacy];
    if (present(old))
      return old;
  }
  return direct;
}

// packages/core/src/machine-paths.ts
import { join } from "node:path";
var PRODUCT_SLUG = "claude-workspaces";
var PRODUCT_SLUG_LEGACY = "live-feedback";
var DISCOVERY_DIR_CURRENT = PRODUCT_SLUG;
var DISCOVERY_DIR_LEGACY = PRODUCT_SLUG_LEGACY;
var DISCOVERY_FILE = "server.json";
function discoveryCandidates(home) {
  return [DISCOVERY_DIR_CURRENT, DISCOVERY_DIR_LEGACY].map((dir) => join(home, ".claude", dir, DISCOVERY_FILE));
}
function resolveDiscoveryFile(home, exists) {
  return discoveryCandidates(home).find(exists);
}

// packages/core/src/safe-file.ts
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
var SMALL_FILE_MAX = 64 * 1024;
function readSmallFile(path, max = SMALL_FILE_MAX) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max)
      return null;
    const buf = Buffer.alloc(max + 1);
    let at = 0;
    for (;; ) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0)
        break;
      at += n;
      if (at > max)
        return null;
    }
    return buf.subarray(0, at).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
var TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// packages/mcp/src/http-client.ts
function readDiscoveryText(path) {
  return readSmallFile(path) ?? "";
}
function resolveBaseUrl(deps) {
  const override = readRenamedEnv(deps.env, "CW_BASE_URL");
  if (override)
    return override;
  const discovery = resolveDiscoveryFile(deps.homedir(), deps.existsSync);
  if (discovery) {
    try {
      const j = JSON.parse(deps.readFileSync(discovery, "utf8"));
      if (j.port)
        return `http://127.0.0.1:${j.port}`;
    } catch {}
  }
  throw new Error("claude-workspaces server not found — start it with `bun run dev` (or set CW_BASE_URL). " + `Looked for a discovery file at ${discoveryCandidates(deps.homedir()).join(" and ")}.`);
}

// packages/mcp/src/relay/relay-wire.ts
var SUPPORTED_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
];
var present2 = (v) => v !== undefined && v.trim() !== "" ? v : undefined;
function relayIdentityHeaders(env, cwd) {
  const h = { "x-cw-cwd": cwd };
  const agent = present2(env.CW_AGENT_NAME);
  const legacy = present2(env.FEEDBACK_AGENT_NAME);
  const workspace = present2(env.CW_WORKSPACE_ID) ?? present2(env.FEEDBACK_WORKSPACE_ID);
  const version = present2(env.CW_RELAY_PLUGIN_VERSION);
  if (agent)
    h["x-cw-agent"] = agent;
  if (legacy)
    h["x-cw-agent-legacy"] = legacy;
  if (workspace)
    h["x-cw-workspace"] = workspace.trim();
  if (version)
    h["x-cw-plugin-root"] = `/${version.trim()}`;
  return h;
}
function neverSent(e) {
  const code = e?.cause?.code ?? e?.code;
  return code === "ECONNREFUSED" || code === "ConnectionRefused" || code === "ENOTFOUND" || code === "ENOENT" || code === "EPERM";
}
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
var isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function refusalText(status, body) {
  const j = parse(body);
  const message = isRecord(j) && typeof j.message === "string" ? j.message : body.slice(0, 300);
  const error = isRecord(j) && typeof j.error === "string" ? ` ${j.error}` : "";
  return `the claude-workspaces server refused this session (${status}${error}): ${message}`;
}

// packages/mcp/src/relay/relay-core.ts
var DEFAULT_INIT_WAIT_MS = 1e4;
var RETRY_MAX_MS = 15000;
var STREAM_IDLE_MS = 45000;
function createRelay(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const identity = relayIdentityHeaders(deps.env, deps.cwd);
  const named = identity["x-cw-agent"] !== undefined || identity["x-cw-agent-legacy"] !== undefined;
  const version = identity["x-cw-plugin-root"]?.slice(1) ?? "0.0.0";
  let token = null;
  let sid = null;
  let initRequest = null;
  let initAnswer = "";
  let clientInitialized = false;
  let lastReason = "the claude-workspaces server has not answered yet";
  let lastEventId = null;
  let streamGen = 0;
  let streamAbort = null;
  let opening = null;
  let reconnecting = false;
  let closed = false;
  let toolCalls = 0;
  const held = [];
  const base = () => {
    if (deps.boardSocket !== undefined)
      return "http://board-socket";
    try {
      return resolveBaseUrl({ ...deps, env: deps.env }).replace(/\/+$/, "");
    } catch {
      lastReason = "no claude-workspaces server was found (no discovery file, no CW_BASE_URL)";
      return null;
    }
  };
  const headers = (withSession) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...identity,
    ...token ? { authorization: `Bearer ${token}` } : {},
    ...withSession && sid ? { "mcp-session-id": sid } : {}
  });
  const deliver = (line) => {
    if (toolCalls > 0)
      held.push(line);
    else
      deps.write(line);
  };
  const flushHeld = () => {
    while (toolCalls === 0 && held.length > 0)
      deps.write(held.shift());
  };
  async function mint() {
    if (!named || token || deps.boardSocket !== undefined)
      return;
    const b = base();
    if (!b)
      return;
    try {
      const res = await deps.fetch(`${b}/api/agent-token`, {
        headers: { accept: "application/json", ...identity }
      });
      const text = await res.text();
      const j = parse(text);
      if (res.ok && isRecord(j) && typeof j.token === "string" && j.token)
        token = j.token;
      else {
        lastReason = refusalText(res.status, text);
        deps.log(`[relay] agent token: ${lastReason}`);
      }
    } catch {
      lastReason = "the claude-workspaces server is unreachable";
    }
  }
  async function post(body, withSession) {
    const b = base();
    if (!b)
      return { kind: "unreachable", mayHaveRun: false };
    try {
      const res = await deps.fetch(`${b}/mcp`, {
        method: "POST",
        headers: headers(withSession),
        body
      });
      const text = await res.text();
      return {
        kind: "answer",
        status: res.status,
        body: text,
        sid: res.headers.get("mcp-session-id")
      };
    } catch (e) {
      lastReason = "the claude-workspaces server is unreachable";
      return { kind: "unreachable", mayHaveRun: !neverSent(e) };
    }
  }
  function stopStream() {
    streamGen += 1;
    streamAbort?.abort();
    streamAbort = null;
  }
  function dropSession() {
    sid = null;
    stopStream();
  }
  function openUpstream() {
    opening ??= (async () => {
      if (!initRequest)
        return false;
      await mint();
      let r = await post(initRequest, false);
      if (r.kind === "answer" && (r.status === 401 || r.status === 403) && named) {
        token = null;
        await mint();
        r = await post(initRequest, false);
      }
      if (r.kind !== "answer")
        return false;
      if (r.status !== 200 || !r.sid) {
        lastReason = refusalText(r.status, r.body);
        return false;
      }
      sid = r.sid;
      initAnswer = r.body;
      if (clientInitialized) {
        await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), true);
        startStream();
      }
      return true;
    })().finally(() => {
      opening = null;
    });
    return opening;
  }
  function reconnectInBackground() {
    if (reconnecting || closed)
      return;
    reconnecting = true;
    (async () => {
      let delay = 1000;
      while (!closed && sid === null) {
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
        if (sid !== null)
          break;
        if (await openUpstream()) {
          deps.log("[relay] connected to the claude-workspaces server");
          if (clientInitialized) {
            deps.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
          }
        }
      }
      reconnecting = false;
    })();
  }
  function startStream() {
    stopStream();
    const gen = streamGen;
    (async () => {
      let delay = 1000;
      while (!closed && gen === streamGen && sid !== null) {
        const b = base();
        const ac = new AbortController;
        streamAbort = ac;
        let idle = null;
        const touch = () => {
          if (idle)
            clearTimeout(idle);
          idle = setTimeout(() => ac.abort(), STREAM_IDLE_MS);
        };
        try {
          if (!b)
            throw new Error("no server");
          touch();
          const res = await deps.fetch(`${b}/mcp`, {
            method: "GET",
            headers: {
              ...headers(true),
              accept: "text/event-stream",
              ...lastEventId ? { "last-event-id": lastEventId } : {}
            },
            signal: ac.signal
          });
          if (res.status === 200 && res.body) {
            delay = 1000;
            await readEvents(res.body, gen, touch);
          } else {
            await res.text().catch(() => "");
            if ([400, 401, 403, 404].includes(res.status) && gen === streamGen) {
              if (res.status !== 404)
                token = null;
              dropSession();
              if (!await openUpstream())
                reconnectInBackground();
              return;
            }
          }
        } catch {} finally {
          if (idle)
            clearTimeout(idle);
        }
        if (closed || gen !== streamGen)
          return;
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    })();
  }
  async function readEvents(body, gen, touch) {
    const reader = body.getReader();
    const decoder = new TextDecoder;
    let buf = "";
    let data = [];
    let id = null;
    while (gen === streamGen) {
      const { done, value } = await reader.read();
      if (done)
        return;
      touch();
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf(`
`);
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf(`
`);
        if (line === "") {
          if (id !== null)
            lastEventId = id;
          if (data.length > 0 && gen === streamGen)
            deliver(data.join(`
`));
          data = [];
          id = null;
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).trimStart());
        else if (line.startsWith("id:"))
          id = line.slice(3).trim();
      }
    }
    await reader.cancel().catch(() => {});
  }
  function unavailable(msg, reason) {
    const id = msg.id ?? null;
    const result = (r) => JSON.stringify({ jsonrpc: "2.0", id, result: r });
    if (msg.method === "tools/list")
      return result({ tools: [] });
    if (msg.method === "ping")
      return result({});
    if (msg.method === "tools/call") {
      return result({
        content: [
          {
            type: "text",
            text: `claude-workspaces relay: ${reason}. It keeps retrying; call the tool again shortly.`
          }
        ],
        isError: true
      });
    }
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: reason } });
  }
  function localInitialize(msg) {
    const params = isRecord(msg.params) ? msg.params : {};
    const asked = params.protocolVersion;
    return JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        protocolVersion: typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: true }, experimental: { "claude/channel": {} } },
        serverInfo: { name: "claude-workspaces", version },
        instructions: `The claude-workspaces server did not answer when this session started (${lastReason}). Its tools appear here once it does.`
      }
    });
  }
  async function onInitialize(msg, line) {
    initRequest = line;
    const deadline = Date.now() + (deps.initWaitMs ?? DEFAULT_INIT_WAIT_MS);
    let delay = 250;
    for (;; ) {
      if (await openUpstream()) {
        deps.write(initAnswer.trim());
        return;
      }
      if (Date.now() + delay > deadline)
        break;
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
    deps.log(`[relay] answering initialize locally: ${lastReason}`);
    deps.write(localInitialize(msg));
    reconnectInBackground();
  }
  async function forward(msg, line) {
    const wantsAnswer = typeof msg.method === "string" && msg.id !== undefined;
    for (let attempt = 0;attempt < 3; attempt++) {
      if (sid === null && !await openUpstream())
        break;
      const r = await post(line, true);
      if (r.kind === "unreachable") {
        if (r.mayHaveRun) {
          const reason = "the connection to the claude-workspaces server dropped mid-request, so the call may or may not have run";
          return wantsAnswer ? unavailable(msg, reason) : null;
        }
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (r.status === 404 || (r.status === 401 || r.status === 403) && named) {
        if (r.status !== 404)
          token = null;
        dropSession();
        continue;
      }
      if (r.status === 202 || r.body.trim() === "")
        return null;
      const j = parse(r.body);
      if (isRecord(j) && j.jsonrpc === "2.0")
        return JSON.stringify(j);
      if (Array.isArray(j))
        return JSON.stringify(j);
      return wantsAnswer ? unavailable(msg, refusalText(r.status, r.body)) : null;
    }
    if (sid === null)
      reconnectInBackground();
    return wantsAnswer ? unavailable(msg, lastReason) : null;
  }
  async function handle(line) {
    const msg = parse(line);
    if (!isRecord(msg)) {
      if (Array.isArray(msg)) {
        const answer = await forward({}, line);
        if (answer)
          deps.write(answer);
      } else {
        deps.write(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        }));
      }
      return;
    }
    if (msg.method === "initialize")
      return onInitialize(msg, line);
    if (msg.method === "notifications/initialized") {
      clientInitialized = true;
      if (sid !== null) {
        await post(line, true);
        startStream();
      }
      return;
    }
    const isCall = msg.method === "tools/call";
    if (isCall)
      toolCalls += 1;
    try {
      const answer = await forward(msg, line);
      if (answer !== null)
        deps.write(answer);
    } finally {
      if (isCall) {
        toolCalls -= 1;
        flushHeld();
      }
    }
  }
  return {
    receive(line) {
      if (line.trim() === "")
        return;
      handle(line).catch((e) => deps.log("[relay] message failed:", e));
    },
    async close() {
      closed = true;
      stopStream();
      const b = base();
      if (sid === null || !b)
        return;
      const ac = new AbortController;
      const t = setTimeout(() => ac.abort(), 1000);
      try {
        await deps.fetch(`${b}/mcp`, {
          method: "DELETE",
          headers: headers(true),
          signal: ac.signal
        });
      } catch {} finally {
        clearTimeout(t);
      }
    }
  };
}

// packages/mcp/src/relay/unix-fetch.ts
import { request } from "node:http";
function unixSocketFetch(socketPath) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = init.body == null ? undefined : String(init.body);
    if (body !== undefined)
      headers["content-length"] = String(Buffer.byteLength(body));
    const req = request({
      socketPath,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? "GET",
      headers,
      ...init.signal ? { signal: init.signal } : {}
    }, (res) => resolve(toResponse(res)));
    req.on("error", reject);
    if (body !== undefined)
      req.write(body);
    req.end();
  });
}
function toResponse(res) {
  const headers = new Headers;
  for (const [name, value] of Object.entries(res.headers)) {
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const status = res.statusCode ?? 502;
  if (status === 204 || status === 304) {
    res.resume();
    return new Response(null, { status, headers });
  }
  let done = false;
  const body = new ReadableStream({
    start(controller) {
      res.on("data", (chunk) => {
        if (!done)
          controller.enqueue(new Uint8Array(chunk));
      });
      res.on("end", () => {
        if (done)
          return;
        done = true;
        controller.close();
      });
      res.on("close", () => {
        if (done)
          return;
        done = true;
        controller.error(new Error("the board socket closed the response"));
      });
    },
    cancel() {
      done = true;
      res.destroy();
    }
  });
  return new Response(body, { status, headers });
}

// packages/mcp/src/relay/main.ts
var boardSocket = process.env.CW_BOARD_SOCKET?.trim() || undefined;
var relay = createRelay({
  env: process.env,
  cwd: process.cwd(),
  homedir,
  existsSync,
  readFileSync: readDiscoveryText,
  fetch: boardSocket ? unixSocketFetch(boardSocket) : (url, init) => fetch(url, init),
  ...boardSocket ? { boardSocket } : {},
  write: (line) => {
    process.stdout.write(`${line}
`);
  },
  log: (...args) => console.error(...args),
  ...process.env.CW_RELAY_INIT_WAIT_MS !== undefined ? { initWaitMs: Number(process.env.CW_RELAY_INIT_WAIT_MS) || 0 } : {}
});
console.error(`[relay] node relay started${boardSocket ? " on a board socket" : ""}`);
var buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf(`
`);
  while (nl >= 0) {
    relay.receive(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    nl = buf.indexOf(`
`);
  }
});
process.stdin.on("end", () => {
  if (buf.trim() !== "")
    relay.receive(buf);
  relay.close().finally(() => process.exit(0));
});
