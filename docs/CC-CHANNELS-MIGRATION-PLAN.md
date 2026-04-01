# NanoClaw → Claude Code Runtime Migration Plan

> Replace the Claude Agent SDK container runtime with Claude Code sessions, gaining CC's full harness (auto-memory, slash commands, hooks, MCP ecosystem, context compression, permission model) as batteries-included agent capabilities.

---

## Strategy

**Keep the orchestrator. Replace the agent runtime.**

NanoClaw's value is in its orchestration layer: multi-channel messaging, Brain Router, knowledge vaults, project routing, task scheduling, IPC. None of that changes. What changes is how agents execute — instead of spawning Claude Agent SDK processes inside Linux containers, spawn Claude Code sessions (via the Agent SDK's programmatic API or `claude -p` CLI) that run in per-group working directories on the host.

The migration is scoped to **one component**: `src/container-runner.ts` (and its Railway counterpart `src/railway-runner.ts`). Everything upstream (channels, message loop, Brain Router, IPC watcher) and downstream (response routing, SQLite persistence) stays the same.

### Why This Works

1. CC sessions already have per-directory context isolation (CLAUDE.md, auto-memory, .claude/ settings)
2. CC sessions already have session resume/fork (`.jsonl` files under `.claude/projects/`)
3. CC sessions already have tool access (Bash, files, web, MCP servers)
4. CC's Agent SDK exposes `query()` with streaming, session management, and tool approval callbacks
5. Your current system already creates per-group `.claude/` directories with settings.json, skills, and session data — CC will use these natively

### What You Trade

| You lose | You gain |
|----------|----------|
| OS-level container isolation | CC auto-memory, slash commands, hooks, context compression |
| Credential proxy (keys never enter containers) | CC's native MCP ecosystem (any MCP server, no custom wiring) |
| Filesystem sandboxing per group | CC's permission model (tool approval, allowed tools) |
| Railway child-process deployment model | Session resume/fork across restarts |

---

## Goals

1. **Each NanoClaw group runs as a CC session** in its own working directory with its own CLAUDE.md, auto-memory, and .claude/ config
2. **IPC tools remain available** — agents can still send_message, schedule_task, execute_in_group, search vaults
3. **Session continuity preserved** — conversations resume across agent invocations using CC session resume
4. **Existing orchestration untouched** — channels, Brain Router, message loop, SQLite, task scheduler all work as-is
5. **Incremental migration** — can run container-based and CC-based groups side by side during transition

---

## Architecture (Target State)

```
┌────────────────────────────────────────────────────────────────────┐
│                     HOST (macOS / Linux)                           │
│                      (Single Node.js Process)                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Channel Registry ──▶ SQLite ──▶ Message Loop                     │
│  (unchanged)          (unchanged)  (unchanged)                     │
│                                       │                            │
│                                       │ spawns CC session          │
│                                       ▼                            │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  CC Session Runner (replaces container-runner.ts)         │     │
│  │                                                           │     │
│  │  • Spawns `claude -p` or Agent SDK query() per group     │     │
│  │  • Working dir: groups/{folder}/                          │     │
│  │  • Session resume via --resume {sessionId}               │     │
│  │  • IPC via MCP server (registered in group .mcp.json)    │     │
│  │  • Streams output back to orchestrator                    │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                    │
│  IPC Watcher (unchanged — still polls filesystem)                 │
│  Task Scheduler (unchanged)                                        │
│  Brain Router logic (unchanged — lives in groups/brain-router/)   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: CC Session Runner (replaces container-runner.ts)

**Objective:** Create `src/cc-session-runner.ts` that spawns CC sessions instead of containers, matching the existing `ContainerInput`/`ContainerOutput` interface.

**Approach — Agent SDK vs CLI:**

| Method | Pros | Cons |
|--------|------|------|
| **Agent SDK `query()`** | Native TypeScript, streaming, tool callbacks, structured output | Less battle-tested than CLI for long sessions |
| **CLI `claude -p`** | Full CC harness, proven stability, all features | Process management overhead, output parsing |

**Recommendation:** Start with CLI `claude -p` for maximum feature parity with interactive CC. The CLI is the canonical CC experience. Switch to Agent SDK later if process management becomes painful.

**Key implementation details:**

```typescript
// Pseudocode for the CC session runner
import { spawn } from 'child_process';

