# Network Tab API Breakdown

A local Chrome DevTools Protocol recorder for reverse-engineering API traffic from one website/webapp tab.

It launches Chrome with remote debugging enabled, opens the URL you provide, listens only to that tab, captures request/response metadata and response bodies when Chrome allows it, then writes:

- `capture.jsonl`: one JSON object per request
- `report.md`: a grouped API breakdown by method/path/status/content type

## Quick Start

```bash
npm run capture -- --url https://example.com --duration 60
```

Interact with the opened browser tab while the timer runs. Log in, click around, submit forms, change filters, and use the app naturally.

Outputs are written to `./captures/<timestamp>/` by default.

## Useful Options

```bash
npm run capture -- \
  --url https://example.com/app \
  --duration 120 \
  --include example.com \
  --include api.example.com \
  --body-limit 250000
```

- `--url`: page to open and capture.
- `--duration`: seconds to record. Use `0` to keep recording until you press `Ctrl+C`.
- `--include`: host or regex filter. Can be repeated. If omitted, all hosts are captured.
- `--exclude`: host or regex filter. Can be repeated.
- `--out`: output directory.
- `--body-limit`: max response body characters saved per request.
- `--chrome`: explicit Brave/Chrome/Chromium executable path. By default the tool prefers Brave on macOS, then Chrome/Chromium.
- `--keep-profile`: keep the temporary Chrome profile after capture.
- `--port`: remote debugging port, default `9222`.

## Summarize An Existing Capture

```bash
npm run summarize -- --input ./captures/2026-05-16T10-20-00-000Z/capture.jsonl
```

## What This Is Good For

- Mapping which endpoints a webapp calls during specific workflows.
- Finding request headers, payload shapes, query params, response shapes, status codes, and timing.
- Building a first-pass API inventory before writing deeper probes or clients.

## Important Notes

- Only inspect traffic you are authorized to inspect.
- Secrets can appear in captures. Treat output files as sensitive.
- Chrome may refuse response bodies for some responses, redirects, cached resources, preflights, or very large/streamed payloads.
- This is not a TLS proxy. It observes the browser tab via DevTools, which is often enough for modern webapp API discovery.
