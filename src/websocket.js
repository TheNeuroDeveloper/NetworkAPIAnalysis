import fs from "node:fs/promises";
import zlib from "node:zlib";

const DEFAULT_TARGET = "wss://eu1.feudalwars.net";

export function renderWebSocketSnippet(target = DEFAULT_TARGET) {
  return `(() => {
  const target = ${JSON.stringify(target)};
  const NativeWebSocket = window.WebSocket;
  const sockets = [];
  const frames = [];
  let nextSocketId = 1;

  const startedAt = new Date().toISOString();

  function shouldCapture(url) {
    return target === "all" || String(url).startsWith(target);
  }

  function now() {
    return new Date().toISOString();
  }

  function toHex(bytes, limit = 96) {
    return Array.from(bytes.slice(0, limit))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  }

  function decodeText(text) {
    try {
      return { kind: "json", value: JSON.parse(text), text };
    } catch {
      return { kind: "text", value: text, text };
    }
  }

  async function decodePayload(payload) {
    if (typeof payload === "string") return decodeText(payload);

    let buffer;
    if (payload instanceof ArrayBuffer) {
      buffer = payload;
    } else if (ArrayBuffer.isView(payload)) {
      buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    } else if (payload instanceof Blob) {
      buffer = await payload.arrayBuffer();
    } else {
      return { kind: typeof payload, value: String(payload), text: String(payload) };
    }

    const bytes = new Uint8Array(buffer);
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {}

    const printableRatio = text
      ? [...text].filter((char) => char === "\\n" || char === "\\r" || char === "\\t" || (char >= " " && char !== "\\uFFFD")).length / text.length
      : 0;

    if (text && printableRatio > 0.85) {
      const decoded = decodeText(text);
      decoded.binary = { byteLength: bytes.byteLength, hexPreview: toHex(bytes) };
      return decoded;
    }

    return {
      kind: "binary",
      value: {
        byteLength: bytes.byteLength,
        hexPreview: toHex(bytes, 160),
        bytesPreview: Array.from(bytes.slice(0, 160))
      },
      binary: { byteLength: bytes.byteLength, hexPreview: toHex(bytes, 160) }
    };
  }

  async function record(socketMeta, direction, payload) {
    const decoded = await decodePayload(payload);
    frames.push({
      index: frames.length,
      timestamp: now(),
      direction,
      socketId: socketMeta.id,
      url: socketMeta.url,
      readyState: socketMeta.instance.readyState,
      payloadKind: decoded.kind,
      byteLength: decoded.binary?.byteLength ?? decoded.text?.length ?? 0,
      text: decoded.text,
      data: decoded.value,
      binary: decoded.binary
    });
  }

  function CapturingWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);

    if (!shouldCapture(url)) return socket;

    const socketMeta = {
      id: nextSocketId++,
      url: String(url),
      protocols,
      createdAt: now(),
      instance: socket
    };
    sockets.push(socketMeta);

    socket.addEventListener("open", () => {
      frames.push({ index: frames.length, timestamp: now(), direction: "meta", socketId: socketMeta.id, url: socketMeta.url, event: "open" });
    });
    socket.addEventListener("close", (event) => {
      frames.push({ index: frames.length, timestamp: now(), direction: "meta", socketId: socketMeta.id, url: socketMeta.url, event: "close", code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
    socket.addEventListener("error", () => {
      frames.push({ index: frames.length, timestamp: now(), direction: "meta", socketId: socketMeta.id, url: socketMeta.url, event: "error" });
    });
    socket.addEventListener("message", (event) => {
      record(socketMeta, "in", event.data);
    });

    const nativeSend = socket.send.bind(socket);
    socket.send = (payload) => {
      record(socketMeta, "out", payload);
      return nativeSend(payload);
    };

    return socket;
  }

  CapturingWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  CapturingWebSocket.OPEN = NativeWebSocket.OPEN;
  CapturingWebSocket.CLOSING = NativeWebSocket.CLOSING;
  CapturingWebSocket.CLOSED = NativeWebSocket.CLOSED;
  CapturingWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(CapturingWebSocket, "name", { value: "WebSocket" });

  window.WebSocket = CapturingWebSocket;
  window.__wsCapture = {
    target,
    startedAt,
    sockets,
    frames,
    restore() {
      window.WebSocket = NativeWebSocket;
      return "Native WebSocket restored. Existing sockets are not closed.";
    },
    snapshot() {
      return {
        target,
        startedAt,
        exportedAt: now(),
        location: window.location.href,
        userAgent: navigator.userAgent,
        sockets: sockets.map(({ instance, ...socket }) => socket),
        frames: frames.slice()
      };
    },
    download(filename = "feudalwars-ws-capture.json") {
      const blob = new Blob([JSON.stringify(this.snapshot(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { filename, frames: frames.length, sockets: sockets.length };
    }
  };

  console.log("[ws-capture] Installed for", target);
  console.log("[ws-capture] Use __wsCapture.download() to save frames.");
})();`;
}

