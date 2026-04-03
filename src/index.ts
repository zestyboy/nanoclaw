import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  IS_RAILWAY,
  MAX_MESSAGES_PER_PROMPT,
  NANOCLAW_MODEL,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
  SlashCommandMeta,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import {
  getAllChats,
  getAllRegisteredGroups,
  deleteSessionMetrics,
  deleteSession,
  getAllSessions,
  getAllTasks,
  getGroupEffort,
  getLastBotMessageTimestamp,
  getSessionMetrics,
  getMessagesSince,
  getNewMessages,
  deleteRegisteredGroup,
  getRegisteredGroup,
  getRouterState,
  getSessionHistory,
  getTasksForGroup,
  initDatabase,
  recordSessionHistory,
  renameSession,
  setGroupEffort,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  touchSessionHistory,
  upsertSessionMetrics,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  scheduleCanonicalSnapshot,
  startStateSnapshotLoop,
} from './state-backup.js';
import {
  cleanupExpiredMirrors,
  getMirrorsForSource,
  recordInbound,
  recordOutbound,
} from './mirror.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { loadStateManifest } from './state-manifest.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  collectSessionWarnings,
  formatContextReport,
  formatTokenCount,
  getConfirmedModel,
  mergeWarnedThresholds,
} from './session-health.js';
import {
  formatSessionHistoryLabel,
  sanitizeSessionHistoryPrompt,
} from './session-history-label.js';
import { refreshSessionMetrics } from './session-metrics.js';
import {
  clearActiveSession,
  resetGroupSessionFilesystem,
} from './session-clear.js';
import {
  findSkillByName,
  formatSkillInlineToken,
  listSkills,
  parseInlineSkillRefs,
  searchSkills,
  suggestSkill,
} from './skills.js';

