import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const SUPPORTED_RULES = new Set(["farm-zero-cost", "free-buildings", "free-ruleset"]);

export function startFeudalWarsProxy({
  port = 8787,
  upstreamDefaultHost = "eu1.feudalwars.net",
  rule = "farm-zero-cost"
} = {}) {
  if (!SUPPORTED_RULES.has(rule)) {
    throw new Error(`Unsupported proxy mutation rule ${rule}`);
  }

  const logs = [];
  const server = http.createServer();

  server.on("upgrade", (request, socket) => {
    const startedAt = new Date().toISOString();
    const upstreamUrl = upstreamFromRequest(request, upstreamDefaultHost);
    const clientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    logs.push({ timestamp: startedAt, clientId, event: "client-upgrade", upstreamUrl });

    try {
      acceptClient(request, socket);
    } catch (error) {
      logs.push({ timestamp: nowIso(), clientId, event: "client-upgrade-error", error: error.message });
      socket.destroy();
      return;
    }

    const upstream = new WebSocket(upstreamUrl);
    upstream.binaryType = "arraybuffer";
    const pendingToUpstream = [];

    const clientParser = createFrameParser({
      onFrame(frame) {
        if (frame.opcode === 8) {
          upstream.close();
          socket.end(encodeFrame({ opcode: 8, payload: frame.payload }));
          return;
        }
        if (frame.opcode === 9) {
          socket.write(encodeFrame({ opcode: 10, payload: frame.payload }));
          return;
        }
        if (frame.opcode === 10) return;
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(frame.payload);
        } else {
          pendingToUpstream.push(frame.payload);
        }
        logs.push(frameLog(clientId, upstreamUrl, "out", frame.payload));
      },
      onError(error) {
        logs.push({ timestamp: nowIso(), clientId, event: "client-frame-error", error: error.message });
      }
    });

    socket.on("data", (chunk) => clientParser.push(chunk));
    socket.on("error", (error) => {
      logs.push({ timestamp: nowIso(), clientId, event: "client-error", error: error.message });
    });
    socket.on("close", () => {
      logs.push({ timestamp: nowIso(), clientId, event: "client-close" });
      upstream.close();
    });

    upstream.addEventListener("open", () => {
      logs.push({ timestamp: nowIso(), clientId, event: "upstream-open", upstreamUrl });
      for (const payload of pendingToUpstream.splice(0)) {
        upstream.send(payload);
      }
    });
    upstream.addEventListener("message", (event) => {
      const original = Buffer.from(event.data);
      const mutation = mutateFeudalWarsPayload(original, rule);
      const payload = mutation.payload;
      if (mutation.changed) {
        logs.push({
          timestamp: nowIso(),
          clientId,
          upstreamUrl,
          direction: "in",
          command: mutation.command,
          mutation: rule,
          summary: mutation.summary,
          before: mutation.before,
          after: mutation.after
        });
      } else {
        logs.push(frameLog(clientId, upstreamUrl, "in", original));
      }
      socket.write(encodeFrame({ opcode: 2, payload }));
    });
    upstream.addEventListener("error", () => {
      logs.push({ timestamp: nowIso(), clientId, event: "upstream-error", upstreamUrl });
    });
    upstream.addEventListener("close", (event) => {
      logs.push({
        timestamp: nowIso(),
        clientId,
        event: "upstream-close",
        upstreamUrl,
        code: event.code,
        reason: event.reason
      });
      socket.end(encodeFrame({ opcode: 8, payload: Buffer.alloc(0) }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port,
        logs,
        close: () => new Promise((resolveClose) => server.close(resolveClose))
      });
    });
  });
}

export function startFarmZeroCostProxy(options = {}) {
  return startFeudalWarsProxy({ ...options, rule: "farm-zero-cost" });
}

export function renderProxyRedirectScript({ port = 8787, target = "all" } = {}) {
  return `(() => {
  const NativeWebSocket = window.WebSocket;
  const proxyPort = ${Number(port)};
  const target = ${JSON.stringify(target)};

  function shouldProxy(url) {
    return String(url).startsWith("wss://") && (target === "all" || String(url).startsWith(target));
  }

  function proxiedUrl(url) {
    const original = new URL(String(url));
    const proxy = new URL("ws://127.0.0.1:" + proxyPort + original.pathname + original.search);
    proxy.searchParams.set("__fw_proxy_host", original.host);
    return proxy.toString();
  }

  function ProxyWebSocket(url, protocols) {
    const finalUrl = shouldProxy(url) ? proxiedUrl(url) : url;
    if (finalUrl !== url) console.log("[ws-proxy] redirect", String(url), "=>", finalUrl);
    return protocols === undefined
      ? new NativeWebSocket(finalUrl)
      : new NativeWebSocket(finalUrl, protocols);
  }

  ProxyWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  ProxyWebSocket.OPEN = NativeWebSocket.OPEN;
  ProxyWebSocket.CLOSING = NativeWebSocket.CLOSING;
  ProxyWebSocket.CLOSED = NativeWebSocket.CLOSED;
  ProxyWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(ProxyWebSocket, "name", { value: "WebSocket" });
  window.WebSocket = ProxyWebSocket;
  window.__wsProxyRedirect = { target, proxyPort };
  console.log("[ws-proxy] Installed redirect for", target, "via", proxyPort);
})();`;
}

function acceptClient(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) throw new Error("Missing Sec-WebSocket-Key");
  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));
}

function upstreamFromRequest(request, defaultHost) {
  const url = new URL(request.url, "ws://127.0.0.1");
  const host = url.searchParams.get("__fw_proxy_host") ?? defaultHost;
  url.searchParams.delete("__fw_proxy_host");
  return `wss://${host}${url.pathname}${url.search}`;
}