async function runCCAgent(group, input): Promise<ContainerOutput> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const sessionDir = resolveGroupSessionPath(group.folder);

  const args = [
    '-p', input.prompt,
    '--output-format', 'stream-json',
    '--allowedTools', getAllowedTools(input.isMain, input.isTrusted),
    '--max-budget-usd', '2.00',
  ];

  // Session resume
  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  // Permission bypass for autonomous operation
  // (agents run without human approval — IPC handles authorization)
  args.push('--dangerously-skip-permissions');

  const proc = spawn('claude', args, {
    cwd: groupDir,           // CC reads CLAUDE.md from cwd
    env: {
      ...process.env,
      HOME: sessionDir,      // .claude/ lives here (auto-memory, settings)
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    },
  });

  // Stream NDJSON output, extract result and session ID
  // ...
}
```

**What replaces container mounts:**

| Current mount | CC equivalent |
|---------------|---------------|
| Group folder → `/workspace/group` | CC's `cwd` set to group folder |
| `.claude/` → `/home/node/.claude` | `HOME` env var points to group session dir |
| Skills → `.claude/skills/` | Already synced to group session dir (no change) |
| IPC dir → `/workspace/ipc` | MCP server registered in group `.mcp.json` (see Phase 2) |
| Project root (read-only, main only) | CC can read any file on host (no isolation) |
| Knowledge vaults | CC can access directly via filesystem (no mount needed) |
| Global memory | CC reads CLAUDE.md from additional directories |

**Allowed tools by privilege level:**

| Privilege | Allowed tools |
|-----------|---------------|
| Main (PA) | All (Read, Edit, Write, Bash, Glob, Grep, Agent, web, MCP) |
| Trusted (Brain Router) | All except destructive Bash patterns |
| Standard (project agents) | Read, Edit, Write, Bash, Glob, Grep, Agent, web, MCP — scoped by CLAUDE.md instructions |

Note: Without container isolation, filesystem scoping is advisory (via CLAUDE.md instructions telling the agent its boundaries) rather than enforced. This is the accepted tradeoff.

### Phase 2: IPC as MCP Server

**Objective:** Make NanoClaw's IPC tools (send_message, schedule_task, execute_in_group, search vaults) available to CC sessions as an MCP server.

Currently, IPC tools are defined in `container/agent-runner/src/ipc-mcp-stdio.ts` and run inside the container as a stdio MCP server that the Agent SDK connects to. The tools write JSON files to an IPC directory, which the host's IPC watcher polls.

**For CC sessions, two options:**

**Option A: Keep file-based IPC, register as MCP server in `.mcp.json`**

The existing `ipc-mcp-stdio.ts` already IS an MCP server. Register it in each group's `.mcp.json`:

```json
{
  "mcpServers": {
    "nanoclaw": {
      "command": "node",
      "args": ["/path/to/nanoclaw/dist/ipc-mcp-server.js"],
      "env": {
        "NANOCLAW_IPC_DIR": "/path/to/data/ipc/{group-folder}",
        "NANOCLAW_CHAT_JID": "{jid}",
        "NANOCLAW_GROUP_FOLDER": "{folder}",
        "NANOCLAW_IS_MAIN": "0",
        "NANOCLAW_IS_TRUSTED": "0"
      }
    }
  }
}
```

CC spawns this MCP server automatically. The IPC watcher on the host side remains unchanged. This is the lowest-effort path — you're literally reusing the existing MCP server.

**Option B: HTTP-based IPC**

Replace file-based IPC with HTTP calls to the orchestrator. The MCP server calls `http://localhost:{port}/ipc/{operation}` instead of writing files. The orchestrator handles requests directly instead of polling.

