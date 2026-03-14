import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import yaml from 'yaml';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  storeMessage,
  updateTask,
} from './db.js';
import { readEnvFile } from './env.js';
import {
  fsNameToFolder,
  isValidGroupFolder,
  resolveGroupFolderPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  enqueueMessageCheck: (groupJid: string) => void;
  createDiscordChannel?: (name: string) => Promise<string | null>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroupFs of groupFolders) {
      // Convert filesystem directory name back to canonical folder name
      // (e.g., "project_finance-tracker" → "project:finance-tracker")
      const sourceGroup = fsNameToFolder(sourceGroupFs);
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroupFs, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroupFs, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For execute_in_group
    target_group_folder?: string;
    // For create_project
    slug?: string;
    projectType?: string;
    brief?: string;
    aliases?: string;
    host_path?: string;
    // For search_knowledge
    searches?: Array<{ type: string; query: string }>;
    intent?: string;
    limit?: number;
    resultId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'execute_in_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized execute_in_group attempt blocked',
        );
        break;
      }
      if (data.target_group_folder && data.prompt) {
        // Find the target group's JID by folder name
        let targetJid: string | null = null;
        for (const [jid, group] of Object.entries(registeredGroups)) {
          if (group.folder === data.target_group_folder) {
            targetJid = jid;
            break;
          }
        }
        if (!targetJid) {
          logger.warn(
            { targetFolder: data.target_group_folder },
            'execute_in_group: target group not found',
          );
          break;
        }

        // Store a synthetic message so the agent sees it as input
        const msgId = `router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        storeMessage({
          id: msgId,
          chat_jid: targetJid,
          sender: 'router',
          sender_name: 'Router',
          content: data.prompt,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        });

        // Enqueue the group for processing
        deps.enqueueMessageCheck(targetJid);
        logger.info(
          { sourceGroup, targetFolder: data.target_group_folder, targetJid },
          'execute_in_group dispatched',
        );
      }
      break;

    case 'search_knowledge': {
      const {
        searches,
        intent,
        limit = 10,
        resultId: taskResultId,
      } = data as {
        searches: Array<{ type: string; query: string }>;
        intent?: string;
        limit?: number;
        resultId?: string;
      };
      // Write result back to IPC input directory for the agent to read
      const resultDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup.replace(/:/g, '_'),
        'input',
      );
      fs.mkdirSync(resultDir, { recursive: true });
      const resultFileName = taskResultId
        ? `result-${taskResultId}.json`
        : `result-${Date.now()}.json`;
      try {
        const envVars = readEnvFile(['QMD_HTTP_URL']);
        const qmdUrl =
          process.env.QMD_HTTP_URL ||
          envVars.QMD_HTTP_URL ||
          'http://127.0.0.1:8181';
        const body: Record<string, unknown> = {
          searches,
          collections: ['knowledge'],
          limit,
        };
        if (intent) body.intent = intent;
        const response = await fetch(`${qmdUrl}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const results = await response.json();
        fs.writeFileSync(
          path.join(resultDir, resultFileName),
          JSON.stringify({ success: true, results }),
        );
        logger.info(
          { sourceGroup, resultFileName, resultCount: Array.isArray(results) ? results.length : 'unknown' },
          'Knowledge search completed',
        );
      } catch (err) {
        fs.writeFileSync(
          path.join(resultDir, resultFileName),
          JSON.stringify({
            success: false,
            error: 'Knowledge search unavailable — is qmd running?',
          }),
        );
        logger.error(
          { err, sourceGroup },
          'Knowledge search failed',
        );
      }
      break;
    }

    case 'reindex_knowledge': {
      // Main-only: only the Brain Router should trigger reindexing
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized reindex_knowledge attempt blocked',
        );
        break;
      }
      // Fire-and-forget: spawn background process, don't await
      const { spawn: spawnChild } = await import('child_process');
      const child = spawnChild('qmd', ['embed'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      logger.info({ sourceGroup }, 'Knowledge reindex started in background');
      break;
    }

    case 'create_project':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_project attempt blocked',
        );
        break;
      }
      if (data.name && data.slug && data.projectType && data.brief) {
        try {
          await handleCreateProject(
            data as {
              name: string;
              slug: string;
              projectType: string;
              brief: string;
              aliases?: string;
            },
            sourceGroup,
            registeredGroups,
            deps,
          );
        } catch (err) {
          logger.error({ err, slug: data.slug }, 'create_project failed');
          // Try to notify the main group of the failure
          const mainJid = Object.entries(registeredGroups).find(
            ([, g]) => g.isMain,
          )?.[0];
          if (mainJid) {
            await deps.sendMessage(
              mainJid,
              `Failed to create project "${data.name}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        logger.warn({ data }, 'create_project: missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function handleCreateProject(
  data: {
    name: string;
    slug: string;
    projectType: string;
    brief: string;
    aliases?: string;
  },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  const envVars = readEnvFile([
    'DISCORD_GUILD_ID',
    'DISCORD_PROJECT_CATEGORY_ID',
    'NANOCLAW_PROJECTS_DIR',
  ]);
  const guildId = process.env.DISCORD_GUILD_ID || envVars.DISCORD_GUILD_ID;
  const categoryId =
    process.env.DISCORD_PROJECT_CATEGORY_ID ||
    envVars.DISCORD_PROJECT_CATEGORY_ID;

  if (!guildId) {
    throw new Error('DISCORD_GUILD_ID not configured');
  }

  if (!deps.createDiscordChannel) {
    throw new Error('Discord channel not available');
  }

  // Create the Discord text channel
  const channelId = await deps.createDiscordChannel(data.slug);
  if (!channelId) {
    throw new Error('Failed to create Discord channel');
  }

  const jid = `dc:${channelId}`;
  const folder = `project:${data.slug}`;

  // Register the group — project channels respond to all messages (no trigger needed)
  // No additionalMounts needed: the project dir IS the group dir
  deps.registerGroup(jid, {
    name: data.name,
    folder,
    trigger: '@Router',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  });

  // Create project directory with all files in one place
  const projectDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });

  // Try to load template from groups/main/templates/
  const templateName =
    data.projectType === 'code'
      ? 'code-project-claude.md'
      : 'general-project-claude.md';
  const templatePath = path.join(GROUPS_DIR, 'main', 'templates', templateName);

  let claudeContent: string;
  if (fs.existsSync(templatePath)) {
    claudeContent = fs
      .readFileSync(templatePath, 'utf-8')
      .replace(/\{PROJECT_NAME\}/g, data.name)
      .replace(/\{BRIEF\}/g, data.brief)
      .replace(/\{SLUG\}/g, data.slug);
  } else {
    claudeContent = `# ${data.name}\n\n${data.brief}\n`;
  }
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeContent);

  // Create empty notes file
  fs.writeFileSync(
    path.join(projectDir, 'notes.md'),
    `# ${data.name} - Notes\n`,
  );

  // Update projects.yaml
  const projectsYamlPath = path.join(GROUPS_DIR, 'main', 'projects.yaml');
  let projects: any[] = [];
  if (fs.existsSync(projectsYamlPath)) {
    const existing = yaml.parse(fs.readFileSync(projectsYamlPath, 'utf-8'));
    if (Array.isArray(existing)) {
      projects = existing;
    } else if (existing?.projects && Array.isArray(existing.projects)) {
      projects = existing.projects;
    }
  }

  projects.push({
    name: data.name,
    slug: data.slug,
    type: data.projectType,
    brief: data.brief,
    aliases: data.aliases
      ? data.aliases.split(',').map((a: string) => a.trim())
      : [],
    discord_channel_id: channelId,
    folder,
    created_at: new Date().toISOString(),
  });

  fs.writeFileSync(projectsYamlPath, yaml.stringify(projects));

  // Send confirmation to the main group
  const mainJid = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain,
  )?.[0];
  if (mainJid) {
    await deps.sendMessage(
      mainJid,
      `Project ${data.name} created → <#${channelId}>`,
    );
  }

  logger.info(
    { name: data.name, slug: data.slug, channelId, folder },
    'Project created successfully',
  );
}