function createFrameParser({ onFrame, onError }) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        try {
          const parsed = parseFrame(buffer);
          if (!parsed) return;
          buffer = buffer.slice(parsed.consumed);
          onFrame(parsed.frame);
        } catch (error) {
          onError(error);
          buffer = Buffer.alloc(0);
          return;
        }
      }
    }
  };
}

function parseFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Frame too large");
    length = Number(bigLength);
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return undefined;
  let payload = buffer.slice(offset, offset + length);
  if (masked) {
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  }

  return {
    consumed: offset + length,
    frame: { fin, opcode, payload }
  };
}

function encodeFrame({ opcode = 2, payload = Buffer.alloc(0) }) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function mutateFeudalWarsPayload(payload, rule) {
  const decoded = decodeZlibJson(payload);
  if (!decoded || decoded.n !== "match_ruleset" || !Array.isArray(decoded.params)) {
    return { changed: false, payload };
  }

  const ruleset = parseMaybeJson(decoded.params[0]);
  if (!ruleset || !Array.isArray(ruleset.buildings)) return { changed: false, payload };

  const mutation = mutateRuleset(ruleset, rule);
  if (!mutation.changed) return { changed: false, payload };

  decoded.params[0] = JSON.stringify(ruleset);

  return {
    changed: true,
    payload: zlib.deflateSync(Buffer.from(JSON.stringify(decoded), "utf8")),
    command: decoded.n,
    ...mutation
  };
}

function mutateRuleset(ruleset, rule) {
  if (rule === "farm-zero-cost") {
    const farm = ruleset.buildings.find((building) => building?.key === "farm");
    if (!farm) return { changed: false };

    const before = snapshotEntity(farm, ["cost"]);
    zeroCost(farm);
    const after = snapshotEntity(farm, ["cost"]);
    return {
      changed: JSON.stringify(before) !== JSON.stringify(after),
      summary: { buildingsChanged: 1, unitsChanged: 0, fields: ["farm.cost"] },
      before,
      after
    };
  }

  if (rule === "free-buildings") {
    const before = ruleset.buildings.map((building) => snapshotEntity(building, ["key", "cost", "build_time_ms", "pop"]));
    for (const building of ruleset.buildings) {
      zeroCost(building);
      zeroNumberField(building, "build_time_ms");
      zeroNumberField(building, "pop");
    }
    const after = ruleset.buildings.map((building) => snapshotEntity(building, ["key", "cost", "build_time_ms", "pop"]));
    return {
      changed: JSON.stringify(before) !== JSON.stringify(after),
      summary: {
        buildingsChanged: countChanged(before, after),
        unitsChanged: 0,
        fields: ["buildings[].cost", "buildings[].build_time_ms", "buildings[].pop"]
      },
      before,
      after
    };
  }

  if (rule === "free-ruleset") {
    const units = Array.isArray(ruleset.units) ? ruleset.units : [];
    const before = {
      buildings: ruleset.buildings.map((building) => snapshotEntity(building, ["key", "cost", "build_time_ms", "pop"])),
      units: units.map((unit) => snapshotEntity(unit, ["key", "cost", "build_time_ms", "pop"]))
    };
    for (const building of ruleset.buildings) {
      zeroCost(building);
      zeroNumberField(building, "build_time_ms");
      zeroNumberField(building, "pop");
    }
    for (const unit of units) {
      zeroCost(unit);
      zeroNumberField(unit, "build_time_ms");
      zeroNumberField(unit, "pop");
    }
    const after = {
      buildings: ruleset.buildings.map((building) => snapshotEntity(building, ["key", "cost", "build_time_ms", "pop"])),
      units: units.map((unit) => snapshotEntity(unit, ["key", "cost", "build_time_ms", "pop"]))
    };
    return {
      changed: JSON.stringify(before) !== JSON.stringify(after),
      summary: {
        buildingsChanged: countChanged(before.buildings, after.buildings),
        unitsChanged: countChanged(before.units, after.units),
        fields: ["buildings[].cost", "buildings[].build_time_ms", "buildings[].pop", "units[].cost", "units[].build_time_ms", "units[].pop"]
      },
      before,
      after
    };
  }

  return { changed: false };
}

function zeroCost(entity) {
  if (!entity || typeof entity !== "object") return;
  entity.cost = { gold: 0, food: 0, lumber: 0, energy: 0 };
}

function zeroNumberField(entity, field) {
  if (!entity || typeof entity !== "object") return;
  if (typeof entity[field] === "number") entity[field] = 0;
}

function snapshotEntity(entity, fields) {
  const snapshot = {};
  for (const field of fields) {
    if (Object.hasOwn(entity, field)) snapshot[field] = entity[field];
  }
  return JSON.parse(JSON.stringify(snapshot));
}

function countChanged(before, after) {
  return before.reduce((count, item, index) => count + (JSON.stringify(item) === JSON.stringify(after[index]) ? 0 : 1), 0);
}

function decodeZlibJson(payload) {
  if (payload.length < 2 || payload[0] !== 0x78) return undefined;
  try {
    return JSON.parse(zlib.inflateSync(payload).toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function frameLog(clientId, upstreamUrl, direction, payload) {
  const decoded = decodeZlibJson(payload);
  return {
    timestamp: nowIso(),
    clientId,
    upstreamUrl,
    direction,
    byteLength: payload.length,
    command: decoded?.n,
    payloadKind: decoded ? "zlib-json" : "binary"
  };
}

function nowIso() {
  return new Date().toISOString();
}
