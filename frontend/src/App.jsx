import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const STATUS_LABELS = {
  cloning: "Cloning",
  uploading: "Uploading",
  uploaded: "Queued",
  building: "Building",
  built: "Ready",
  failed: "Failed",
  idle: "Idle",
};

const ACTIVE = new Set(["cloning", "uploading", "uploaded", "building"]);

function repoName(url) {
  if (!url) return "unknown";
  const parts = String(url)
    .replace(/\.git$/, "")
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.slice(-2).join("/") || String(url);
}

function timeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  );
  if (Number.isNaN(seconds)) return "";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function badgeClass(status) {
  if (status === "built") return "ok";
  if (status === "failed") return "err";
  if (ACTIVE.has(status)) return "run";
  return "idle";
}

function lineClass(line) {
  if (/^\$ /.test(line)) return "cmd";
  if (/error|failed|ERR!|ELIFECYCLE|exit code/i.test(line)) return "error";
  if (/warn/i.test(line)) return "warn";
  if (/deployment ready|uploaded \d+ built files|built into/i.test(line))
    return "ok";
  return "";
}

export default function App() {
  const [deployments, setDeployments] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState("idle");
  const [apiOnline, setApiOnline] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const sourceRef = useRef(null);
  const terminalRef = useRef(null);
  const bootedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/deployments", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data.deployments) ? data.deployments : [];
      setDeployments(list);
      setApiOnline(true);
      return list;
    } catch {
      setApiOnline(false);
      return [];
    }
  }, []);

  const stopStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const openLogs = useCallback(
    (deployment) => {
      if (!deployment) return;

      stopStream();
      setActiveId(deployment.id);
      setLogs([]);
      setStatus(deployment.status || "idle");

      const source = new EventSource(
        `/logs/stream?id=${encodeURIComponent(deployment.id)}`
      );
      sourceRef.current = source;

      source.addEventListener("log", (event) => {
        let line = event.data;
        try {
          line = JSON.parse(event.data);
        } catch {
          /* keep raw */
        }
        setLogs((prev) =>
          [...prev.slice(-1999), line].slice(-2000)
        );
      });

      source.addEventListener("status", (event) => {
        let next = event.data;
        try {
          next = JSON.parse(event.data);
        } catch {
          /* keep raw */
        }
        setStatus(next);
        setDeployments((prev) =>
          prev.map((d) => (d.id === deployment.id ? { ...d, status: next } : d))
        );
      });

      source.addEventListener("done", (event) => {
        let next = event.data;
        try {
          next = JSON.parse(event.data);
        } catch {
          /* keep raw */
        }
        setStatus(next);
        setDeployments((prev) =>
          prev.map((d) => (d.id === deployment.id ? { ...d, status: next } : d))
        );
        source.close();
        sourceRef.current = null;
        load();
      });

      source.addEventListener("failure", (event) => {
        setLogs((prev) => [...prev, String(event.data)]);
        source.close();
        sourceRef.current = null;
      });

      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) {
          sourceRef.current = null;
        }
      };
    },
    [load, stopStream]
  );

  useEffect(() => {
    load().then((list) => {
      if (!bootedRef.current && list.length > 0) {
        bootedRef.current = true;
        openLogs(list[0]);
      }
    });

    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, openLogs]);

  useEffect(() => () => stopStream(), [stopStream]);

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  async function deploy(event) {
    event.preventDefault();
    const url = repoUrl.trim();

    if (!url) {
      setError("Paste a Git repository URL first.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const res = await fetch("/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: url }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.id) {
          const list = await load();
          const created = list.find((d) => d.id === data.id);
          if (created) openLogs(created);
        }
        throw new Error(data.error || `Deploy failed (HTTP ${res.status})`);
      }

      setRepoUrl("");
      const list = await load();
      const created = list.find((d) => d.id === data.id);
      openLogs(
        created || {
          id: data.id,
          status: data.status,
          repoUrl: url,
          createdAt: new Date().toISOString(),
          url: data.url,
        }
      );
    } catch (err) {
      setError(err?.message || "Deploy failed");
    } finally {
      setBusy(false);
    }
  }

  const active = deployments.find((d) => d.id === activeId);

  return (
    <div className="app">
      <div className="glow" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <svg className="triangle" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 22 20H2z" fill="currentColor" />
          </svg>
          <span>deployr</span>
          <span className="brand-tag">local</span>
        </div>
        <div className="topbar-right">
          <span className={`dot ${apiOnline ? "online" : "offline"}`} />
          <span>{apiOnline ? "API online" : "API offline"}</span>
          <span className="divider" />
          <span className="muted mono">api :3000</span>
          <span className="muted mono">sites :4000</span>
        </div>
      </header>

      <main className="layout">
        <section className="column">
          <form className="card deploy-card" onSubmit={deploy}>
            <h1>Deploy a Git repository</h1>
            <p className="muted deploy-sub">
              Clone → upload to S3 → build on the worker → serve the static
              output.
            </p>

            <div className="input-row">
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-label="Git repository URL"
              />
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Deploying…" : "Deploy"}
              </button>
            </div>

            {error && <p className="form-error">{error}</p>}

            <div className="tips">
              <span className="tip">
                <strong>Tip</strong> public repos work out of the box; private
                repos need a token in the URL.
              </span>
              <span className="tip">
                Static frameworks only: Vite, CRA, Astro, plain HTML…
              </span>
            </div>
          </form>

          <div className="section-head">
            <h2>Deployments</h2>
            <div className="section-actions">
              <span className="muted mono">{deployments.length}</span>
              <button className="ghost small" type="button" onClick={load}>
                Refresh
              </button>
            </div>
          </div>

          {deployments.length === 0 ? (
            <div className="empty">
              <strong>No deployments yet</strong>
              <span className="muted">
                Paste a Git URL above to ship your first site.
              </span>
            </div>
          ) : (
            <div className="deployment-list">
              {deployments.map((deployment) => (
                <div
                  key={deployment.id}
                  className={`deployment ${
                    deployment.id === activeId ? "active" : ""
                  }`}
                  onClick={() => openLogs(deployment)}
                  title={deployment.repoUrl || ""}
                >
                  <div className="deployment-main">
                    <div className="repo-name">
                      {repoName(deployment.repoUrl)}
                    </div>
                    <div className="meta">
                      <code>{deployment.id}</code>
                      <span>·</span>
                      <span>{timeAgo(deployment.createdAt)}</span>
                      <span>·</span>
                      <span>{STATUS_LABELS[deployment.status] ?? "Unknown"}</span>
                    </div>
                  </div>

                  <span className={`badge ${badgeClass(deployment.status)}`}>
                    {STATUS_LABELS[deployment.status] ?? deployment.status}
                  </span>

                  <div
                    className="deployment-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="ghost small"
                      type="button"
                      onClick={() => openLogs(deployment)}
                    >
                      Logs
                    </button>
                    <a
                      className={`link-btn ${
                        deployment.status === "built" ? "" : "disabled"
                      }`}
                      href={deployment.url || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="column logs-column">
          <div className="card logs-card">
            <div className="logs-head">
              <div className="logs-title">
                <span className="signal" />
                <span>
                  {active ? repoName(active.repoUrl) : "Build logs"}
                  {activeId ? <code className="logs-id">{activeId}</code> : null}
                </span>
              </div>
              <div className="logs-actions">
                <span className={`badge ${badgeClass(status)}`}>
                  {STATUS_LABELS[status] ?? status}
                </span>
                <button
                  className="ghost small"
                  type="button"
                  onClick={() =>
                    logs.length > 0 &&
                    navigator.clipboard?.writeText(logs.join("\n"))
                  }
                >
                  Copy
                </button>
                <button
                  className="ghost small"
                  type="button"
                  onClick={() => setLogs([])}
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="terminal" ref={terminalRef}>
              {logs.length === 0 ? (
                <span className="terminal-empty">
                  Select a deployment to stream its build logs.
                </span>
              ) : (
                logs.map((line, index) => (
                  <div key={index} className={`log-line ${lineClass(line)}`}>
                    {line}
                  </div>
                ))
              )}
            </div>

            <div className="logs-footer">
              <label className="check">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                Auto-scroll
              </label>
              <span className="muted mono">
                {logs.length} lines{activeId ? ` · ${activeId}` : ""}
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
