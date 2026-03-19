/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const isTrusted = process.env.NANOCLAW_IS_TRUSTED === '1';

/** Check if this agent has elevated privileges (main or trusted). */
function hasElevatedPrivilege(): boolean {
  return isMain || isTrusted;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-elevated groups can only schedule for themselves
    const targetJid = hasElevatedPrivilege() && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = hasElevatedPrivilege()
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!hasElevatedPrivilege()) {
      return {
        content: [{ type: 'text' as const, text: 'Only elevated groups can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'execute_in_group',
  `Execute a prompt in another group's context. Main group only. The target group's agent will process the prompt as if it received a message.`,
  {
    target_group_folder: z.string().describe('Folder name of the target group (e.g., "discord_my-project")'),
    prompt: z.string().describe('The task prompt to execute in the target group'),
  },
  async (args) => {
    if (!hasElevatedPrivilege()) {
      return {
        content: [{ type: 'text' as const, text: 'Only elevated groups can execute in other groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'execute_in_group',
      target_group_folder: args.target_group_folder,
      prompt: args.prompt,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Execution request sent to group "${args.target_group_folder}".` }],
    };
  },
);

server.tool(
  'create_project',
  `Create a new project with its own Discord channel and group registration. Main group only. Automatically creates the Discord channel, registers the group, sets up the folder with CLAUDE.md from a template, and updates projects.yaml.`,
  {
    name: z.string().describe('Project display name'),
    slug: z.string().describe('URL-safe project identifier (lowercase, hyphens)'),
    type: z.enum(['code', 'planning', 'research', 'general']).describe('Project type'),
    brief: z.string().describe('One-line project description'),
    aliases: z.string().describe('Comma-separated list of aliases/keywords'),
  },
  async (args) => {
    if (!hasElevatedPrivilege()) {
      return {
        content: [{ type: 'text' as const, text: 'Only elevated groups can create projects.' }],
        isError: true,
      };
    }

    const data = {
      type: 'create_project',
      name: args.name,
      slug: args.slug,
      projectType: args.type,
      brief: args.brief,
      aliases: args.aliases,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Project "${args.name}" creation requested. Watch for confirmation message.` }],
    };
  },
);

server.tool(
  'search_public_knowledge',
  `Search the public knowledge repository using qmd. Returns relevant documents and snippets. Only use when the user explicitly asks to search or pull from the public knowledge base.

Search types:
• lex: Exact terms, keywords, names (e.g., "competitor pricing", "\"Acme Corp\"")
• vec: Natural language questions (e.g., "what pricing strategies are competitors using")
• hyde: Hypothetical answer text (e.g., "competitors charge $25-35 per seat")

Combine multiple search types for best recall. The first search gets 2x weight.`,
  {
    searches: z.array(z.object({
      type: z.enum(['lex', 'vec', 'hyde']).describe('Search type'),
      query: z.string().describe('Search query'),
    })).describe('Array of search objects'),
    intent: z.string().optional().describe('Disambiguation hint when query terms are ambiguous'),
    limit: z.number().optional().describe('Max results to return (default: 10)'),
  },
  async (args) => {
    const taskId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'search_public_knowledge',
      searches: args.searches,
      intent: args.intent,
      limit: args.limit || 10,
      resultId: taskId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for result in IPC input directory
    const resultPath = path.join(IPC_DIR, 'input', `result-${taskId}.json`);
    const maxWait = 15000;
    const pollInterval = 200;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          if (result.success) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.results, null, 2) }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: result.error || 'Search failed' }],
              isError: true,
            };
          }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading search results: ${err}` }],
            isError: true,
          };
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: 'Public knowledge search timed out — is qmd running on the host?' }],
      isError: true,
    };
  },
);

server.tool(
  'reindex_public_knowledge',
  'Trigger re-indexing of the public knowledge repository after adding or updating files. Runs in background (fire-and-forget). Main group only.',
  {},
  async () => {
    if (!hasElevatedPrivilege()) {
      return {
        content: [{ type: 'text' as const, text: 'Only elevated groups can trigger reindex.' }],
        isError: true,
      };
    }

    const data = {
      type: 'reindex_public_knowledge',
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Reindex started in background.' }],
    };
  },
);

server.tool(
  'search_second_brain',
  `Search the Second Brain personal vault using qmd. Returns relevant documents and snippets. Only use when the user explicitly asks to search or pull from the Second Brain.

Search types:
• lex: Exact terms, keywords, names
• vec: Natural language questions
• hyde: Hypothetical answer text