More efficient but more work. Save for later.

**Recommendation:** Option A. Reuse the existing IPC MCP server. It already works. The only change is how it's registered (`.mcp.json` instead of container stdio inheritance).

### Phase 3: Per-Group .mcp.json Generation

**Objective:** Dynamically generate `.mcp.json` for each group before spawning its CC session.

Each group needs:
1. The NanoClaw IPC MCP server (Phase 2)
2. Any group-specific MCP servers (e.g., browser tools, custom integrations)
3. Channel-appropriate tools

```typescript
function generateGroupMcpConfig(group, input) {
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [path.join(process.cwd(), 'dist', 'ipc-mcp-server.js')],
        env: {
          NANOCLAW_IPC_DIR: resolveGroupIpcPath(group.folder),
          NANOCLAW_CHAT_JID: input.chatJid,
          NANOCLAW_GROUP_FOLDER: input.groupFolder,
          NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
          NANOCLAW_IS_TRUSTED: input.isTrusted ? '1' : '0',
        },
      },
    },
  };

  // Write to group's working directory
  fs.writeFileSync(
    path.join(resolveGroupFolderPath(group.folder), '.mcp.json'),
    JSON.stringify(config, null, 2),
  );
}
```

### Phase 4: Session Lifecycle Management

**Objective:** Manage CC session IDs for resume/fork, idle timeout, and concurrent session limits.

**Session tracking:**

```typescript
interface CCSession {
  groupFolder: string;
  sessionId: string;        // CC session ID for resume
  lastActivity: number;     // timestamp
  pid?: number;             // process ID if running
}

// Store in SQLite (reuse existing sessions table or add cc_sessions)
```

**Session resume flow:**
1. Message arrives for group
2. Look up last session ID for that group
3. Spawn CC with `--resume {sessionId}` to continue conversation
4. On completion, store new session ID (CC may rotate)

**Idle management:**
- CC sessions exit when the prompt completes (no idle concern with `-p` mode)
- Session state persists in `.jsonl` files — no need to keep processes alive
- This is simpler than current container idle timeout logic

**Concurrency:**
- Current system: one container per group at a time (enforced by orchestrator)
- CC sessions: same constraint, enforced the same way
- No change needed in the message loop's concurrency logic

### Phase 5: Credential Handling

**Objective:** Provide API credentials to CC sessions without the credential proxy.

**Current model:** Containers get a placeholder API key. A host-side HTTP proxy intercepts Anthropic API calls and injects the real key. Containers never see real credentials.

**CC model:** CC manages its own Anthropic authentication (API key or OAuth). No proxy needed for the primary AI call. For other credentials (Discord tokens, Gmail OAuth, etc.), two options:

1. **Environment variables:** Pass credentials via `env` in the spawn call. Simple but they're visible to the CC session (and any Bash commands it runs).

2. **MCP credential server:** An MCP server that exposes credentialed operations as tools without revealing the keys. E.g., `gmail_send(to, subject, body)` instead of giving the agent a Gmail token.

**Recommendation:** For the PA and Brain Router (trusted), pass credentials via env vars. For standard project agents, expose only the MCP tools they need — they shouldn't have raw API keys anyway.

### Phase 6: Output Parsing and Routing

**Objective:** Parse CC session output and route responses back through NanoClaw's message router.

**Current model:** Container stdout has `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` sentinels. The orchestrator parses between them and routes the response.

**CC model with `--output-format stream-json`:** Output is NDJSON with structured messages:

```json
{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}]}}
{"type": "result", "session_id": "...", "cost_usd": 0.05}
```

Parse the stream, extract assistant text messages, and feed them to the existing router. The `result` message gives you the session ID for future resume.

