#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CdpClient, getBrowserWebSocketUrl } from "./cdp.js";
import { readCapture, writeReport } from "./report.js";

const DEFAULT_BODY_LIMIT = 200_000;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "capture") return capture(args);
  if (command === "summarize") return summarize(args);
  return help();
}

async function capture(args) {
  if (!args.url) throw new Error("Missing --url");

  const port = Number(args.port ?? 9222);
  const duration = Number(args.duration ?? 60);
  const bodyLimit = Number(args["body-limit"] ?? DEFAULT_BODY_LIMIT);
  const outDir = path.resolve(args.out ?? path.join("captures", safeStamp(new Date())));
  const profileDir = args["profile-dir"]
    ? path.resolve(args["profile-dir"])
    : await fs.mkdtemp(path.join(os.tmpdir(), "network-tab-profile-"));
  const include = toArray(args.include).map(makeMatcher);
  const exclude = toArray(args.exclude).map(makeMatcher);

  await fs.mkdir(outDir, { recursive: true });
  const captureFile = path.join(outDir, "capture.jsonl");
  const reportFile = path.join(outDir, "report.md");
  const metaFile = path.join(outDir, "meta.json");

  const chrome = launchChrome({
    executable: args.chrome,
    port,
    profileDir,
    url: "about:blank"
  });

  let client;
  const records = new Map();
  const writeQueue = [];
  const pendingBodies = new Set();
  let targetId;

  const cleanup = async () => {
    if (client && targetId) {
      await client.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    client?.close();
    chrome.kill("SIGTERM");
    if (!args["keep-profile"] && !args["profile-dir"]) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  process.once("SIGINT", async () => {
    console.log("\nStopping capture...");
    await finalize();
    await cleanup();
    process.exit(0);
  });

  try {
    const wsUrl = await getBrowserWebSocketUrl(port);
    client = new CdpClient(wsUrl);
    await client.connect();

    const target = await client.send("Target.createTarget", { url: "about:blank" });
    targetId = target.targetId;
    const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;

    client.onEvent((message) => {
      if (message.sessionId !== sessionId) return;
      handleNetworkEvent(message, records, {
        include,
        exclude,
        bodyLimit,
        getBody: (requestId) => client.send("Network.getResponseBody", { requestId }, sessionId),
        enqueue: (record) => writeQueue.push(record),
        pendingBodies
      });
    });

    await client.send("Page.enable", {}, sessionId);
    await client.send("Network.enable", { maxPostDataSize: bodyLimit }, sessionId);
    await client.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    await client.send("Page.navigate", { url: args.url }, sessionId);

    await fs.writeFile(metaFile, JSON.stringify({
      url: args.url,
      startedAt: new Date().toISOString(),
      include: toArray(args.include),
      exclude: toArray(args.exclude),
      bodyLimit,
      captureFile,
      reportFile
    }, null, 2), "utf8");

    console.log(`Capturing ${args.url}`);
    console.log(`Output: ${outDir}`);
    console.log(duration === 0 ? "Press Ctrl+C to stop." : `Recording for ${duration} seconds...`);

    if (duration === 0) {
      await once(process, "never");
    } else {
      await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    }

    await finalize();
  } finally {
    await cleanup();
  }

  async function finalize() {
    await Promise.allSettled([...pendingBodies]);
    for (const record of writeQueue.splice(0)) {
      await fs.appendFile(captureFile, `${JSON.stringify(record)}\n`, "utf8");
    }
    const captured = await readCapture(captureFile).catch(() => []);
    await writeReport(reportFile, captured);
    console.log(`Wrote ${captured.length} requests`);
    console.log(`Capture: ${captureFile}`);
    console.log(`Report: ${reportFile}`);
  }
}

async function summarize(args) {
  if (!args.input) throw new Error("Missing --input");
  const input = path.resolve(args.input);
  const out = path.resolve(args.out ?? path.join(path.dirname(input), "report.md"));
  const records = await readCapture(input);
  await writeReport(out, records);
  console.log(`Wrote ${out}`);
}

function handleNetworkEvent(message, records, options) {
  const { method, params } = message;

  if (method === "Network.requestWillBeSent") {
    const { requestId, request, timestamp, wallTime, type } = params;
    if (!shouldCapture(request.url, options.include, options.exclude)) return;
    records.set(requestId, {
      requestId,
      type,
      url: request.url,
      method: request.method,
      requestHeaders: request.headers,
      requestPostData: request.postData,
      startedAt: wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
      startedMonotonic: timestamp
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const record = records.get(params.requestId);
    if (!record) return;
    record.status = params.response.status;
    record.statusText = params.response.statusText;
    record.responseHeaders = params.response.headers;
    record.mimeType = params.response.mimeType;
    record.contentType = getHeader(params.response.headers, "content-type") ?? params.response.mimeType;
    record.remoteIPAddress = params.response.remoteIPAddress;
    record.remotePort = params.response.remotePort;
    record.protocol = params.response.protocol;
    record.fromDiskCache = params.response.fromDiskCache;
    record.fromServiceWorker = params.response.fromServiceWorker;
    return;
  }

  if (method === "Network.loadingFinished") {
    const record = records.get(params.requestId);
    if (!record) return;
    record.encodedDataLength = params.encodedDataLength;
    record.durationMs = Math.max(0, Math.round((params.timestamp - record.startedMonotonic) * 1000));
    records.delete(params.requestId);
    const bodyTask = captureBody(params.requestId, record, options)
      .finally(() => options.pendingBodies.delete(bodyTask));
    options.pendingBodies.add(bodyTask);
    return;
  }

  if (method === "Network.loadingFailed") {
    const record = records.get(params.requestId);
    if (!record) return;
    record.errorText = params.errorText;
    record.canceled = params.canceled;
    records.delete(params.requestId);
    options.enqueue(record);
  }
}

async function captureBody(requestId, record, options) {
  if (!isLikelyText(record.contentType)) {
    options.enqueue(record);
    return;
  }
  try {
    const body = await options.getBody(requestId);
    record.responseBodyBase64Encoded = body.base64Encoded;
    record.responseBody = body.base64Encoded
      ? `[base64 body omitted: ${body.body.length} chars]`
      : truncate(body.body, options.bodyLimit);
  } catch (error) {
    record.responseBodyError = error.message;
  }
  options.enqueue(record);
}

function launchChrome({ executable, port, profileDir, url }) {
  const chromePath = executable ?? findChrome();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    url
  ];
  const child = spawn(chromePath, args, { stdio: "ignore", detached: false });
  child.once("error", (error) => {
    throw error;
  });
  return child;
}

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "google-chrome";
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : argv[++index];
    if (args[key] === undefined) {
      args[key] = value;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
    } else {
      args[key] = [args[key], value];
    }
  }
  return args;
}

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function makeMatcher(pattern) {
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    return new RegExp(pattern.slice(1, -1));
  }
  return pattern;
}

function shouldCapture(url, include, exclude) {
  if (include.length && !include.some((matcher) => matches(url, matcher))) return false;
  if (exclude.some((matcher) => matches(url, matcher))) return false;
  return true;
}

function matches(url, matcher) {
  if (matcher instanceof RegExp) return matcher.test(url);
  return url.includes(matcher);
}

function getHeader(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function isLikelyText(contentType = "") {
  return [
    "application/json",
    "application/problem+json",
    "application/graphql",
    "text/",
    "application/x-www-form-urlencoded"
  ].some((type) => contentType.includes(type));
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function safeStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function help() {
  console.log(`Usage:
  npm run capture -- --url https://example.com --duration 60
  npm run summarize -- --input ./captures/<run>/capture.jsonl
`);
}
