# grok-web

**Local web UI for the [Grok Build](https://x.ai) CLI** — chat, sessions, projects, file diffs and MCP servers in the browser. The full power of the agent (tools, git, MCP, skills, session history) without leaving your editor workflow.

> **Not grok.com.** The model, tools, git and filesystem run on **your machine** via `grok agent serve`. This project is only the interface — it never proxies your code or prompts through a third party.

| | |
|---|---|
| **Install** | `npm i -g grok-web-ui` |
| **Run** | `grok-web` (opens your browser) |
| **UI** | `http://127.0.0.1:3847` |
| **Agent** | `ws://127.0.0.1:2419/ws` |

---

## Requirements

Before installing, make sure you have:

1. **Node.js ≥ 20.19** — check with `node --version`.
2. **Grok Build CLI** installed and in your `PATH`:

   ```bash
   curl -fsSL https://x.ai/cli/install.sh | bash
   ```

   Verify it works:

   ```bash
   which grok
   grok --version
   ```

3. **One-time login** (in a terminal):

   ```bash
   grok login
   ```

4. **Git** — optional, but needed for the Files panel (changes / diffs).

Developed and tested on Linux and WSL; macOS is expected to work.

---

## Install

```bash
npm i -g grok-web-ui
```

That's it. The package ships pre-built — no `npm install` step, zero runtime dependencies. (The command is `grok-web`.)

Verify:

```bash
grok-web --version
```

---

## Quick start

From the project you want to work on:

```bash
cd ~/your-project
grok-web
```

The launcher will:

1. Start `grok agent serve` on `127.0.0.1:2419` (with a random per-run secret).
2. Start the local web server + UI on `127.0.0.1:3847`.
3. Open your browser automatically.

Stop everything with `Ctrl+C` in the terminal — both processes are cleaned up together.

### Options

```
grok-web [options]

  --port <n>     UI port (default 3847)
  --cwd <path>   initial project/CWD for sessions (default: current directory)
  --no-open      don't open the browser automatically
  --version      print version
  --help         show help
```

Examples:

```bash
grok-web --cwd ~/projects/my-app        # start in a specific project
grok-web --port 4000 --no-open          # custom port, headless
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROK_AGENT_HOST` | `127.0.0.1` | Bind host for the agent |
| `GROK_AGENT_PORT` | `2419` | Port for the agent WebSocket |
| `GROK_AGENT_SECRET` | random per run | `server-key` of the agent WebSocket — treat it as a local password |
| `GROK_HOME` | `~/.grok` | Grok Build home (sessions, config, skills) |
| `GROK_WEB_PROJECTS_ROOT` | `~/projetos` | Folder listed in the **Projects** sidebar |
| `GROK_BIN` | `grok` | Path/name of the Grok CLI binary |

### Advanced: reuse an already-running agent

The launcher always spawns its own agent and refuses to start if port 2419 is busy. To attach the UI to an existing agent instead, run the web server directly (from a source checkout, after `npm run build`):

```bash
# terminal 1 — your own agent
grok agent --always-approve serve --bind 127.0.0.1:2419 --secret MY_SECRET

# terminal 2 — UI + local APIs only
GROK_AGENT_SECRET=MY_SECRET \
GROK_AGENT_WS_URL="ws://127.0.0.1:2419/ws?server-key=MY_SECRET" \
node dist-server/server.mjs
```

Then open `http://127.0.0.1:3847`. In development, `npm run dev` does the same with HMR (set the two env vars first).

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  Browser — http://127.0.0.1:3847                            │
│  chat · sessions · projects · files · MCP · skills · usage  │
└──────────────┬──────────────────────────────┬───────────────┘
               │ HTTP (local APIs)            │ WebSocket (ACP / JSON-RPC)
               ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────────────────┐
│  Node server (127.0.0.1)     │   │  grok agent serve                    │
│  files, git diffs, MCP,      │   │  ws://127.0.0.1:2419/ws?server-key=… │
│  sessions, models, usage     │   │  model · tools · turns · ~/.grok     │
└──────────────────────────────┘   └──────────────────────────────────────┘
```

- The **browser talks to the agent directly** over WebSocket using the ACP (Agent Client Protocol) JSON-RPC methods (`initialize`, `session/new`, `session/prompt`, …). The Node server only handles local disk/git/config concerns.
- Sessions, MCP config and skills live in `~/.grok` — **shared with the Grok TUI**, so history follows you between both interfaces.

| Data | Path |
|------|------|
| Session history (`chat_history.jsonl`, `signals.json`, …) | `~/.grok/sessions/` |
| MCP servers, UI preferences | `~/.grok/config.toml` |
| User skills | `~/.grok/skills/` |
| Model catalog cache | `~/.grok/models_cache.json` |
| OIDC login (never committed) | `~/.grok/auth.json` |

---

## What you get in the UI

- **Sessions & Projects sidebar** — mirrors the TUI history; click to resume any conversation.
- **Chat** — streaming thinking/tools/text, image paste, multi-tab conversations. When the agent is busy, new messages go to an editable **queue** and are sent FIFO when the turn ends.
- **Slash commands** — type `/` in the composer: local UI commands (`/new`, `/model`, `/usage`, …), built-ins (`/compact`, `/plan`, `/doctor`) and your skills as `/skill-name`.
- **Model & effort picker** — model catalog from `~/.grok/models_cache.json` with reasoning effort (low/medium/high) where supported.
- **Files workbench** — git changes, lazy file tree, per-file diffs, and an editor (Ctrl/Cmd+S to save).
- **MCP panel** — list/add/enable/remove MCP servers (HTTP, SSE, stdio + presets), test with `grok mcp doctor`.
- **Skills panel** — manage user/project/bundled skills; they appear as slash commands.
- **Usage meter** — context window %, tokens, estimated cost, tools/turns/latency per session.

---

## Security notes

- Everything binds to **127.0.0.1 only**. There is no remote access by design — don't port-forward or expose the UI without adding your own auth layer.
- The agent WebSocket is protected by a `server-key` (random per launch unless you set `GROK_AGENT_SECRET`). Treat it as a local password.
- **Filesystem sandbox:** reads are allowed under `$HOME` and `/tmp`; writes only under `$HOME`.
- The launcher starts the agent with `--always-approve`, so tool calls (shell, file edits, …) run without per-action prompts — the same trust model as running the agent yourself that way. Run it in projects you're comfortable letting an agent act on.
- Never commit `~/.grok/auth.json` or any secrets.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `CLI "grok" não encontrado no PATH` (grok CLI not found) | Install Grok Build: `curl -fsSL https://x.ai/cli/install.sh \| bash`, then run `grok login` once. Or point `GROK_BIN` at the binary. |
| `porta 3847 já em uso` (port already in use) | Kill the previous `grok-web`/agent process, or use `--port <other>`. Same for agent port 2419 (`GROK_AGENT_PORT`). |
| "Agent offline" in the UI | Make sure the launcher is still running (it owns the agent), or set `GROK_AGENT_WS_URL` correctly if you run the agent separately. |
| `session/load` fails | The session is open in the TUI (exclusive). Close it there or start a new session. |
| New MCP server doesn't appear | Restart the agent (`Ctrl+C` on the launcher, then `grok-web` again). |
| No models in the picker | Run the TUI once while logged in to populate `~/.grok/models_cache.json`. |
| Files/diff panel empty | The CWD has no git repo, or the path is outside the sandbox (`$HOME`/`/tmp`). |
| `Auth(AuthorizationRequired)` in logs | Usually a remote MCP server needing OAuth — log it in via the TUI or disable that server. Chat itself keeps working. |

Launcher logs are prefixed `[grok]` (agent) and `[node]` (web server) in your terminal.

---

## Development

```bash
git clone https://github.com/humbertocortezia/grok-web.git
cd grok-web
npm install
```

| Script | What it does |
|--------|--------------|
| `npm run dev` | API server (tsx watch, port 3848) + Vite dev server with HMR |
| `npm run build` | Builds the client (`dist/`) and bundles the server (`dist-server/server.mjs`) |
| `npm start` / `npm run web` | Runs the launcher against the built output (agent must be available) |
| `npm run typecheck` | `tsc --noEmit` |

In a source checkout without `dist-server/`, the launcher falls back to running the TypeScript server directly via `tsx`.

### Repository layout

```
grok-web/
├── bin/grok-web.mjs        # launcher: spawns agent + server, opens browser
├── server/
│   ├── server.ts           # node:http — local APIs + static/SPA serving
│   └── lib/                # sessions, usage, mcp-config, skills, git-diff, …
├── src/
│   ├── components/         # React UI (app shell, chat, workbench, panels)
│   ├── lib/                # acp-client (WebSocket ACP), session cache, …
│   └── main.tsx            # entry
├── vite.config.ts          # Vite + React + Tailwind 4
└── index.html              # SPA shell
```

Stack: **Vite + React 19 + Tailwind CSS 4** on the client, plain **`node:http`** (no framework) on the server. The published npm package contains only pre-built artifacts — zero runtime dependencies.

---

## License

MIT — personal/local-first project. It depends on the Grok Build CLI and your own xAI account; never redistribute tokens or secrets from `~/.grok`.