const execAsync = promisify(execCb);

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
const sessionCosts: Record<string, { tokens: number; cost: number }> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let activeReplySourceJids: Record<string, string | undefined> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// OneCLI is only used locally (not on Railway, which uses credential proxy)
const onecli = IS_RAILWAY ? null : new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (!onecli || group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function clearSessionState(groupFolder: string): void {
  delete sessions[groupFolder];
  deleteSession(groupFolder);
  deleteSessionMetrics(groupFolder);
}

function describeSkillReferenceFeedback(text: string): string | null {
  const parsed = parseInlineSkillRefs(text);
  if (parsed.references.length === 0) return null;

  const lines: string[] = [];

  if (parsed.resolved.length > 0) {
    lines.push(
      `Skills detected: ${parsed.resolved.map((skill) => skill.name).join(', ')}`,
    );
  }

  for (const unresolved of parsed.unresolved) {
    lines.push(`Unknown skill: ${unresolved.reference.raw}`);
    if (unresolved.suggestion) {
      lines.push(
        `Did you mean: ${formatSkillInlineToken(unresolved.suggestion.name)}`,
      );
    }
  }

  return lines.join('\n');
}

function collectSkillRefsForMessages(messages: NewMessage[]): {
  resolved: string[];
} {
  const resolvedNames = new Set<string>();

  for (const message of messages) {
    const parsed = parseInlineSkillRefs(message.content);
    for (const skill of parsed.resolved) {
      resolvedNames.add(skill.name);
    }
  }

  return { resolved: [...resolvedNames] };
}

function prependSkillInstructions(
  prompt: string,
  skillNames: string[],
): string {
  if (skillNames.length === 0) return prompt;

  const lines = [
    '<skill-invocation>',
    'The user explicitly referenced these skills. Load and follow them for this task if they are available in the current environment:',
    ...skillNames.map((name) => `- ${name}`),
    '</skill-invocation>',
  ];

  return `${lines.join('\n')}\n${prompt}`;
}

function formatSkillAwarePrompt(
  messages: NewMessage[],
  timezone: string,
): string {
  const prompt = formatMessages(messages, timezone);
  const { resolved } = collectSkillRefsForMessages(messages);
  return prependSkillInstructions(prompt, resolved);
}

function formatSkillsListPages(): string[] {
  const skills = listSkills();
  if (skills.length === 0) {
    return ['No skills installed.'];
  }

  // Split across multiple messages to fit Discord's 2000-char limit
  const maxLen = 1900;
  const pages: string[] = [];
  let current = `**Available skills (${skills.length}):**\n`;

  for (const skill of skills) {
    const tag =
      skill.package === '.system'
        ? 'codex-builtin'
        : skill.package
          ? skill.package
          : skill.source === 'container'
            ? 'built-in'
            : null;
    const label = tag
      ? `• **${skill.name}** (${tag}) — ${skill.description.slice(0, 70)}\n`
      : `• **${skill.name}** — ${skill.description.slice(0, 80)}\n`;
    if (current.length + label.length > maxLen) {
      pages.push(current.trimEnd());
      current = '';
    }
    current += label;
  }
  if (current.trim()) {
    pages.push(current.trimEnd());
  }

  return pages;
}

function formatSkillsSearchResponse(query: string): string {
  const matches = searchSkills(query).slice(0, 8);
  if (matches.length === 0) {
    return `No skills matched "${query}".`;
  }

  const lines = matches.map(
    (skill) =>
      `• **${skill.name}** — ${skill.description.slice(0, 120)}\n  Inline token: \`${formatSkillInlineToken(skill.name)}\``,
  );

  return `**Matching skills for "${query}":**\n${lines.join('\n')}`;
}

function buildSlashSkillRunMessage(
  group: RegisteredGroup,
  skillName: string,
  task?: string,
): string {
  const body = task?.trim()
    ? `Use ${formatSkillInlineToken(skillName)} for this task: ${task.trim()}`
    : `Use ${formatSkillInlineToken(skillName)} for this task.`;

  if (!group.isMain && group.requiresTrigger !== false) {
    return `${group.trigger} ${body}`.trim();
  }

  return body;
}

async function sendSessionWarnings(
  chatJid: string,
  groupFolder: string,
): Promise<void> {
  const metrics = getSessionMetrics(groupFolder);
  if (!metrics) return;

  const warnings = collectSessionWarnings(metrics);
  if (warnings.length === 0) return;

  for (const warning of warnings) {
    await sendWithMirror(chatJid, warning.message);
  }

  const allKeys = warnings.flatMap((w) => [w.key, ...(w.extraKeys || [])]);
  upsertSessionMetrics(groupFolder, {
    warned_thresholds: mergeWarnedThresholds(metrics, allKeys),
  });
}

function logStateSummary(): void {
  const manifest = loadStateManifest();
  const qmdStates = Object.entries(manifest.qmd.collections).map(
    ([name, state]) => `${name}:${state.status}`,
  );
  logger.info(
    {
      schemaVersion: manifest.schemaVersion,
      database: manifest.database.status,
      publicKnowledge: manifest.vaults['public-knowledge']?.status,
      secondBrain: manifest.vaults['second-brain']?.status,
      qmd: qmdStates.join(',') || 'none',
      lastSnapshot: manifest.snapshots.lastSuccessful?.createdAt || null,
    },
    'State summary',
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  scheduleCanonicalSnapshot('register-group');

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Send a bot message and mirror it to any active mirror targets.
 * User message mirroring is handled separately in the onMessage callback.
 */
async function sendWithMirror(jid: string, text: string): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot send message');
    return;
  }

  await channel.sendMessage(jid, text);

  // Record in ring buffer for retroactive lookback
  recordOutbound(jid, text);

  // Send to any active mirror targets
  const activeMirrors = getMirrorsForSource(jid);
  for (const mirror of activeMirrors) {
    const targetChannel = findChannel(channels, mirror.targetJid);
    if (!targetChannel) {
      logger.warn(
        { targetJid: mirror.targetJid },
        'Mirror target channel not found',
      );
      continue;
    }
    try {
      await targetChannel.sendMessage(mirror.targetJid, text, {
        silent: true,
      });
    } catch (err) {
      logger.warn(
        { err, targetJid: mirror.targetJid },
        'Failed to send mirror message',
      );
    }
  }
}

function extractReplySourceChannelJid(
  messages: NewMessage[],
): string | undefined {
  const latestMessage = messages[messages.length - 1];
  const match = latestMessage?.content.match(
    /^<source_channel jid="([^"]+)" \/>/,
  );
  return match?.[1];
}

/** @internal - exported for testing */
export function _getAgentReplyTargets(
  chatJid: string,
  replyToSourceJid?: string,
): string[] {
  if (replyToSourceJid && replyToSourceJid !== chatJid) {
    return [replyToSourceJid];
  }
  return [chatJid];
}

