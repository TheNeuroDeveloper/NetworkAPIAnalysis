# Network Tab API Breakdown

A local Chrome DevTools Protocol recorder for reverse-engineering API traffic from one website/webapp tab.

It launches Chrome with remote debugging enabled, opens the URL you provide, listens only to that tab, captures request/response metadata and response bodies when Chrome allows it, then writes:

- `capture.jsonl`: one JSON object per request
- `report.md`: a grouped API breakdown by method/path/status/content type
- `api-report.md`: a focused API-only report that filters static/media noise and decodes GraphQL/query/body payloads

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

This writes both `report.md` and `api-report.md` next to the capture unless you pass `--out` or `--api-out`.

## WebSocket Capture Snippet

For an authorized game/webapp pentest where you need to inspect a WebSocket before it is opened, generate a pasteable browser-console hook:

```bash
npm run ws:snippet -- --out ./feudalwars-ws-snippet.js
```

Paste the snippet in DevTools Console before the target code creates the WebSocket. By default it watches:

```text
wss://eu1.feudalwars.net
```

Use the app/game normally, then run this in the same console:

```js
__wsCapture.download()
```

That downloads `feudalwars-ws-capture.json`. Analyze it with:

```bash
npm run ws:analyze -- --input ~/Downloads/feudalwars-ws-capture.json
```

The analyzer writes `websocket-report.md` next to the capture and groups frames into likely commands by JSON fields, array command IDs, text prefixes, or binary first bytes.

If the WebSocket opens immediately on page load, launch the page through the DevTools Protocol recorder instead. It enables Network capture before navigation, so the initial handshake and first frames are included:

```bash
npm run ws:capture -- \
  --url https://game.example.test \
  --target "wss://eu1.feudalwars.net/?client=v2&protocolVersion=2&engine=phaser3&playerName=BrewBear&loggedIn=true&loadDom=true&isPing=false&roomFeed=false&supportsRunningGameRejoin=true&supportsV2MoveEcho=true&sessionID=null" \
  --duration 60
```

Use `--duration 0` to record until you press `Ctrl+C`. The command writes `websocket-capture.json` and `websocket-report.md` into `./captures/<timestamp>/`.

To capture every WebSocket opened by the page, use `--target all`:

```bash
npm run ws:capture -- \
  --url https://game.example.test \
  --target all \
  --duration 60
```

## WebSocket Mutation Test

For an authorized test room, `ws:mutate` can inject a narrow pre-load WebSocket mutator and record the run. The first supported rule changes inbound `match_ruleset` data before the game client sees it, setting the `farm` building cost to zero:

```bash
npm run ws:mutate -- \
  --url https://next.feudalwars.net \
  --target all \
  --rule farm-zero-cost \
  --duration 0
```

This writes:

- `websocket-capture.json`: wire traffic observed by DevTools
- `websocket-report.md`: decoded WebSocket command report
- `websocket-mutations.json`: in-page mutation log showing before/after values

This verifies whether the client reacts to a modified ruleset. It does not by itself prove the server accepts zero-cost farms; follow-up tests should check whether placement/training commands are accepted or corrected server-side.

## What This Is Good For

- Mapping which endpoints a webapp calls during specific workflows.
- Finding request headers, payload shapes, query params, response shapes, status codes, and timing.
- Separating real app API calls from scripts, images, fonts, videos, preflights, and other browser noise.
- Capturing and grouping WebSocket frames for command/protocol analysis.
- Building a first-pass API inventory before writing deeper probes or clients.

## Important Notes

- Only inspect traffic you are authorized to inspect.
- Secrets, cookies, and auth headers can appear in captures and reports. Treat output files as sensitive.
- Chrome may refuse response bodies for some responses, redirects, cached resources, preflights, or very large/streamed payloads.
- This is not a TLS proxy. It observes the browser tab via DevTools, which is often enough for modern webapp API discovery.