**Streaming IPC messages:** Currently, agents use `send_message` IPC to send intermediate messages while running. This continues to work unchanged — the IPC MCP server writes files, the host IPC watcher picks them up and routes them.

### Phase 7: Railway Deployment

**Objective:** Make CC-based agents work on Railway.

**Current Railway model:** No Docker-in-Docker. Agents run as child processes via `src/railway-runner.ts` using the Agent SDK directly.

**CC on Railway:** The `claude` CLI needs to be installed in the Railway container image. Add it to the Dockerfile:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Then `cc-session-runner.ts` works the same way on Railway as locally — spawns `claude -p` processes. No container-in-container issue.

**Authentication on Railway:** Use `ANTHROPIC_API_KEY` env var (already configured on Railway). CC picks this up automatically.

---

## Migration Path (Incremental)

The migration can be done group-by-group:

1. **Add `runtime` field to RegisteredGroup type:** `'container' | 'claude-code'`, default `'container'`
2. **Branch in runContainerAgent:** If `runtime === 'claude-code'`, use the new CC session runner. Otherwise, use the existing container runner.
3. **Migrate one standard project agent first** — low risk, easy to validate
4. **Migrate Brain Router** — test knowledge vault access, cross-group execution
5. **Migrate PA** — test full system admin capabilities
6. **Remove container runtime** — once all groups are on CC, remove `container-runner.ts`, `railway-runner.ts`, `container/` directory, Docker/Apple Container dependencies

```typescript
// src/index.ts or src/container-runner.ts
export async function runAgent(group, input, ...): Promise<ContainerOutput> {
  if (group.runtime === 'claude-code') {
    return runCCAgent(group, input, ...);   // new
  }
  if (IS_RAILWAY) {
    return runRailwayAgent(group, input, ...);
  }
  return runContainerAgent(group, input, ...); // existing
}
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CC session startup is slow (~2-5s vs container ~1s) | High | Low | Acceptable for async messaging. Not a real-time system. |
| `--dangerously-skip-permissions` flag changes or is removed | Medium | High | Monitor CC releases. Fallback: Agent SDK `query()` with `dangerouslySkipPermissions` option. |
| Agent reads/modifies files outside its group folder | Medium | Medium | CLAUDE.md instructions define boundaries. Accepted tradeoff. Add filesystem watcher as guardrail if needed. |
| CC CLI breaking changes | Medium | Medium | Pin CC version. Test before upgrading. |
| `stream-json` output format instability | Low | Medium | Known GitHub issue (#24594). Parse defensively. Fallback to `json` mode (non-streaming). |
| CC auto-memory conflicts between groups sharing same HOME | Low | High | Each group gets its own HOME dir (already the case with session dirs). No conflict. |

---

## Success Criteria

- [ ] A standard project agent runs as a CC session, receives messages, responds via router
- [ ] Brain Router runs as CC session, successfully routes to project agents via IPC
- [ ] PA runs as CC session with full system admin capabilities
- [ ] Session resume works — agent picks up conversation context across invocations
- [ ] IPC tools (send_message, schedule_task, execute_in_group, vault search) all work
- [ ] Task scheduler spawns CC-based agents on schedule
- [ ] CC auto-memory accumulates per-group knowledge across sessions
- [ ] Agents can use CC slash commands and skills natively
- [ ] Migration can be done one group at a time with both runtimes coexisting

---

## Dependencies

- Claude Code CLI installed on host (and Railway image)
- CC must support `--dangerously-skip-permissions` or equivalent for autonomous operation
- CC must support `--resume` for session continuity
- CC `stream-json` output format must be parseable (or fall back to `json`)
- MCP server registration via `.mcp.json` must work in `-p` mode

## Not In Scope

- Channels as a transport replacement for NanoClaw's channel registry (keep discord.js, grammy, etc.)
- Container isolation (accepted tradeoff)
- Remote Control / mobile access via Channels (orthogonal — can be added later)
- Railway deployment changes beyond adding `claude` to the Docker image
