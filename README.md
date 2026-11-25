# Deployr

A small, self-hosted Vercel-style deployment platform.

Paste a Git repository, it gets cloned, uploaded to S3, built by a worker, and
served from S3 under a short deployment id — with live build logs in a React
dashboard.

```
┌────────────┐   POST /deploy    ┌──────────────┐
│  React UI  │ ────────────────► │   API :3000  │
│  :5173     │ ◄──────────────── │  (Express)   │
└────────────┘   SSE logs        └──────┬───────┘
                                        │ clone + upload source
                                        ▼
                                  ┌───────────┐
                                  │    S3     │
                                  │ output/id │
                                  └─────┬─────┘
                                        │ LPUSH build-queue
                                        ▼
                                  ┌───────────┐
                                  │   Redis   │
                                  └─────┬─────┘
                                        │ BRPOP
                                        ▼
                               ┌─────────────────┐
                               │  Build worker   │
                               │ npm install +   │
                               │ npm run build   │
                               └────────┬────────┘
                                        │ upload dist/id
                                        ▼
                                  ┌───────────┐
                                  │    S3     │
                                  │  dist/id  │
                                  └─────┬─────┘
                                        │ GET
                                        ▼
                               ┌─────────────────┐
                               │ Request handler │
                               │     :4000       │
                               └─────────────────┘
```

## Features

- Deploy any public Git repo (or a local path) from the dashboard or API
- React + Vite dashboard with deployment history and status badges
- **Live build logs** over Server-Sent Events (`EventSource`)
- Static output auto-detection: `dist/`, `build/`, `out/` (override with `BUILD_OUTPUT_DIR`)
- Monorepo friendly: finds the app's `package.json` in a subfolder
- Per-job error handling: one broken build never kills the worker
- SPA fallback (`/about` → `index.html`), correct content types, cache headers
- Windows-friendly (no WSL required for the Node services)

## Project structure

```
.
├─ frontend/                 React + Vite dashboard (:5173 dev)
│  ├─ src/App.jsx            deploy form, list, live logs
│  └─ vite.config.js         proxies /deploy, /deployments, /logs… to :3000
├─ vercel/                   API + uploader (:3000)
│  └─ src/index.ts           clone, upload, enqueue, status/logs, SSE
├─ vercel-deploy-service/    Build worker (no port)
│  └─ src/utils.ts           install, build, output detection
├─ request-handler/          Serves dist/<id>/... from S3 (:4000)
└─ package.json              root scripts: setup / dev / build / start
```

## Requirements

- Node.js 20+ (tested on 22)
- Redis — Docker is easiest on Windows:
  ```powershell
  docker run -d --name redis -p 6379:6379 redis:7-alpine
  ```
- An S3 bucket + credentials with `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`
- Git on `PATH`

## Setup

```powershell
git clone <this-repo>
cd vercel
npm install
npm run setup      # installs the 4 workspaces (also runs from postinstall)
```

Create the env files from the examples:

```powershell
Copy-Item vercel\.env.example vercel\.env
Copy-Item vercel-deploy-service\.env.example vercel-deploy-service\.env
Copy-Item request-handler\.env.example request-handler\.env
```

Then fill in AWS credentials and the bucket name in all three.

> The API and the worker **must use the same Redis and the same bucket**.
> `request-handler` only needs the bucket + credentials.

### Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `AWS_REGION` | all | e.g. `ap-south-1` |
| `AWS_ACCESS_KEY_ID` | all | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | all | IAM secret |
| `AWS_SESSION_TOKEN` | all | optional, for temporary credentials |
| `AWS_BUCKET_NAME` | all | S3 bucket |
| `REDIS_URL` | API + worker | `redis://127.0.0.1:6379` (bare `host:port` also works) |
| `PORT` | API / request-handler | API `3000`, sites `4000` |
| `REQUEST_HANDLER_BASE_URL` | API + worker | where built sites are served, default `http://localhost:4000` |
| `WORK_DIR` | API + worker | where repos are cloned/built, default `./output` |
| `BUILD_OUTPUT_DIR` | worker | force a specific build folder (`dist`, `build`, `out`…) |
| `BUILD_TIMEOUT_MS` | worker | default `900000` (15 min) |
| `KEEP_BUILD` | worker | `false` deletes the local repo after upload |
| `UPLOAD_CONCURRENCY` | worker | parallel S3 uploads, default `8` |

## Run

### Development (one command)

```powershell
npm run dev
```

Starts all four processes with colored logs:

| Process | URL |
| --- | --- |
| `ui` (Vite) | **http://localhost:5173** |
| `api` | http://localhost:3000 |
| `worker` | — |
| `sites` | http://localhost:4000 |

> Ports are configurable. The site server defaults to **4000** because `3001` is
> often already taken on Windows (VS Code preview servers, other tutorials).
> To change it, set `PORT` in `request-handler/.env` and
> `REQUEST_HANDLER_BASE_URL` in the API + worker `.env` files.

### Individually

```powershell
cd vercel;               npm run dev   # API
cd vercel-deploy-service; npm run dev  # worker
cd request-handler;      npm run dev   # sites
cd frontend;             npm run dev   # UI on :5173
```

### Production-style (single origin)

```powershell
npm run build
npm start
```

The React build (`frontend/dist`) is served by the API, so the dashboard is at
**http://localhost:3000**. `/deployments`, `/logs/stream`, etc. are same-origin.