export async function writeWebSocketSnippet(file, target = DEFAULT_TARGET) {
  await fs.writeFile(file, renderWebSocketSnippet(target), "utf8");
}

export async function readWebSocketCapture(file) {
  const text = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return { frames: parsed, sockets: [] };
  return {
    ...parsed,
    frames: parsed.frames ?? [],
    sockets: parsed.sockets ?? []
  };
}

export async function writeWebSocketReport(file, capture) {
  await fs.writeFile(file, renderWebSocketReport(capture), "utf8");
}

export function createWebSocketCapture({ target = DEFAULT_TARGET, pageUrl = undefined } = {}) {
  return {
    target,
    startedAt: new Date().toISOString(),
    exportedAt: undefined,
    location: pageUrl,
    sockets: [],
    frames: []
  };
}

export function handleCdpWebSocketEvent(capture, message) {
  const { method, params } = message;
  if (!params?.requestId) return;

  if (method === "Network.webSocketCreated") {
    if (!shouldCaptureSocket(capture.target, params.url)) return;
    capture.sockets.push({
      id: params.requestId,
      requestId: params.requestId,
      url: params.url,
      createdAt: nowIso(),
      initiator: params.initiator
    });
    capture.frames.push(metaFrame(capture, params.requestId, "created", { url: params.url }));
    return;
  }

  const socket = capture.sockets.find((item) => item.requestId === params.requestId);
  if (!socket) return;

  if (method === "Network.webSocketWillSendHandshakeRequest") {
    socket.requestHeaders = params.request?.headers;
    capture.frames.push(metaFrame(capture, params.requestId, "handshake-request", {
      headers: params.request?.headers
    }));
    return;
  }

  if (method === "Network.webSocketHandshakeResponseReceived") {
    socket.status = params.response?.status;
    socket.statusText = params.response?.statusText;
    socket.responseHeaders = params.response?.headers;
    capture.frames.push(metaFrame(capture, params.requestId, "handshake-response", {
      status: params.response?.status,
      statusText: params.response?.statusText,
      headers: params.response?.headers
    }));
    return;
  }

  if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
    const direction = method === "Network.webSocketFrameSent" ? "out" : "in";
    capture.frames.push(cdpMessageFrame(capture, socket, direction, params.response));
    return;
  }

  if (method === "Network.webSocketFrameError") {
    capture.frames.push(metaFrame(capture, params.requestId, "frame-error", {
      errorMessage: params.errorMessage
    }));
    return;
  }

  if (method === "Network.webSocketClosed") {
    socket.closedAt = nowIso();
    capture.frames.push(metaFrame(capture, params.requestId, "closed"));
  }
}

export async function writeWebSocketCapture(file, capture) {
  capture.exportedAt = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify(capture, null, 2), "utf8");
}