/** @internal - exported for testing */
export function _extractReplySourceChannelJid(
  messages: Pick<NewMessage, 'content'>[],
): string | undefined {
  return extractReplySourceChannelJid(messages as NewMessage[]);
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const isTrustedGroup = group.trusted === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  activeReplySourceJids[chatJid] = extractReplySourceChannelJid(missedMessages);
  const prompt = formatSkillAwarePrompt(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  refreshSessionMetrics(group.folder, sessions[group.folder]);
  await sendSessionWarnings(chatJid, group.folder);

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    refreshSessionMetrics(group.folder, result.newSessionId, result);
    await sendSessionWarnings(chatJid, group.folder);

    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        const replyTargets = _getAgentReplyTargets(
          chatJid,
          activeReplySourceJids[chatJid],
        );
        for (const targetJid of replyTargets) {
          await sendWithMirror(targetJid, text);
        }
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    delete activeReplySourceJids[chatJid];
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const isTrusted = group.trusted === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    isTrusted,
  );

  // Update available groups snapshot (elevated groups can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
    isTrusted,
  );

  // Wrap onOutput to track session ID, cost, and control responses
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
          recordSessionHistory(
            group.folder,
            output.newSessionId,
            sanitizeSessionHistoryPrompt(prompt)?.slice(0, 200),
          );
        }
        if (output.usage) {
          const cost = sessionCosts[group.folder] || { tokens: 0, cost: 0 };
          cost.cost = output.usage.totalCostUsd;
          cost.tokens += output.usage.inputTokens + output.usage.outputTokens;
          sessionCosts[group.folder] = cost;
        }
        if (output.controlResponse?.type === 'branch') {
          const branchSessionId = output.controlResponse.sessionId as string;
          const branchTitle =
            (output.controlResponse.title as string) || undefined;
          if (branchSessionId) {
            recordSessionHistory(group.folder, branchSessionId, branchTitle);
            if (branchTitle) {
              renameSession(group.folder, branchSessionId, branchTitle);
            }
            logger.info(
              {
                group: group.name,
                sessionId: branchSessionId,
                title: branchTitle,
              },
              'Session branched via IPC',
            );
          }
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const effortLevel = getGroupEffort(group.folder) || undefined;
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isTrusted,
        assistantName: ASSISTANT_NAME,
        effortLevel,
        model: NANOCLAW_MODEL,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    refreshSessionMetrics(
      group.folder,
      output.newSessionId ?? sessionId,
      output,
    );

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Handle /clear command — reset session without spawning a container
          const clearMsg = groupMessages.find(
            (m) => m.content.trim().toLowerCase() === '/clear',
          );
          if (clearMsg) {
            clearActiveSession(
              {
                chatJid,
                groupFolder: group.folder,
                timestamp: clearMsg.timestamp,
              },
              {
                closeStdin: (jid) => queue.closeStdin(jid),
                clearSessionState,
                resetSessionFilesystem: resetGroupSessionFilesystem,
                saveState,
                setLastAgentTimestamp: (jid, timestamp) => {
                  lastAgentTimestamp[jid] = timestamp;
                },
              },
            );
            channel
              .sendMessage(chatJid, 'Session cleared.')
              .catch((err) =>
                logger.warn(
                  { chatJid, err },
                  'Failed to send /clear confirmation',
                ),
              );
            logger.info(
              { group: group.name },
              'Session cleared via /clear command',
            );
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          activeReplySourceJids[chatJid] =
            extractReplySourceChannelJid(messagesToSend);
          const formatted = formatSkillAwarePrompt(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  if (IS_RAILWAY) {
    logger.info('Running on Railway — skipping container runtime checks');
    return;
  }
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  logStateSummary();
  startStateSnapshotLoop();

  // Periodically clean up expired message mirrors
  setInterval(() => cleanupExpiredMirrors(), 60_000);

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // On Railway, start the credential proxy so child-process agents get API credentials.
  // Locally, OneCLI handles credential injection instead.
  let proxyServer: import('http').Server | undefined;
  if (IS_RAILWAY) {
    const { startCredentialProxy } = await import('./credential-proxy.js');
    proxyServer = await startCredentialProxy(
      CREDENTIAL_PROXY_PORT,
      '127.0.0.1',
    );
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer?.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      if (!msg.is_from_me && !msg.is_bot_message && chatJid.startsWith('dc:')) {
        const feedback = describeSkillReferenceFeedback(msg.content);
        if (feedback) {
          const channel = findChannel(channels, chatJid);
          if (channel) {
            channel
              .sendMessage(chatJid, feedback, { silent: true })
              .catch((err) =>
                logger.warn(
                  { chatJid, err },
                  'Failed to send Discord skill recognition feedback',
                ),
              );
          }
        }
      }

      // Mirror user messages to active mirror targets
      if (!msg.is_from_me && !msg.is_bot_message) {
        recordInbound(chatJid, msg.content, msg.sender_name);
        const activeMirrors = getMirrorsForSource(chatJid);
        for (const mirror of activeMirrors) {
          const targetChannel = findChannel(channels, mirror.targetJid);
          if (targetChannel) {
            const mirrorText = `**${msg.sender_name}**: ${msg.content}`;
            targetChannel
              .sendMessage(mirror.targetJid, mirrorText, { silent: true })
              .catch((err) =>
                logger.warn(
                  { err, targetJid: mirror.targetJid },
                  'Failed to mirror user message',
                ),
              );
          }
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onSlashCommand: (
      chatJid: string,
      command: string,
      args: string,
      meta: SlashCommandMeta | undefined,
      respond: (text: string) => Promise<void>,
    ) => {
      const group = registeredGroups[chatJid];
      if (!group) {
        respond('This channel is not registered.').catch(() => {});
        return;
      }

      if (command === 'compact') {
        // Inject /compact as a synthetic message so the session command
        // interception flow handles it (auth, pre-compact processing, SDK call).
        const compactText = args.trim()
          ? `/compact ${args.trim()}`
          : '/compact';
        queue.closeStdin(chatJid);
        const now = new Date().toISOString();
        storeMessage({
          id: `compact-${Date.now()}`,
          chat_jid: chatJid,
          sender: 'me',
          sender_name: 'me',
          content: compactText,
          timestamp: now,
          is_from_me: true,
        });
        queue.enqueueMessageCheck(chatJid);
        respond('Compacting session...').catch(() => {});
        return;
      }

      if (command === 'clear') {
        clearActiveSession(
          {
            chatJid,
            groupFolder: group.folder,
            timestamp: new Date().toISOString(),
          },
          {
            closeStdin: (jid) => queue.closeStdin(jid),
            clearSessionState,
            resetSessionFilesystem: resetGroupSessionFilesystem,
            saveState,
            setLastAgentTimestamp: (jid, timestamp) => {
              lastAgentTimestamp[jid] = timestamp;
            },
          },
        );
        respond('Session cleared.').catch((err) =>
          logger.warn(
            { chatJid, err },
            'Failed to respond to /clear slash command',
          ),
        );
        logger.info({ group: group.name }, 'Session cleared via slash command');
        return;
      }

      if (command === 'context') {
        const metrics = refreshSessionMetrics(
          group.folder,
          sessions[group.folder],
        );
        const effort = getGroupEffort(group.folder) || 'medium';
        const contextLines = [`Effort: **${effort}**`];
        if (metrics) {
          contextLines.push(formatContextReport(metrics));
        } else {
          const requested = NANOCLAW_MODEL || 'sonnet';
          contextLines.unshift(
            `Model: **${requested}** (requested, no API data yet)`,
          );
          contextLines.push(
            'No active session metrics yet. Send a message first.',
          );
        }
        respond(contextLines.join('\n')).catch((err) =>
          logger.warn(
            { chatJid, err },
            'Failed to respond to /context slash command',
          ),
        );
        return;
      }

      if (command === 'model') {
        const metrics = getSessionMetrics(group.folder);
        const confirmed = getConfirmedModel(metrics);
        const effort = getGroupEffort(group.folder) || 'medium';
        if (confirmed) {
          respond(
            `Model: **${confirmed.model}**\nContext Window: **${formatTokenCount(confirmed.contextWindow)}**\nEffort: **${effort}**`,
          ).catch(() => {});
        } else {
          const requested = NANOCLAW_MODEL || 'sonnet';
          respond(
            `Model: **${requested}** (requested, no API data yet)\nEffort: **${effort}**\nSend a message first to confirm model from API.`,
          ).catch(() => {});
        }
        return;
      }

      // --- Phase 1: Quick wins ---

      if (command === 'reload') {
        queue.closeStdin(chatJid);
        respond('Reloading. Send a message to continue.').catch((err) =>
          logger.warn({ chatJid, err }, 'Failed to respond to /reload'),
        );
        logger.info(
          { group: group.name },
          'Reload triggered via slash command',
        );
        return;
      }

      if (command === 'cost') {
        const cost = sessionCosts[group.folder];
        respond(
          cost
            ? `Session: ${cost.tokens.toLocaleString()} tokens, $${cost.cost.toFixed(4)}`
            : 'No cost data yet.',
        ).catch((err) =>
          logger.warn({ chatJid, err }, 'Failed to respond to /cost'),
        );
        return;
      }

      if (command === 'diff') {
        const groupPath = path.join(GROUPS_DIR, group.folder);
        execAsync(`git -C "${groupPath}" diff --stat`, { timeout: 5000 })
          .then(({ stdout }) =>
            respond(stdout.trim() || 'No uncommitted changes.'),
          )
          .catch(() => respond('Not a git repository or git error.'))
          .catch(() => {});
        return;
      }

      if (command === 'export') {
        const convDir = path.join(GROUPS_DIR, group.folder, 'conversations');
        try {
          if (!fs.existsSync(convDir)) {
            respond('No conversations archived yet.').catch(() => {});
            return;
          }
          const files = fs
            .readdirSync(convDir)
            .filter((f) => f.endsWith('.md'))
            .sort()
            .reverse();
          if (files.length === 0) {
            respond('No conversations archived yet.').catch(() => {});
            return;
          }
          const latest = fs.readFileSync(path.join(convDir, files[0]), 'utf-8');
          // Truncate for Discord's 2000 char limit on ephemeral replies
          const truncated =
            latest.length > 1900
              ? latest.slice(0, 1900) + '\n\n... (truncated)'
              : latest;
          respond(truncated).catch(() => {});
        } catch {
          respond('Failed to read conversations.').catch(() => {});
        }
        return;
      }

      if (command === 'tasks') {
        const tasks = getTasksForGroup(group.folder);
        if (tasks.length === 0) {
          respond('No scheduled tasks.').catch(() => {});
          return;
        }
        const formatted = tasks
          .map(
            (t) =>
              `• **${t.prompt.slice(0, 60)}** (${t.status}) — ${t.schedule_type}: ${t.schedule_value}`,
          )
          .join('\n');
        respond(formatted).catch(() => {});
        return;
      }

      // --- Phase 2: Session management ---

      if (command === 'rename') {
        const sessionId = sessions[group.folder];
        if (!sessionId) {
          respond('No active session.').catch(() => {});
          return;
        }
        let name = args.trim();
        if (!name) {
          // Auto-generate from first prompt or session history
          const history = getSessionHistory(group.folder);
          const entry = history.find((h) => h.session_id === sessionId);
          const source = entry?.first_prompt || entry?.summary || '';
          name = source.replace(/\s+/g, ' ').slice(0, 50).trim();
          if (!name) {
            name = `session-${sessionId.slice(0, 8)}`;
          }
        }
        renameSession(group.folder, sessionId, name);
        respond(`Session renamed to "${name}".`).catch(() => {});
        logger.info({ group: group.name, name }, 'Session renamed');
        return;
      }

      if (command === 'resume') {
        if (!args.trim()) {
          // List sessions
          const history = getSessionHistory(group.folder);
          if (history.length === 0) {
            respond('No session history.').catch(() => {});
            return;
          }
          const activeSessionId = sessions[group.folder];
          const lines = history.map((h, i) => {
            const active = h.session_id === activeSessionId ? ' ← active' : '';
            const name = formatSessionHistoryLabel(h);
            const date = h.last_used.split('T')[0];
            return `${i + 1}. **${name}** (${date})${active}`;
          });
          respond(lines.join('\n')).catch(() => {});
          return;
        }
        // Switch to session by number or name
        const history = getSessionHistory(group.folder);
        const idx = parseInt(args.trim(), 10);
        let target: (typeof history)[0] | undefined;
        if (!isNaN(idx) && idx >= 1 && idx <= history.length) {
          target = history[idx - 1];
        } else {
          target = history.find(
            (h) =>
              h.name?.toLowerCase() === args.trim().toLowerCase() ||
              h.session_id.startsWith(args.trim()),
          );
        }
        if (!target) {
          respond(`Session not found: "${args.trim()}"`).catch(() => {});
          return;
        }
        // Close active container, switch session
        queue.closeStdin(chatJid);
        sessions[group.folder] = target.session_id;
        setSession(group.folder, target.session_id);
        touchSessionHistory(target.session_id);
        const displayName = target.name || target.session_id.slice(0, 8);
        respond(`Switched to session: ${displayName}`).catch(() => {});
        logger.info(
          { group: group.name, sessionId: target.session_id },
          'Session switched via /resume',
        );
        return;
      }

      if (command === 'effort') {
        const validLevels = ['low', 'medium', 'high', 'max'];
        const level = args.trim().toLowerCase();
        if (!level) {
          const current = getGroupEffort(group.folder) || 'medium';
          const model = NANOCLAW_MODEL || 'sonnet';
          respond(
            `Model: **${model}**\nEffort: **${current}**\nAvailable: ${validLevels.join(', ')}`,
          ).catch(() => {});
          return;
        }
        if (!validLevels.includes(level)) {
          respond(`Invalid effort level. Use: ${validLevels.join(', ')}`).catch(
            () => {},
          );
          return;
        }
        setGroupEffort(group.folder, level);
        respond(`Effort set to: ${level}`).catch(() => {});
        logger.info(
          { group: group.name, effort: level },
          'Effort level changed',
        );
        return;
      }

      if (command === 'hooks') {
        // Show active hook configurations
        const hooks: string[] = [];
        hooks.push(
          '• **PreCompact** — Archives conversation transcript before compaction',
        );

        // Check for group-level hooks in CLAUDE.md
        const groupClaudeMd = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
        if (fs.existsSync(groupClaudeMd)) {
          const content = fs.readFileSync(groupClaudeMd, 'utf-8');
          const hookMatches = content.match(/^#+.*hook/gim);
          if (hookMatches) {
            hooks.push(
              `• **Group CLAUDE.md** — ${hookMatches.length} hook section(s) defined`,
            );
          }
        }

        // Check for MCP server (always active)
        hooks.push(
          '• **MCP nanoclaw** — IPC tools for task scheduling, knowledge, and browser',
        );

        respond(`**Active hooks:**\n${hooks.join('\n')}`).catch(() => {});
        return;
      }

      if (command === 'skills') {
        const subcommand = meta?.subcommand || 'list';

        if (subcommand === 'list') {
          const pages = formatSkillsListPages();
          respond(pages[0]).catch(() => {});
          // Send additional pages as follow-up channel messages
          for (let i = 1; i < pages.length; i++) {
            sendWithMirror(chatJid, pages[i]).catch(() => {});
          }
          return;
        }

        if (subcommand === 'search') {
          const query = meta?.options?.query?.trim() || args.trim();
          if (!query) {
            respond(
              'Provide a query, for example `/skills search query:rail`.',
            ).catch(() => {});
            return;
          }
          respond(formatSkillsSearchResponse(query)).catch(() => {});
          return;
        }

        if (subcommand === 'run') {
          const skillName = meta?.options?.name?.trim() || args.trim();
          const task = meta?.options?.task?.trim();
          const skill = skillName ? findSkillByName(skillName) : null;

          if (!skill) {
            const suggestion = skillName ? suggestSkill(skillName) : null;
            respond(
              suggestion
                ? `Unknown skill: ${formatSkillInlineToken(skillName)}\nDid you mean: ${formatSkillInlineToken(suggestion.name)}`
                : 'Select a valid skill name.',
            ).catch(() => {});
            return;
          }

          storeMessage({
            id: `skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: chatJid,
            sender: 'me',
            sender_name: 'me',
            content: buildSlashSkillRunMessage(group, skill.name, task),
            timestamp: new Date().toISOString(),
            is_from_me: true,
          });
          queue.enqueueMessageCheck(chatJid);
          respond(
            `Queued ${formatSkillInlineToken(skill.name)}${task ? ` for: ${task}` : ''}`,
          ).catch(() => {});
          return;
        }

        respond(`Unknown /skills subcommand: ${subcommand}`).catch(() => {});
        return;
      }

      if (command === 'branch') {
        const sessionId = sessions[group.folder];
        if (!sessionId) {
          respond('No active session to branch.').catch(() => {});
          return;
        }
        const title = args.trim() || undefined;
        const sent = queue.sendControl(chatJid, {
          type: 'branch',
          sessionId,
          title,
        });
        if (sent) {
          respond(
            title ? `Creating branch "${title}"...` : 'Creating branch...',
          ).catch(() => {});
        } else {
          respond(
            'Cannot branch — no active container. Send a message first to start a session.',
          ).catch(() => {});
        }
        return;
      }

      // --- Phase 3: File rewind ---

      if (command === 'rewind') {
        const sent = queue.sendControl(chatJid, { type: 'rewind' });
        if (sent) {
          respond('Reverting file changes...').catch(() => {});
        } else {
          // No active container — rewind directly on host
          const groupPath = path.join(GROUPS_DIR, group.folder);
          execAsync(
            `git -C "${groupPath}" checkout . && git -C "${groupPath}" clean -fd`,
            {
              timeout: 5000,
            },
          )
            .then(() => respond('File changes reverted.'))
            .catch(() => respond('No active session or not a git repository.'))
            .catch(() => {});
        }
        return;
      }

      // Brain Router passthrough commands — inject as a prefixed message
      // into the main group for the Brain Router to classify.
      const passthroughCommands = [
        'catalog',
        'execute',
        'knowledge',
        'second-brain',
        'ask',
        'do',
      ];
      if (passthroughCommands.includes(command)) {
        // Find the Brain Router group — prefer trusted group (Brain Router)
        // over isMain (PA) since the Brain Router prompt handles intent routing.
        const routerEntry =
          Object.entries(registeredGroups).find(
            ([, g]) => g.folder === 'brain-router',
          ) ||
          Object.entries(registeredGroups).find(
            ([, g]) => g.trusted === true,
          ) ||
          Object.entries(registeredGroups).find(([, g]) => g.isMain === true);
        if (!routerEntry) {
          respond('No Brain Router group configured.').catch(() => {});
          return;
        }
        const [mainJid] = routerEntry;

        // Build the prefixed message content
        const content = `/${command} ${args}`.trim();
        const now = new Date().toISOString();

        // Inject as a synthetic message into the main group
        storeMessage({
          id: `slash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: mainJid,
          sender: 'owner',
          sender_name: 'Owner',
          content,
          timestamp: now,
          is_from_me: false,
        });
        queue.enqueueMessageCheck(mainJid);

        // Acknowledge the interaction
        const ack = `/${command} received.`;
        respond(ack).catch((err) =>
          logger.warn(
            { chatJid, command, err },
            'Failed to acknowledge slash command',
          ),
        );
        logger.info(
          { command, args, source: chatJid, target: mainJid },
          'Slash command passed through to Brain Router',
        );
        return;
      }

      respond(`Unknown command: /${command}`).catch(() => {});
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await sendWithMirror(jid, text);
    },
  });
  // Find the Discord channel instance for create_project support
  const discordChannel = channels.find((ch) => ch.name === 'discord') as
    | import('./channels/discord.js').DiscordChannel
    | undefined;

  startIpcWatcher({
    sendMessage: (jid, text) => sendWithMirror(jid, text),
    deleteDiscordMessage: discordChannel
      ? (jid: string, messageId: string) =>
          discordChannel.deleteMessage(jid, messageId)
      : undefined,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    enqueueMessageCheck: (groupJid: string) =>
      queue.enqueueMessageCheck(groupJid),
    deleteDiscordChannel: discordChannel
      ? async (channelId: string) => {
          try {
            return await discordChannel.deleteTextChannel(channelId);
          } catch (err) {
            logger.error(
              { err, channelId },
              'Failed to delete Discord channel',
            );
            return false;
          }
        }
      : undefined,
    unregisterGroup: (jid: string) => {
      delete registeredGroups[jid];
      deleteRegisteredGroup(jid);
      scheduleCanonicalSnapshot('unregister-group');
      logger.info({ jid }, 'Group unregistered');
    },
    createDiscordChannel: discordChannel
      ? async (name: string) => {
          const envVars = (await import('./env.js')).readEnvFile([
            'DISCORD_GUILD_ID',
            'DISCORD_PROJECT_CATEGORY_ID',
          ]);
          const guildId =
            process.env.DISCORD_GUILD_ID || envVars.DISCORD_GUILD_ID;
          const categoryId =
            process.env.DISCORD_PROJECT_CATEGORY_ID ||
            envVars.DISCORD_PROJECT_CATEGORY_ID;
          if (!guildId) return null;
          try {
            return await discordChannel.createTextChannel(
              guildId,
              name,
              categoryId,
            );
          } catch (err) {
            logger.error({ err, name }, 'Failed to create Discord channel');
            return null;
          }
        }
      : undefined,
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