## Using the dashboard

1. Paste a repo URL, e.g. `https://github.com/user/vite-app`.
2. Click **Deploy**.
3. The deployment card appears with a live status (`Cloning → Uploading → Queued
   → Building → Ready`).
4. Logs stream into the terminal panel as the worker builds.
5. Click **Open ↗** to view the deployed site.

The site is available at any of:

- `http://<id>.localhost:4000/` — works in Chrome/Edge/curl on Windows
- `http://localhost:4000/?id=<id>` — always works (Postman/PowerShell)
- `http://localhost:4000/_deployments/<id>/`
- header `x-deployment-id: <id>`

## API reference

### `POST /deploy`

```powershell
$body = @{ repoUrl = "https://github.com/user/repo" } | ConvertTo-Json
$res  = Invoke-RestMethod -Method Post -Uri http://localhost:3000/deploy `
          -ContentType application/json -Body $body
```

```json
{
  "id": "ic5oj",
  "status": "uploaded",
  "message": "Deploying from …",
  "url": "http://localhost:4000/?id=ic5oj",
  "subdomainUrl": "http://ic5oj.localhost:4000/"
}
```

### `GET /deployments`

Newest first, max 50. Includes `id`, `status`, `repoUrl`, `createdAt`, `url`,
`subdomainUrl`.

### `GET /status?id=<id>`

```json
{ "id": "ic5oj", "status": "built" }
```

Statuses: `cloning`, `uploading`, `uploaded`, `building`, `built`, `failed`.

### `GET /logs?id=<id>`

Full log history as JSON:

```json
{ "id": "ic5oj", "logs": ["[2026-…] Cloning …", "…"] }
```

### `GET /logs/stream?id=<id>` (SSE)

Used by the dashboard. Events:

| Event | Data |
| --- | --- |
| `log` | one log line (JSON string) |
| `status` | current status |
| `done` | terminal status (`built` or `failed`) |
| `failure` | error message (stream closes) |

```powershell
curl.exe -N "http://localhost:3000/logs/stream?id=ic5oj"
```

### `GET /health`

`{ "ok": true }`

## How live logs work

- The API and worker append lines to a Redis list: `logs:<id>` (newest at the end).
- The worker batches lines (~400 ms) so noisy `npm install` output doesn't cause
  thousands of Redis round-trips, then flushes before publishing the terminal status.
- `/logs/stream` replays the whole list, then polls with a cursor every 500 ms and
  emits new lines. It sends `done` 1.5 s after a terminal status so the final
  buffered lines are not lost.
- Logs are trimmed to the last 1000 lines per deployment.

## S3 layout

```
s3://<bucket>/output/<id>/...   # source uploaded by the API
s3://<bucket>/dist/<id>/...     # static build uploaded by the worker
```

`request-handler` only reads `dist/<id>/...`, so the source can be deleted later.

## Build output detection

The worker looks for the first existing folder containing `index.html`:

1. `dist/` — Vite, CRA with a custom build, Angular
2. `build/` — Create React App
3. `out/` — Next.js `output: "export"`, some Astro setups

If the repo has no `package.json` at the root, it searches up to 2 levels deep for
the nearest one with a `build` script (e.g. `apps/web/`). If only `.next/` exists,
it returns a clear error explaining that this static architecture needs
`output: "export"`.

This platform is for **static sites**. SSR frameworks (Next.js server mode, Nuxt
server mode) need a Node runtime and are out of scope.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` on 3000/4000/5173 | Stop the old process: `Get-NetTCPConnection -LocalPort 3000 \| Select OwningProcess` then `Stop-Process -Id <pid> -Force` |
| `ERR_INVALID_URL` at API start | `REDIS_URL` must be `redis://host:port`; bare `host:port` is normalized, but an empty/invalid value is not |
| Jobs stay `uploaded` | The worker isn't running or points at another Redis — `REDIS_URL` must match in the API and worker |
| `503 Frontend not built` at :3000 | Run `npm --prefix frontend run build`, or use `npm run dev` and open :5173 |
| Build fails with `node-sass` | Old CRA repos using node-sass 4.x don't support Node 22; build with Node 16/18 in Docker or migrate to `sass` |
| `ENAMETOOLONG` / `EPERM` on Windows | Set `WORK_DIR=C:\v` in the API and worker; exclude the folder from antivirus |
| Build output not found | Check the build script's actual output folder and set `BUILD_OUTPUT_DIR` |
| Logs panel empty | Select a deployment; check `GET /logs?id=<id>` and the worker console |

## Security notes

- The worker executes `npm install` / `npm run build` from arbitrary repos,
  including `postinstall` scripts. Run it in a container with CPU/memory limits
  and no host access before exposing this to the internet.
- Validate `repoUrl` against an allow-list (e.g. only `github.com`) if the API is
  public. Local paths are convenient in development but should be rejected in
  production.
- Keep the S3 bucket private; all reads go through `request-handler` with IAM
  credentials.

## Roadmap ideas

- BullMQ instead of raw `LPUSH/BRPOP` (retries, locks, concurrency)
- Postgres for deployments metadata instead of Redis hashes
- Docker sandbox per build
- Custom domains via a reverse proxy (`Host` → deployment id)
- Scheduled cleanup of old S3 prefixes and `output/`
- Brotli/gzip at the edge and HTTP caching polish

## License

MIT
