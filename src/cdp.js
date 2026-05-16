import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools")), 10000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });

    this.socket.addEventListener("message", (event) => this.#onMessage(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });

    this.socket.send(JSON.stringify(message));
    return promise;
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.socket?.close();
  }

  #onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      for (const handler of this.handlers) handler(message);
    }
  }
}

export async function getBrowserWebSocketUrl(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const data = await httpGetJson(endpoint);
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Chrome did not expose DevTools at ${endpoint}`);
}

export function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`Timed out reading ${url}`));
    });
  });
}
