# vercel-clone

A small Vercel-style deployment pipeline on Windows:

```
POST /deploy ──► clone repo ──► upload source to S3 (output/<id>/...)
                                        │
                                        └─► LPUSH build-queue <id>  ──► Redis
                                                                       │
Worker BRPOP ◄─────────────────────────────────────────────────────────┘
   │
   ├─ download output/<id>/ from S3
   ├─ npm install && npm run build
   ├─ find dist/ | build/ | out/
   └─ upload to S3 dist/<id>/...

Browser ──► request-handler ──► GET s3://bucket/dist/<id>/<path>
```

| Service | Folder | Port | Responsibility |
| --- | --- | --- | --- |
| API / uploader | `vercel` | 3000 | clone repo, upload source, enqueue job, status/logs |
| Build worker | `vercel-deploy-service` | – | download source, build, upload static output |
| Request handler | `request-handler` | 3001 | serve `dist/<id>/...` from S3 |

## Prerequisites

- Node.js 20+ (tested on 22)
- Redis (Docker is easiest on Windows):
  ```powershell
  docker run -d --name redis -p 6379:6379 redis:7-alpine
  ```
- An S3 bucket and credentials that can `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`

## Setup

Each service has its own `.env` (copy from `.env.example`). The API and the
worker **must use the same Redis and bucket**. The request handler only needs
the bucket + credentials.

```powershell
cd vercel;               npm install
cd ../vercel-deploy-service; npm install
cd ../request-handler;   npm install
```

## Run (three terminals)

```powershell
# terminal 1 – API
cd vercel
npm run dev            # or: npm run build; npm start

# terminal 2 – worker
cd vercel-deploy-service
npm run dev

# terminal 3 – request handler
cd request-handler
npm run dev
```

## Use it

```powershell
$body = @{ repoUrl = "https://github.com/you/your-app" } | ConvertTo-Json
$res  = Invoke-RestMethod -Method Post -Uri http://localhost:3000/deploy `
          -ContentType application/json -Body $body

Invoke-RestMethod "http://localhost:3000/status?id=$($res.id)"
Invoke-RestMethod "http://localhost:3000/logs?id=$($res.id)"
```

Open the deployed site in one of these ways:

- `http://<id>.localhost:3001/` (works in Chrome/Edge and curl)
- `http://localhost:3001/?id=<id>` (always works, good for PowerShell/Postman)
- `http://localhost:3001/_deployments/<id>/` (path prefix)
- send header `x-deployment-id: <id>`

## What was broken (and is now fixed)

1. **The build output folder was hard-coded to `dist/`.**
   Create React App emits `build/`; Next.js `output: "export"` emits `out/`.
   The worker now checks `dist`, `build`, `out` (override with `BUILD_OUTPUT_DIR`).
2. **Repos whose app lives in a subfolder failed.**
   The worker now finds the nearest `package.json` with a `build` script
   (e.g. `my-simple-app/` inside the repo).
3. **One failed build killed the whole worker.**
   Every job is wrapped in `try/catch`: status becomes `failed`, logs are kept,
   and the worker keeps consuming the queue.
4. **`dist` vs `dist` path mismatch.** Source was downloaded to
   `path.join(__dirname, key)` and built from `__dirname/output/<id>`, which
   silently depended on how the service was started (`src` vs `dist`). Both now
   use one `WORK_DIR` (`output/` next to the service, or `WORK_DIR` env).
5. **`.git` was uploaded to S3** (huge + slow). It and `node_modules` are skipped.
6. **`dotenv` was missing** in the worker and request handler, so their `.env`
   was never loaded. Both now load it explicitly.
7. **`REDIS_URL=127.0.0.1:6379` (no scheme)** crashed node-redis with
   `ERR_INVALID_URL`. Bare `host:port` is normalized to `redis://host:port`.
8. **`exec("npm install && npm run build")` had a 1 MB output buffer** and could
   be killed by normal build noise. Replaced with `spawn` + streamed logs.
9. **Builds inherited `NODE_ENV=production`**, which makes npm skip
   devDependencies (Vite, react-scripts, TypeScript…). The worker forces
   `--include=dev` and `NODE_ENV=development` for installs.
10. **Status never left `uploaded`.** The worker now writes `building` →
    `built` / `failed` and streams logs to `logs:<id>` in Redis.
11. **SPA routes 404'd** (`/about` on a React app). The request handler now falls
    back to `index.html` when the path has no file extension.
12. **Fragile S3 keys** (`file.slice(__dirname.length + 1)`). Keys are now built
    with `path.relative()` and forward slashes.
13. **`aws-sdk` v2 is end-of-life.** All services now use `@aws-sdk/client-s3` v3.
14. **UTF-8 BOM in `package.json`** made `JSON.parse` fail and the worker report
    "no build script". The BOM is stripped before parsing.

## Windows-specific notes

- `*.localhost` resolves in Chrome/Edge and curl on Windows 10/11. If it does
  not in your browser, use `?id=` or `/_deployments/<id>/`.
- Long paths: `node_modules` inside a deeply nested folder can exceed 260 chars.
  Set `WORK_DIR=C:\v` in the worker (and API) if you see `ENAMETOOLONG`/`EPERM`.
- Antivirus can lock files while npm installs. Exclude the build `output/` folder
  if installs fail randomly with `EBUSY`.
- Old CRA projects that depend on `node-sass` (node-sass 4.x) cannot build on
  Node 22. That is a repo/toolchain issue: build them with Node 16/18 in Docker,
  or migrate to `sass` (`dart-sass`).

## Next steps to make it production-like

1. **Sandbox the build.** Right now `npm install` runs repo code on your machine
   (postinstall scripts). Run the worker in a container with a read-only root,
   CPU/memory limits and no network after install.
2. **Use a real queue.** Redis `LPUSH/BRPOP` loses a job if the worker dies
   mid-build. BullMQ gives retries, locks and concurrency.
3. **Store deployments in a DB.** Redis is used for status/logs; a Postgres table
   with `id`, `repo`, `commit`, `status`, `created_at` makes the API reliable.
4. **Add a custom-domain proxy.** Map `Host` → deployment id (Caddy/Nginx) instead
   of relying on `*.localhost`.
5. **Cache/immutable assets.** Hashed assets already get a 1-year cache; serve
   HTML with `no-cache` (done) and consider Brotli at the edge.
6. **Support SSR frameworks.** Next.js/Nuxt need a Node runtime, not static S3.
   This architecture is for static sites (Vite, CRA, Astro static, etc.).
7. **Clean up old builds.** The worker keeps `output/<id>` for debugging. Set
   `KEEP_BUILD=false` or add a scheduled cleanup of S3 + disk.
8. **Validate repo URLs.** Reject local paths and non-allow-listed hosts if the
   API is exposed publicly (otherwise anyone can make the worker execute code).
