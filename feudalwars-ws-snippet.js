(() => {
  const target = "wss://eu1.feudalwars.net/?client=v2&protocolVersion=2&engine=phaser3&playerName=BrewBear&loggedIn=true&loadDom=true&isPing=false&roomFeed=false&supportsRunningGameRejoin=true&supportsV2MoveEcho=true&sessionID=null";
  const NativeWebSocket = window.WebSocket;
  const sockets = [];
  const frames = [];
  let nextSocketId = 1;

  const startedAt = new Date().toISOString();

  function shouldCapture(url) {
    return String(url).startsWith(target);
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
      ? [...text].filter((char) => char === "\n" || char === "\r" || char === "\t" || (char >= " " && char !== "\uFFFD")).length / text.length
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
})();