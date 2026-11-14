# GEMINI.md — Architecture, Tooling & Developer Guide for OpenLLM CLI

> **Project**: OpenLLM CLI (`@openllmsh/cli`)  
> **Repository**: [geokal/openllm-cli](https://github.com/geokal/openllm-cli) (fork of [openllmsh/cli](https://github.com/openllmsh/cli))  
> **Active Branch**: `feat/antigravity-and-windows-fixes`  
> **Target Version**: `v2.10.17` (minimum version floor required by cloud relay)

---

## 1. Project Overview

OpenLLM CLI is the local daemon and terminal interface that bridges developer workstations, local LLM runtimes (Ollama, LM Studio, vLLM), and agent CLIs (Claude Code, Cursor, Codex, etc.) with the OpenLLM cloud platform and web app ([https://www.openllm.sh](https://www.openllm.sh)). 

It provides secure device pairing, end-to-end encrypted device sessions via Ed25519 device proof keys (DPK), and WebSocket multiplexing between the local machine and remote web clients.

---

## 2. Tech Stack & Dependencies

- **Runtime & Package Manager**: [Bun](https://bun.sh) (`v1.2+`) — builds single-binary executables via Bun compiler.
- **Language**: TypeScript (`ESNext` / Node & Bun module resolution, strict mode).
- **Protocol & Network**:
  - `partysocket` (`^1.1.19`): WebSocket client for persistent control channel with cloud relay.
  - `werift` (`^0.24.2`): WebRTC data channel & RTC media streaming for browser ↔ workstation PTY bridging.
  - `@openllmsh/sdk` (`v2.10.17`): Official protocol definitions, relay frames, and schema contracts.
- **Terminal & PTY**: `@xterm/headless` (`6.0.0`), `@xterm/addon-serialize` (`0.14.0`), `Bun.Terminal`.
- **Validation & Functional Core**: `zod` (`^4.4.3`), `effect` (`4.0.6`).
- **AI Coding & Exploration Tools**:
  - **Serena MCP**: Symbol navigation, AST inspection, cross-referencing, semantic code edits.
  - **code-review-graph MCP**: Structural knowledge graph, blast-radius analysis, and flow impact tracing.
  - **RTK (Rust Token Killer)**: Token-optimized CLI execution wrapper.

---

## 3. Project Structure

```
cli/
├── src/                         # CLI entry points and client command implementations
│   ├── main.ts                  # CLI binary bootstrapper & sub-command dispatcher
│   ├── cli-dispatch.ts          # Command routing and option handling
│   ├── doctor-launchers-cmd.ts  # Environment diagnostics for vendor CLI launchers
│   └── clients/                 # Specialized client adapters (Claude, Hermes, sessions)
│       └── session.ts           # Interactive terminal session client
├── daemon/                      # Long-running background daemon
│   └── src/
│       ├── main.ts              # Daemon boot sequence, HTTP /v1 server, process lifetime
│       ├── control-channel.ts   # Cloud relay WebSocket connection & frame dispatcher
│       ├── status-dirty.ts      # Dirty status gate & heartbeat timing constants
│       ├── status-publish-coalesce.ts # Coalescing queue for outgoing status snapshots
│       ├── listener.ts          # Local HTTP /v1 API server (inference & presence trigger)
│       ├── delegation/          # Vendor CLI integrations (ChatGPT, Claude, Cursor, Grok, etc.)
│       └── native-runtime/      # Native runtime execution and process management
├── scripts/                     # Build, packaging, and verify automation
│   ├── compile.ts               # Standalone binary compiler (bun build --compile)
│   └── verify.ts                # Test runner and validation pipeline
├── dist/                        # Build artifacts (openllm.exe / openllm binary)
└── GEMINI.md                    # This document
```

---

## 4. Setup & Commands

### Prerequisites
- Install **Bun** (`v1.2+`): `irm bun.sh/install.ps1 | iex` (Windows PowerShell)

### Installation & Compilation
```powershell
# 1. Install dependencies
bun install

# 2. Compile standalone host binary with fixed version floor
bun scripts/compile.ts --host --version 2.10.17

# 3. Deploy binary to Windows PATH locations
Copy-Item "dist\openllm.exe" "$HOME\.tools\openllm.exe" -Force
Copy-Item "dist\openllm.exe" "$HOME\.openllm\bin\openllm.exe" -Force
```

### Daemon Management (Windows)
```powershell
# Start daemon in background
& "$HOME\.tools\openllm.exe" daemon

# Check daemon health & cloud connection
& "$HOME\.tools\openllm.exe" daemon status

# Check device pairing & anchor status
& "$HOME\.tools\openllm.exe" daemon device status

# Identity inspection
& "$HOME\.tools\openllm.exe" daemon identity
```

---

## 5. Architectural Notes & Problem Context

### The Stateless Relay & Status Starvation Issue (Solved)
1. **Architecture**:
   - The cloud relay (`wss://sb-3kwn158lscou.vercel.run/`) acts as an in-memory router between daemons and browser watcher tabs.
   - The relay **does not cache** or replay full status payloads in its `welcome` frame (it only supplies the key ID array).
   - Watchers only receive daemon capabilities and model state when the daemon actively sends `{ type: "status", ... }`, which the relay fans out as `status_push`.
2. **The Root Cause**:
   - `daemon/src/status-publish-coalesce.ts` has a gate checking `if (job.skipUnchanged && computed.fingerprint === host.lastFingerprint()) return;`.
   - On an idle machine, periodic watcher polls passed `skipUnchanged: true`, completely suppressing status transmission.
   - Result: Any newly opened or reloaded browser tab remained in `device.status === undefined`, causing the Web UI to show:
     > *"No device paired yet. Set one up under Keys on a macOS or Linux machine..."*
3. **The Root Causes & Solutions**:
   - **Status Starvation**:
     - `daemon/src/status-publish-coalesce.ts` gated on `skipUnchanged: true`.
     - *Fix*: In `control-channel.ts`, push unconditionally on `welcome` frame and on periodic watcher heartbeat ticks. In `status-dirty.ts`, reduced `STATUS_WATCH_HEARTBEAT_MS` to 30s.
   - **Silent Drop of Welcome Frame Due to Duplicate `effect` Packages**:
     - `@openllmsh/sdk#v2.10.17` had a nested `node_modules/@openllmsh/sdk/node_modules/effect`.
     - When `control-channel.ts` called `decodeFrame = Schema.decodeUnknownResult(RelayFrame)` (from root `effect`), Effect Schema's internal Symbol-based AST checks failed on `RelayCapability` (`isMinLength(1)` check in `snapshot_caps` and `caps`), returning a `SchemaError`.
     - In `onMessage`, undecodable non-command frames were dropped without running `case "welcome"`, preventing `supportsOrderedStatus` from being set to `true` and causing `canSend()` to fail status pushes.
     - *Fix*: Added `"overrides": { "effect": "4.0.6" }` in `package.json` to deduplicate `effect`. Added resilient fallback decoding in `onMessage` so `welcome` frames are never dropped even if schema refinements change, plus added `logWarn` diagnostics for undecodable frames.

### Device Cryptographic Anchoring
- Configuration is loaded from `$HOME\.openllm\.env`:
  - `OPENLLM_API_KEY`: Key ID (e.g., `bjhzEdr_HU8r1w`) and secret.
  - `OPENLLM_DEVICE_ANCHOR`: Pre-computed base64url anchor string tying the workstation to the control pubkey.
- DPK (Device Private Key) is minted inside the browser's IndexedDB vault.
- When anchored properly, `daemon identity` reports `device-control (control, via anchor, anchored)`.

### Windows Portability Adaptations
- **PTY Execution**: Node/Bun child process spawning on Windows must avoid `detached: true` when wrapping console sessions.
- **Path Schemes**: `ws+unix://` socket URLs must normalize drive letters to forward slashes (e.g. `ws+unix:///C:/Users/...`).
- **External Binaries**: Vendor CLI lookup must probe `.exe` and `.cmd` extensions in Windows PATH.

---

## 6. Coding Conventions

- **Module System**: Pure ES modules (`import`/`export`).
- **Timing & Process Teardown**: Always call `.unref?.()` on long-lived intervals/timeouts so they don't block clean process exit.
- **Diagnostic Logging**: Use tagged template literals with `safeDiagnosticMessage` to prevent accidental credential leakage in logs.
- **Status Publication**:
  - `pushStatusIfChanged(trigger)`: Use for events where machine state might have changed (dirty ticks, auth updates).
  - `pushStatus(active, trigger)`: Use for liveness assertions and heartbeat broadcasts where state must be pushed regardless of fingerprint match.

---

## 7. Guardrails & Restrictions

1. **Version Floor Enforcement**:
   - Always compile with `--version 2.10.17` (or higher). Never allow version string to drop below `2.10.17`, or the cloud relay will return `daemon_outdated`.
2. **Provider Probes on Heartbeat**:
   - In `control-channel.ts`, heartbeat ticks **must** keep `watcherSkipProviderProbes = true` to prevent intrusive OS keychain unlock prompts while the user is idle.
3. **Secrets & Environment**:
   - Never commit `.env` or hardcode tokens in repo files. Secret material belongs in `$HOME\.openllm\.env`.
4. **Tool Selection Priority**:
   - Use `code-review-graph` MCP tools (`detect_changes_tool`, `query_graph_tool`) or `serena` MCP tools (`find_symbol`, `search_for_pattern`) before resorting to brute-force grep or reading massive files.

---

## 8. Common Tasks

### Rebuilding and Testing Changes
```powershell
# 1. Compile host binary
bun scripts/compile.ts --host --version 2.10.17

# 2. Stop running daemon
Get-Process openllm -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Overwrite installed binaries
Copy-Item "dist\openllm.exe" "$HOME\.tools\openllm.exe" -Force
Copy-Item "dist\openllm.exe" "$HOME\.openllm\bin\openllm.exe" -Force

# 4. Restart daemon in background
& "$HOME\.tools\openllm.exe" daemon
```

### Inspecting WebSocket Traffic in Browser
1. Open [https://www.openllm.sh/chat](https://www.openllm.sh/chat).
2. Open DevTools (`F12`) → **Network** tab → filter by `WS` → select `sb-3kwn158lscou.vercel.run`.
3. Open **Messages** sub-tab:
   - Initial frames: `hello` → `welcome` (`snapshot: ["<key_id>"]`).
   - Periodic frames: `status_push` should arrive within 60s alongside regular 20s `ping`/`pong`.