export function renderWebSocketReport(capture) {
  const frames = (capture.frames ?? []).map(normalizeWebSocketFrame);
  const messageFrames = frames.filter((frame) => frame.direction === "in" || frame.direction === "out");
  const groups = groupFrames(messageFrames);
  const lines = [
    "# WebSocket Command Breakdown",
    "",
    `Target: ${capture.target ?? "unknown"}`,
    `Page: ${capture.location ?? "unknown"}`,
    `Captured frames: ${frames.length}`,
    `Message frames: ${messageFrames.length}`,
    `Sockets: ${(capture.sockets ?? []).length}`,
    `Grouped commands: ${groups.length}`,
    "",
    "## Socket Summary",
    ""
  ];

  for (const socket of capture.sockets ?? []) {
    lines.push(`- Socket ${socket.id}: ${socket.url} created ${socket.createdAt}`);
  }

  lines.push("");
  lines.push("## Command Summary");
  lines.push("");

  for (const group of groups) {
    lines.push(`- ${group.key}: ${group.frames.length}`);
  }

  lines.push("");
  lines.push("## Command Details");
  lines.push("");

  for (const group of groups) {
    const sample = chooseFrameSample(group.frames);
    const sizes = group.frames.map((frame) => frame.byteLength).filter((size) => typeof size === "number");
    lines.push(`### ${group.key}`);
    lines.push("");
    lines.push(`- Count: ${group.frames.length}`);
    lines.push(`- Direction: ${sample.direction}`);
    lines.push(`- Payload kind: ${sample.payloadKind}`);
    if (sizes.length) {
      lines.push(`- Size: min ${Math.min(...sizes)} bytes, avg ${avg(sizes)} bytes, max ${Math.max(...sizes)} bytes`);
    }
    const shape = describeShape(sample.data);
    if (shape) lines.push(`- Shape: ${shape}`);
    lines.push(`- First seen: ${group.frames[0].timestamp}`);
    lines.push(`- Last seen: ${group.frames[group.frames.length - 1].timestamp}`);
    lines.push("- Sample:");
    lines.push("```json");
    lines.push(JSON.stringify(summarizeFrame(sample), null, 2).slice(0, 10000));
    lines.push("```");
    lines.push("");
  }

  lines.push("## Timeline");
  lines.push("");
  for (const frame of frames) {
    if (frame.direction === "meta") {
      lines.push(`- ${frame.timestamp} socket ${frame.socketId} ${frame.event}${frame.code ? ` code=${frame.code}` : ""}`);
    } else {
      lines.push(`- ${frame.timestamp} ${frame.direction} socket ${frame.socketId} ${frameCommand(frame)} ${frame.byteLength ?? 0} bytes`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function groupFrames(frames) {
  const groups = new Map();
  for (const frame of frames) {
    const key = `${frame.direction} ${socketLabel(frame.url)} ${frameCommand(frame)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(frame);
  }
  return [...groups.entries()]
    .map(([key, groupedFrames]) => ({ key, frames: groupedFrames }))
    .sort((a, b) => b.frames.length - a.frames.length || a.key.localeCompare(b.key));
}

function shouldCaptureSocket(target, url) {
  return target === "all" || String(url).startsWith(target);
}

function socketLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "unknown-socket";
  }
}

function cdpMessageFrame(capture, socket, direction, frame) {
  const decoded = decodeCdpFrame(frame);
  return {
    index: capture.frames.length,
    timestamp: nowIso(),
    direction,
    socketId: socket.id,
    requestId: socket.requestId,
    url: socket.url,
    payloadKind: decoded.kind,
    opcode: frame?.opcode,
    mask: frame?.mask,
    byteLength: decoded.byteLength,
    text: decoded.text,
    data: decoded.value,
    binary: decoded.binary
  };
}

function decodeCdpFrame(frame = {}) {
  const payload = frame.payloadData ?? "";
  if (frame.opcode === 2) {
    const bytes = decodeBase64(payload);
    if (bytes) {
      const inflated = inflatePayload(bytes);
      if (inflated) {
        return {
          ...inflated,
          byteLength: bytes.length,
          binary: {
            byteLength: bytes.length,
            base64: payload,
            hexPreview: toHex(bytes, 160)
          }
        };
      }
      return {
        kind: "binary",
        byteLength: bytes.length,
        value: {
          byteLength: bytes.length,
          hexPreview: toHex(bytes, 160),
          bytesPreview: Array.from(bytes.slice(0, 160))
        },
        binary: {
          byteLength: bytes.length,
          base64: payload,
          hexPreview: toHex(bytes, 160)
        }
      };
    }
  }

  try {
    return {
      kind: "json",
      byteLength: payload.length,
      text: payload,
      value: JSON.parse(payload)
    };
  } catch {
    return {
      kind: "text",
      byteLength: payload.length,
      text: payload,
      value: payload
    };
  }
}

function normalizeWebSocketFrame(frame) {
  if (frame.direction !== "in" && frame.direction !== "out") return frame;
  if (frame.payloadKind !== "binary") return frame;

  const bytes = frame.binary?.base64
    ? decodeBase64(frame.binary.base64)
    : fullPreviewBytes(frame);
  if (!bytes) return frame;

  const inflated = inflatePayload(bytes);
  if (!inflated) return frame;

  return {
    ...frame,
    payloadKind: inflated.kind,
    text: inflated.text,
    data: inflated.value,
    compressed: {
      kind: "zlib",
      byteLength: bytes.length,
      hexPreview: toHex(bytes, 160),
      truncated: !frame.binary?.base64 && frame.data?.bytesPreview?.length < frame.byteLength
    }
  };
}

function inflatePayload(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x78) return undefined;
  try {
    const text = zlib.inflateSync(Buffer.from(bytes)).toString("utf8");
    try {
      return {
        kind: "zlib-json",
        text,
        value: JSON.parse(text)
      };
    } catch {
      return {
        kind: "zlib-text",
        text,
        value: text
      };
    }
  } catch {
    return undefined;
  }
}

function fullPreviewBytes(frame) {
  const preview = frame.data?.bytesPreview;
  if (!preview || preview.length < frame.byteLength) return undefined;
  return Buffer.from(preview);
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
}

function metaFrame(capture, requestId, event, extra = {}) {
  const socket = capture.sockets.find((item) => item.requestId === requestId);
  return {
    index: capture.frames.length,
    timestamp: nowIso(),
    direction: "meta",
    socketId: socket?.id ?? requestId,
    requestId,
    url: socket?.url ?? extra.url,
    event,
    ...extra
  };
}

function toHex(bytes, limit = 96) {
  return Array.from(bytes.slice(0, limit))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function nowIso() {
  return new Date().toISOString();
}

function frameCommand(frame) {
  const data = frame.data;
  if (frame.payloadKind === "binary") {
    const bytes = frame.data?.bytesPreview ?? [];
    if (bytes.length) return `binary:first-byte:${bytes[0]}`;
    return "binary";
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of ["n", "command", "cmd", "type", "event", "action", "op", "opcode", "route", "name", "method"]) {
      if (data[key] !== undefined) return `${key}:${String(data[key])}`;
    }
    const keys = Object.keys(data);
    return `object:{${keys.slice(0, 6).join(",")}}`;
  }
  if (Array.isArray(data)) {
    const first = data[0];
    if (typeof first === "string" || typeof first === "number") return `array[0]:${first}`;
    return `array:length:${data.length}`;
  }
  if (typeof data === "string") {
    const trimmed = data.trim();
    const firstToken = trimmed.split(/\s+/)[0]?.slice(0, 48);
    return firstToken ? `text:${firstToken}` : "text:empty";
  }
  return frame.payloadKind ?? "unknown";
}

function chooseFrameSample(frames) {
  return frames.find((frame) => frame.data && typeof frame.data === "object")
    ?? frames.find((frame) => frame.text)
    ?? frames[0];
}

function summarizeFrame(frame) {
  return {
    index: frame.index,
    timestamp: frame.timestamp,
    direction: frame.direction,
    socketId: frame.socketId,
    url: frame.url,
    payloadKind: frame.payloadKind,
    byteLength: frame.byteLength,
    command: frameCommand(frame),
    data: frame.data,
    text: frame.text,
    binary: frame.binary
  };
}

function describeShape(value) {
  if (Array.isArray(value)) return `array length ${value.length}`;
  if (value && typeof value === "object") {
    return `object keys: ${Object.keys(value).slice(0, 30).join(", ")}`;
  }
  if (typeof value === "string") return `text length ${value.length}`;
  return undefined;
}

function avg(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