Combine multiple search types for best recall. The first search gets 2x weight.`,
  {
    searches: z.array(z.object({
      type: z.enum(['lex', 'vec', 'hyde']).describe('Search type'),
      query: z.string().describe('Search query'),
    })).describe('Array of search objects'),
    intent: z.string().optional().describe('Disambiguation hint when query terms are ambiguous'),
    limit: z.number().optional().describe('Max results to return (default: 10)'),
  },
  async (args) => {
    const taskId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'search_second_brain',
      searches: args.searches,
      intent: args.intent,
      limit: args.limit || 10,
      resultId: taskId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const resultPath = path.join(IPC_DIR, 'input', `result-${taskId}.json`);
    const maxWait = 15000;
    const pollInterval = 200;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          if (result.success) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.results, null, 2) }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: result.error || 'Search failed' }],
              isError: true,
            };
          }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading search results: ${err}` }],
            isError: true,
          };
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: 'Second Brain search timed out — is qmd running on the host?' }],
      isError: true,
    };
  },
);

server.tool(
  'search_second_brain_recent',
  `Search dated notes in the Second Brain within a specific date window. This is the preferred tool for time-bounded questions like "past week", "today", or "this month".

Use this before qmd when the user asks for recent thoughts, journals, meetings, or notes in a defined time range.

The host scans markdown files directly, filters by note date, and returns only in-range matches.`,
  {
    query: z.string().describe('Natural-language search query'),
    start_date: z.string().describe('Inclusive start date in YYYY-MM-DD format'),
    end_date: z.string().describe('Inclusive end date in YYYY-MM-DD format'),
    terms: z
      .array(z.string())
      .optional()
      .describe(
        'Optional lexical terms or synonyms to match directly in recent notes',
      ),
    limit: z.number().optional().describe('Max results to return (default: 10)'),
  },
  async (args) => {
    const taskId = `recent-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'search_second_brain_recent',
      query: args.query,
      start_date: args.start_date,
      end_date: args.end_date,
      terms: args.terms,
      limit: args.limit || 10,
      resultId: taskId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const resultPath = path.join(IPC_DIR, 'input', `result-${taskId}.json`);
    const maxWait = 30000;
    const pollInterval = 200;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          if (result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result.results, null, 2),
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: result.error || 'Recent search failed',
                },
              ],
              isError: true,
            };
          }
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error reading recent search results: ${err}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Recent Second Brain search timed out on the host.',
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'reindex_second_brain',
  'Trigger re-indexing of the Second Brain vault after adding or updating files. Runs in background (fire-and-forget). Main group only.',
  {},
  async () => {
    if (!hasElevatedPrivilege()) {
      return {
        content: [{ type: 'text' as const, text: 'Only elevated groups can trigger reindex.' }],
        isError: true,
      };
    }

    const data = {
      type: 'reindex_second_brain',
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Second Brain reindex started in background.' }],
    };
  },
);

server.tool(
  'push_changes',
  `Push file changes to the NanoClaw GitHub repository. Main group only.

On Railway, uses the GitHub API to create commits directly. Locally, uses git CLI.
The default target branch comes from the host environment. Railway deployments
can also require PR-only mode, in which case direct pushes are rejected unless
create_pr=true is set.
Set create_pr=true to create a pull request instead for human review.

Use this for:
- Fixing configuration issues (CLAUDE.md, projects.yaml)
- Adding new skills or templates
- Modifying agent behavior or system architecture

IMPORTANT: Only push changes you are confident about. Direct pushes on
production Railway environments may trigger a redeploy.`,
  {
    files: z.array(z.object({
      path: z.string().describe('File path relative to repo root (e.g., "groups/main/CLAUDE.md")'),
      content: z.string().describe('Full file content to write'),
    })).describe('Files to create or update'),
    commit_message: z.string().describe('Git commit message describing the change'),
    create_pr: z.boolean().optional().describe('If true, create a PR instead of pushing directly (default: false)'),
    pr_title: z.string().optional().describe('PR title (defaults to commit message)'),
    pr_body: z.string().optional().describe('PR description'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can push changes.' }],
        isError: true,
      };
    }

    const data = {
      type: 'push_changes',
      files: args.files,
      commitMessage: args.commit_message,
      createPr: args.create_pr || false,
      prTitle: args.pr_title,
      prBody: args.pr_body,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const action = args.create_pr ? 'PR creation' : 'push';
    return {
      content: [{ type: 'text' as const, text: `Changes ${action} requested for ${args.files.length} file(s). Watch for confirmation.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
