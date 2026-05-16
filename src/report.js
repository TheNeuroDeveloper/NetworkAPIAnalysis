import fs from "node:fs/promises";

const TEXT_TYPES = [
  "application/json",
  "application/problem+json",
  "application/graphql-response+json",
  "text/",
  "application/x-www-form-urlencoded"
];

export async function readCapture(file) {
  const text = await fs.readFile(file, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function writeReport(file, records) {
  const report = renderReport(records);
  await fs.writeFile(file, report, "utf8");
}

export async function writeApiReport(file, records) {
  const report = renderApiReport(records);
  await fs.writeFile(file, report, "utf8");
}

export function renderReport(records) {
  const apiRecords = records
    .filter((record) => record.url && record.method)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  const groups = new Map();
  for (const record of apiRecords) {
    const url = safeUrl(record.url);
    const key = [
      record.method,
      url?.origin ?? "unknown-origin",
      normalizePath(url?.pathname ?? record.url),
      record.status ?? "no-status"
    ].join(" ");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const lines = [
    "# API Breakdown",
    "",
    `Captured requests: ${records.length}`,
    `Grouped endpoints: ${groups.size}`,
    "",
    "## Endpoint Summary",
    ""
  ];

  for (const [key, group] of groups.entries()) {
    const sample = group[0];
    const url = safeUrl(sample.url);
    const durations = group.map((record) => record.durationMs).filter((value) => typeof value === "number");
    const contentTypes = unique(group.map((record) => record.contentType).filter(Boolean));
    const statuses = unique(group.map((record) => record.status).filter(Boolean));

    lines.push(`### ${key}`);
    lines.push("");
    lines.push(`- Count: ${group.length}`);
    lines.push(`- URL: \`${sample.url}\``);
    lines.push(`- Statuses: ${statuses.length ? statuses.join(", ") : "unknown"}`);
    lines.push(`- Content types: ${contentTypes.length ? contentTypes.join(", ") : "unknown"}`);
    if (durations.length) {
      lines.push(`- Duration: min ${Math.min(...durations)} ms, avg ${avg(durations)} ms, max ${Math.max(...durations)} ms`);
    }
    lines.push(`- Inferred purpose: ${inferPurpose(sample, url)}`);

    const query = Object.fromEntries(url?.searchParams.entries() ?? []);
    if (Object.keys(query).length) {
      lines.push("- Query params:");
      lines.push("```json");
      lines.push(JSON.stringify(query, null, 2));
      lines.push("```");
    }

    const requestSample = parseMaybeJson(sample.requestPostData);
    if (requestSample !== undefined) {
      lines.push("- Request body sample:");
      lines.push("```json");
      lines.push(JSON.stringify(requestSample, null, 2));
      lines.push("```");
    }

    const responseSample = sample.responseBody && isTextType(sample.contentType)
      ? parseMaybeJson(sample.responseBody)
      : undefined;
    if (responseSample !== undefined) {
      lines.push("- Response body sample:");
      lines.push("```json");
      lines.push(JSON.stringify(responseSample, null, 2).slice(0, 5000));
      lines.push("```");
    }

    lines.push("");
  }

  lines.push("## Raw Workflow Timeline");
  lines.push("");
  for (const record of apiRecords) {
    lines.push(`- ${record.startedAt ?? "unknown-time"} ${record.method} ${record.status ?? "-"} ${record.url}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function renderApiReport(records) {
  const apiRecords = records
    .filter(isApiRecord)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const skipped = records.length - apiRecords.length;
  const groups = groupRecords(apiRecords);
  const hostCounts = countBy(apiRecords, (record) => safeUrl(record.url)?.host ?? "unknown-host");
  const operationCounts = countBy(apiRecords, (record) => describeOperation(record).operation ?? "unknown");

  const lines = [
    "# API-Only Breakdown",
    "",
    `Captured requests: ${records.length}`,
    `API-like requests: ${apiRecords.length}`,
    `Skipped static/media/preflight requests: ${skipped}`,
    `Grouped API endpoints: ${groups.length}`,
    "",
    "## Host Summary",
    ""
  ];

  for (const [host, count] of topEntries(hostCounts, 20)) {
    lines.push(`- ${host}: ${count}`);
  }

  lines.push("");
  lines.push("## Operation Summary");
  lines.push("");

  for (const [operation, count] of topEntries(operationCounts, 50)) {
    lines.push(`- ${operation}: ${count}`);
  }

  lines.push("");
  lines.push("## Endpoint Details");
  lines.push("");

  for (const group of groups) {
    const sample = chooseSample(group.records);
    const url = safeUrl(sample.url);
    const operation = describeOperation(sample);
    const durations = group.records.map((record) => record.durationMs).filter((value) => typeof value === "number");
    const statuses = countBy(group.records, (record) => String(record.status ?? "no-status"));
    const contentTypes = countBy(group.records, (record) => record.contentType || record.mimeType || "unknown");
    const query = decodeQuery(url);
    const requestBody = parseBody(sample.requestPostData, sample.requestHeaders);
    const responseBody = sample.responseBody && isTextType(sample.contentType)
      ? parseMaybeJson(sample.responseBody)
      : undefined;
    const responseKeys = collectObjectKeys(responseBody);

    lines.push(`### ${group.key}`);
    lines.push("");
    lines.push(`- Count: ${group.records.length}`);
    lines.push(`- Operation: ${operation.operation}`);
    lines.push(`- Kind: ${operation.kind}`);
    lines.push(`- Purpose: ${inferPurpose(sample, url)}`);
    lines.push(`- Sample URL: \`${sample.url}\``);
    lines.push(`- Statuses: ${formatCounts(statuses)}`);
    lines.push(`- Content types: ${formatCounts(contentTypes)}`);
    if (durations.length) {
      lines.push(`- Duration: min ${Math.min(...durations)} ms, avg ${avg(durations)} ms, max ${Math.max(...durations)} ms`);
    }
    if (responseKeys.length) {
      lines.push(`- Response keys: ${responseKeys.join(", ")}`);
    }

    const headers = sample.requestHeaders;
    if (headers && Object.keys(headers).length) {
      lines.push("- Request headers:");
      lines.push("```json");
      lines.push(JSON.stringify(headers, null, 2));
      lines.push("```");
    }

    if (Object.keys(query).length) {
      lines.push("- Decoded query:");
      lines.push("```json");
      lines.push(JSON.stringify(query, null, 2));
      lines.push("```");
    }

    if (requestBody !== undefined) {
      lines.push("- Decoded request body:");
      lines.push("```json");
      lines.push(JSON.stringify(requestBody, null, 2).slice(0, 8000));
      lines.push("```");
    }

    if (responseBody !== undefined) {
      lines.push("- Response body sample:");
      lines.push("```json");
      lines.push(JSON.stringify(responseBody, null, 2).slice(0, 8000));
      lines.push("```");
    }

    lines.push("");
  }

  lines.push("## API Timeline");
  lines.push("");
  for (const record of apiRecords) {
    const operation = describeOperation(record);
    lines.push(`- ${record.startedAt ?? "unknown-time"} ${record.method} ${record.status ?? "-"} ${operation.operation} ${record.url}`);
  }
  lines.push("");

  return lines.join("\n");
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isApiRecord(record) {
  if (!record.url || !record.method) return false;
  if (record.method === "OPTIONS") return false;
  if (record.type && !["XHR", "Fetch"].includes(record.type)) return false;

  const url = safeUrl(record.url);
  if (!url) return false;

  const contentType = record.contentType || record.mimeType || "";
  if (isKnownAssetHost(url) && !url.pathname.includes("/api/") && !url.pathname.includes("/graphql")) return false;
  if (isStaticOrMedia(url, contentType)) return false;
  if (isTextType(contentType)) return true;
  if (url.pathname.includes("/api/")) return true;
  if (url.pathname.includes("/graphql")) return true;
  return ["POST", "PUT", "PATCH", "DELETE"].includes(record.method);
}

function isKnownAssetHost(url) {
  return [
    "abs.twimg.com",
    "pbs.twimg.com",
    "video.twimg.com"
  ].includes(url.host);
}

function isStaticOrMedia(url, contentType) {
  const pathname = url.pathname.toLowerCase();
  const staticExtensions = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|m4s|m3u8|mov|webm|mp3|wasm)$/;
  if (staticExtensions.test(pathname)) return true;
  return [
    "image/",
    "video/",
    "audio/",
    "font/",
    "application/font-",
    "application/javascript",
    "text/javascript",
    "text/css",
    "application/x-mpegurl"
  ].some((type) => contentType.toLowerCase().includes(type));
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const url = safeUrl(record.url);
    const operation = describeOperation(record);
    const key = [
      record.method,
      url?.host ?? "unknown-host",
      normalizePath(url?.pathname ?? record.url),
      record.status ?? "no-status"
    ].join(" ");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()]
    .map(([key, groupedRecords]) => ({ key, records: groupedRecords }))
    .sort((a, b) => b.records.length - a.records.length || a.key.localeCompare(b.key));
}

function describeOperation(record) {
  const url = safeUrl(record.url);
  const pathname = url?.pathname ?? "";
  const parts = pathname.split("/").filter(Boolean);
  const graphqlIndex = parts.indexOf("graphql");
  if (pathname.endsWith("/user_flow.json")) {
    return {
      kind: "Client analytics",
      operation: "user_flow"
    };
  }

  if (graphqlIndex !== -1 && parts[graphqlIndex + 2]) {
    const hash = parts[graphqlIndex + 1];
    const operationName = parts[graphqlIndex + 2];
    return {
      kind: "GraphQL",
      operation: operationName,
      queryId: hash && operationName ? hash : undefined
    };
  }

  if (pathname.includes("/live_pipeline/events")) {
    return { kind: "SSE", operation: "live_pipeline/events" };
  }

  return {
    kind: "REST-ish",
    operation: normalizePath(pathname)
  };
}

function decodeQuery(url) {
  if (!url) return {};
  const result = {};
  for (const [key, value] of url.searchParams.entries()) {
    result[key] = parseMaybeJson(value);
  }
  return result;
}

function parseBody(value, headers = {}) {
  if (!value) return undefined;
  const contentType = getHeader(headers, "content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || value.includes("=")) {
    const params = new URLSearchParams(value);
    const decoded = {};
    for (const [key, paramValue] of params.entries()) {
      decoded[key] = parseMaybeJson(paramValue);
    }
    return Object.keys(decoded).length ? decoded : value;
  }
  return parseMaybeJson(value);
}

function chooseSample(records) {
  return records.find((record) => record.responseBody && record.requestPostData)
    ?? records.find((record) => record.responseBody)
    ?? records.find((record) => record.requestPostData)
    ?? records[0];
}

function countBy(records, keyFn) {
  const counts = new Map();
  for (const record of records) {
    const key = keyFn(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function topEntries(counts, limit) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);
}

function formatCounts(counts) {
  return topEntries(counts, 20)
    .map(([key, count]) => `${key} (${count})`)
    .join(", ");
}

function collectObjectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 30);
}

function getHeader(headers, name) {
  const lowerName = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return found?.[1];
}

function normalizePath(pathname) {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/\b\d{4,}\b/g, ":id");
}

function parseMaybeJson(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
  }
}

function isTextType(contentType = "") {
  return TEXT_TYPES.some((type) => contentType.includes(type));
}

function unique(values) {
  return [...new Set(values)];
}

function avg(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function inferPurpose(record, url) {
  const method = record.method ?? "";
  const path = url?.pathname.toLowerCase() ?? "";
  if (method === "GET" && path.match(/\/(me|profile|account|session|user)s?\b/)) return "Reads current user/account/session state.";
  if (method === "GET" && path.match(/\/(search|query|lookup)\b/)) return "Searches or looks up records.";
  if (method === "GET") return "Reads data or configuration.";
  if (method === "POST" && path.match(/\/(login|auth|token|session)\b/)) return "Creates or refreshes authentication/session state.";
  if (method === "POST") return "Creates data, triggers an action, or runs a query/mutation.";
  if (method === "PUT" || method === "PATCH") return "Updates an existing resource.";
  if (method === "DELETE") return "Deletes or deactivates a resource.";
  return "Needs manual review.";
}
