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

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
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
