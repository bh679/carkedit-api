# CarkedItOnline — API

Multiplayer game server for CarkedItOnline, built with Node.js and Colyseus.

**[CarkedIt.com](https://carkedit.com)** | [Orchestrator Repo](https://github.com/bh679/CarkedIt) | [Client Repo](https://github.com/bh679/carkedit-client) | [Project Board](https://github.com/users/bh679/projects/10)

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Colyseus (multiplayer game server)

## Setup

```bash
npm install
npm run dev
```

## Environment Variables

Copy `.env.example` to `.env`:

| Variable | Description |
|---|---|
| `PORT` | Server port (default: `4501`) |
| `NODE_ENV` | `development` or `production` |
| `LOG_LEVEL` | pino log level (default: `info`) |
| `LOG_SLOW_WARN_MS` | Response time at which a request is logged at `warn` (default: `500`) |
| `LOG_SLOW_ERROR_MS` | Response time at which a request is logged at `error` (default: `2000`) |

## Logging

Every HTTP request emits one structured JSON line to stdout via [`pino-http`](https://github.com/pinojs/pino-http). pm2 captures these to `~/.pm2/logs/carkedit-api-out.log`.

Example line:

```json
{"level":30,"time":1715472000000,"pid":12345,"hostname":"prod-api","req":{"id":"d1f...","method":"GET","url":"/api/carkedit/health"},"res":{"statusCode":200,"bytes":42},"responseTime":3,"msg":"request completed"}
```

Fields:

- `level` — 30 info, 40 warn, 50 error
- `req.id` — request UUID; also returned as the `X-Request-Id` response header. Inbound `X-Request-Id` headers are honoured (good for correlating with an upstream load balancer)
- `responseTime` — milliseconds end-to-end
- `uid` — Firebase UID for authenticated requests (omitted for anonymous)
- `roomCode` — only on `/api/carkedit/rooms/lookup`
- `slow` — present and `true` when `responseTime >= LOG_SLOW_WARN_MS`

`Authorization`, `Cookie`, and `Set-Cookie` headers are redacted before serialization. Request bodies are never logged.

Useful queries:

```bash
# Tail prod logs and pretty-print
pm2 logs carkedit-api --nostream | npx pino-pretty

# Show only slow requests over the last hour
pm2 logs carkedit-api --nostream | jq 'select(.slow == true)'

# Show only 5xx
pm2 logs carkedit-api --nostream | jq 'select(.level >= 50)'

# Find every log line for a given X-Request-Id (returned to the client in response headers)
pm2 logs carkedit-api --nostream | jq 'select(.req.id == "<uuid>")'
```

## License

This project is licensed under the [Business Source License 1.1](./LICENSE).

- **Additional Use Grant:** Non-production use (development, testing, personal non-commercial play)
- **Change Date:** Rolling: 10 years after each version is published
- **Change License:** GNU Affero General Public License v3.0 (AGPLv3)

For commercial licensing, contact brennan@brennanhatton.com.
