import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import yaml from 'yaml';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  IS_RAILWAY,
  SECOND_BRAIN_DIR,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  storeChatMetadata,
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
import {
  activateMirror,
  deactivateMirror,
  formatRetroactiveMessages,
} from './mirror.js';
import {
  assertPushChangesAllowed,
  resolvePushChangesBranch,
} from './push-changes-policy.js';
import { qmdSearch } from './qmd-client.js';
import { scheduleQmdReindex } from './qmd-state.js';
import { searchRecentNotes } from './recent-note-search.js';
import { scheduleCanonicalSnapshot } from './state-backup.js';
import { triggerSyncthingScan } from './syncthing-config.js';
import { getPersonalSkillLibraryPath } from './skills.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  deleteDiscordMessage?: (
    jid: string,
    messageId: string,
  ) => Promise<'deleted' | 'not_found'>;
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
  deleteDiscordChannel?: (channelId: string) => Promise<boolean>;
  unregisterGroup?: (jid: string) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

function inferChannelFromJid(jid: string): string | undefined {
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) {
    return 'whatsapp';
  }
  return undefined;
}

function ensureRegisteredGroupChatMetadata(
  jid: string,
  group: RegisteredGroup,
  timestamp: string,
): void {
  storeChatMetadata(jid, timestamp, group.name, inferChannelFromJid(jid), true);
}

function resolveProjectOwnerFolder(
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string {
  const brainRouter = Object.values(registeredGroups).find(
    (group) => group.folder === 'brain-router',
  );
  return brainRouter?.folder || sourceGroup;
}

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

    // Build folder→isMain and folder→isTrusted lookups from registered groups
    const folderIsMain = new Map<string, boolean>();
    const folderIsTrusted = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
      if (group.trusted) folderIsTrusted.set(group.folder, true);
    }

    for (const sourceGroupFs of groupFolders) {
      // Convert filesystem directory name back to canonical folder name
      // (e.g., "project_finance-tracker" → "project:finance-tracker")
      const sourceGroup = fsNameToFolder(sourceGroupFs);
      const isMain = folderIsMain.get(sourceGroup) === true;
      const isTrusted = folderIsTrusted.get(sourceGroup) === true;
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
                  isTrusted ||
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
              await processTaskIpc(data, sourceGroup, isMain, isTrusted, deps);
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

/** Check if a group has elevated privileges (main or trusted). */
function hasElevatedPrivilege(isMain: boolean, isTrusted: boolean): boolean {
  return isMain || isTrusted;
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
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
    // For delete_project
    discord_channel_id?: string;
    // For search_public_knowledge / search_second_brain
    searches?: Array<{ type: string; query: string }>;
    intent?: string;
    limit?: number;
    resultId?: string;
    collection?: string;
    query?: string;
    terms?: string[];
    start_date?: string;
    end_date?: string;
    // For activate_mirror / deactivate_mirror
    source_jid?: string;
    target_jid?: string;
    project_name?: string;
    duration_minutes?: number;
    message_id?: string;
    // For push_changes
    files?: Array<{ path: string; content: string }>;
    commitMessage?: string;
    branch?: string;
    createPr?: boolean;
    prTitle?: string;
    prBody?: string;
    // For skill:create / skill:update / skill:delete
    skill_name?: string;
    skill_content?: string;
    skill_scope?: 'personal' | 'project';
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  isTrusted: boolean, // Verified from directory path
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

        // Authorization: non-elevated groups can only schedule for themselves
        if (
          !hasElevatedPrivilege(isMain, isTrusted) &&
          targetFolder !== sourceGroup
        ) {
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
          script: data.script || null,
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
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (
          task &&
          (hasElevatedPrivilege(isMain, isTrusted) ||
            task.group_folder === sourceGroup)
        ) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
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
        if (
          task &&
          (hasElevatedPrivilege(isMain, isTrusted) ||
            task.group_folder === sourceGroup)
        ) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
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
        if (
          task &&
          (hasElevatedPrivilege(isMain, isTrusted) ||
            task.group_folder === sourceGroup)
        ) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
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
        if (
          !hasElevatedPrivilege(isMain, isTrusted) &&
          task.group_folder !== sourceGroup
        ) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
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
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only elevated groups can request a refresh
      if (hasElevatedPrivilege(isMain, isTrusted)) {
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
      // Only elevated groups can register new groups
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
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
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'execute_in_group':
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
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
        const targetGroup = registeredGroups[targetJid];

        // Embed source channel JID in the prompt so the target agent
        // (e.g., Brain Router) can activate mirroring back to the source
        const promptContent = data.source_jid
          ? `<source_channel jid="${data.source_jid}" />\n\n${data.prompt}`
          : data.prompt;

        // Synthetic dispatches need a chats row before the message insert.
        // This covers unsynced channels and freshly created project channels.
        if (targetGroup) {
          ensureRegisteredGroupChatMetadata(
            targetJid,
            targetGroup,
            new Date().toISOString(),
          );
        }

        // Store a synthetic message so the agent sees it as input
        const msgId = `router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        storeMessage({
          id: msgId,
          chat_jid: targetJid,
          sender: 'router',
          sender_name: 'Router',
          content: promptContent,
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

    case 'delete_discord_message': {
      if (!data.target_jid || !data.message_id) {
        logger.warn(
          { data },
          'delete_discord_message: missing target_jid or message_id',
        );
        break;
      }
      if (!data.target_jid.startsWith('dc:')) {
        logger.warn(
          { sourceGroup, targetJid: data.target_jid },
          'delete_discord_message: target is not a Discord chat',
        );
        break;
      }
      const targetGroup = registeredGroups[data.target_jid];
      if (!targetGroup) {
        logger.warn(
          { sourceGroup, targetJid: data.target_jid },
          'delete_discord_message: target group not found',
        );
        break;
      }
      if (
        !hasElevatedPrivilege(isMain, isTrusted) &&
        targetGroup.folder !== sourceGroup
      ) {
        logger.warn(
          { sourceGroup, targetJid: data.target_jid },
          'Unauthorized delete_discord_message attempt blocked',
        );
        break;
      }
      if (!deps.deleteDiscordMessage) {
        logger.warn('delete_discord_message: Discord channel not available');
        break;
      }

      const resultDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup.replace(/:/g, '_'),
        'input',
      );
      fs.mkdirSync(resultDir, { recursive: true });
      const resultFileName = data.resultId
        ? `result-${data.resultId}.json`
        : `result-${Date.now()}.json`;

      try {
        const status = await deps.deleteDiscordMessage(
          data.target_jid,
          data.message_id,
        );
        fs.writeFileSync(
          path.join(resultDir, resultFileName),
          JSON.stringify({
            success: true,
            status,
            message:
              status === 'deleted'
                ? `Deleted Discord message ${data.message_id}.`
                : `Discord message ${data.message_id} was not found.`,
          }),
        );
        logger.info(
          {
            sourceGroup,
            targetJid: data.target_jid,
            messageId: data.message_id,
            status,
          },
          'delete_discord_message processed',
        );
      } catch (err) {
        fs.writeFileSync(
          path.join(resultDir, resultFileName),
          JSON.stringify({
            success: false,
            error:
              err instanceof Error
                ? err.message
                : 'Discord message deletion failed',
          }),
        );
        logger.error(
          {
            err,
            sourceGroup,
            targetJid: data.target_jid,
            messageId: data.message_id,
          },
          'delete_discord_message failed',
        );
      }
      break;
    }

    case 'search_public_knowledge': {
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
        const { results } = await qmdSearch(
          'public-knowledge',
          searches,
          intent,
          limit,
        );
        fs.writeFileSync(
          path.join(resultDir, resultFileName),
          JSON.stringify({ success: true, results }),
        );
        logger.info(
          {
            sourceGroup,
            resultFileName,
            resultCount: Array.isArray(results) ? results.length : 'unknown',
          },
          'Public knowledge search completed',
        );
      } catch (err) {
        fs.writeFileSync(
          path.join(resultDir, resultFileName),
          JSON.stringify({
            success: false,
            error: 'Public knowledge search failed — is qmd installed?',
          }),
        );
        logger.error({ err, sourceGroup }, 'Public knowledge search failed');
      }
      break;
    }

    case 'reindex_public_knowledge': {
      // Only elevated groups can trigger reindexing
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized reindex_public_knowledge attempt blocked',
        );
        break;
      }
      scheduleQmdReindex('public-knowledge', 'ipc request');
      logger.info(
        { sourceGroup },
        'Public knowledge reindex started in background',
      );
      break;
    }

    case 'search_second_brain': {
      const {
        searches,
        intent,
        limit = 10,
        resultId: sbResultId,
      } = data as {
        searches: Array<{ type: string; query: string }>;
        intent?: string;
        limit?: number;
        resultId?: string;
      };
      const sbResultDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup.replace(/:/g, '_'),
        'input',
      );
      fs.mkdirSync(sbResultDir, { recursive: true });
      const sbResultFileName = sbResultId
        ? `result-${sbResultId}.json`
        : `result-${Date.now()}.json`;
      try {
        const { results } = await qmdSearch(
          'second-brain',
          searches,
          intent,
          limit,
        );
        fs.writeFileSync(
          path.join(sbResultDir, sbResultFileName),
          JSON.stringify({ success: true, results }),
        );
        logger.info(
          {
            sourceGroup,
            resultFileName: sbResultFileName,
            resultCount: Array.isArray(results) ? results.length : 'unknown',
          },
          'Second Brain search completed',
        );
      } catch (err) {
        fs.writeFileSync(
          path.join(sbResultDir, sbResultFileName),
          JSON.stringify({
            success: false,
            error: 'Second Brain search failed — is qmd installed?',
          }),
        );
        logger.error({ err, sourceGroup }, 'Second Brain search failed');
      }
      break;
    }

    case 'search_second_brain_recent': {
      const {
        query,
        terms = [],
        limit = 10,
        start_date: startDate,
        end_date: endDate,
        resultId: recentResultId,
      } = data as {
        query: string;
        terms?: string[];
        limit?: number;
        start_date: string;
        end_date: string;
        resultId?: string;
      };

      const recentResultDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup.replace(/:/g, '_'),
        'input',
      );
      fs.mkdirSync(recentResultDir, { recursive: true });
      const recentResultFileName = recentResultId
        ? `result-${recentResultId}.json`
        : `result-${Date.now()}.json`;

      try {
        if (!SECOND_BRAIN_DIR || !fs.existsSync(SECOND_BRAIN_DIR)) {
          throw new Error('Second Brain directory is not available');
        }
        if (!startDate || !endDate) {
          throw new Error('start_date and end_date are required');
        }

        const results = searchRecentNotes({
          rootDir: SECOND_BRAIN_DIR,
          startDate,
          endDate,
          query,
          terms,
          limit,
        });

        fs.writeFileSync(
          path.join(recentResultDir, recentResultFileName),
          JSON.stringify({ success: true, results }),
        );
        logger.info(
          {
            sourceGroup,
            resultFileName: recentResultFileName,
            resultCount: results.results.length,
            filesInRange: results.stats.files_in_range,
          },
          'Recent Second Brain search completed',
        );
      } catch (err) {
        fs.writeFileSync(
          path.join(recentResultDir, recentResultFileName),
          JSON.stringify({
            success: false,
            error: 'Recent Second Brain search failed',
          }),
        );
        logger.error({ err, sourceGroup }, 'Recent Second Brain search failed');
      }
      break;
    }

    case 'reindex_second_brain': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized reindex_second_brain attempt blocked',
        );
        break;
      }
      scheduleQmdReindex('second-brain', 'ipc request');
      logger.info(
        { sourceGroup },
        'Second Brain reindex started in background',
      );
      break;
    }

    case 'create_project': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_project attempt blocked',
        );
        break;
      }
      // Result directory for synchronous feedback to the container agent
      const createResultDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup.replace(/:/g, '_'),
        'input',
      );
      fs.mkdirSync(createResultDir, { recursive: true });
      const createResultFileName = data.resultId
        ? `result-${data.resultId}.json`
        : `result-${Date.now()}.json`;
      const createResultPath = path.join(createResultDir, createResultFileName);

      if (data.name && data.slug && data.projectType && data.brief) {
        try {
          const projectResult = await handleCreateProject(
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
          // Write success result back to the container agent
          fs.writeFileSync(
            createResultPath,
            JSON.stringify({
              success: true,
              discord_channel_id: projectResult.channelId,
              jid: projectResult.jid,
              folder: projectResult.folder,
            }),
          );
        } catch (err) {
          logger.error({ err, slug: data.slug }, 'create_project failed');
          const errorMessage = err instanceof Error ? err.message : String(err);
          // Write error result back to the container agent
          fs.writeFileSync(
            createResultPath,
            JSON.stringify({
              success: false,
              error: `Failed to create project "${data.name}": ${errorMessage}`,
            }),
          );
          // Also notify the main group
          const mainJid = Object.entries(registeredGroups).find(
            ([, g]) => g.isMain,
          )?.[0];
          if (mainJid) {
            await deps.sendMessage(
              mainJid,
              `Failed to create project "${data.name}": ${errorMessage}`,
            );
          }
        }
      } else {
        logger.warn({ data }, 'create_project: missing required fields');
        fs.writeFileSync(
          createResultPath,
          JSON.stringify({
            success: false,
            error: 'Missing required fields (name, slug, projectType, brief)',
          }),
        );
      }
      break;
    }

    case 'delete_project': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delete_project attempt blocked',
        );
        break;
      }
      const deleteResultDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup.replace(/:/g, '_'),
        'input',
      );
      fs.mkdirSync(deleteResultDir, { recursive: true });
      const deleteResultFileName = data.resultId
        ? `result-${data.resultId}.json`
        : `result-${Date.now()}.json`;
      const deleteResultPath = path.join(deleteResultDir, deleteResultFileName);

      if (data.slug) {
        try {
          const deleteResult = await handleDeleteProject(
            data as { slug: string; discord_channel_id?: string },
            sourceGroup,
            registeredGroups,
            deps,
          );
          fs.writeFileSync(
            deleteResultPath,
            JSON.stringify({ success: true, ...deleteResult }),
          );
        } catch (err) {
          logger.error({ err, slug: data.slug }, 'delete_project failed');
          const errorMessage = err instanceof Error ? err.message : String(err);
          fs.writeFileSync(
            deleteResultPath,
            JSON.stringify({
              success: false,
              error: `Failed to delete project "${data.slug}": ${errorMessage}`,
            }),
          );
        }
      } else {
        logger.warn({ data }, 'delete_project: missing slug');
        fs.writeFileSync(
          deleteResultPath,
          JSON.stringify({
            success: false,
            error: 'Missing required field: slug',
          }),
        );
      }
      break;
    }

    case 'activate_mirror': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized activate_mirror attempt blocked',
        );
        break;
      }
      if (data.source_jid && data.target_jid) {
        const result = activateMirror(
          data.source_jid,
          data.target_jid,
          data.project_name || 'Unknown Project',
          data.duration_minutes,
        );
        if (result.activated && result.retroactive.length > 0) {
          // Send retroactive messages as a single catch-up message
          const catchUp = formatRetroactiveMessages(result.retroactive);
          if (catchUp) {
            try {
              await deps.sendMessage(data.target_jid, catchUp);
              logger.info(
                {
                  targetJid: data.target_jid,
                  messageCount: result.retroactive.length,
                },
                'Sent retroactive mirror messages',
              );
            } catch (err) {
              logger.warn(
                { err, targetJid: data.target_jid },
                'Failed to send retroactive mirror messages',
              );
            }
          }
        }
      } else {
        logger.warn(
          { data },
          'activate_mirror: missing source_jid or target_jid',
        );
      }
      break;
    }

    case 'deactivate_mirror': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized deactivate_mirror attempt blocked',
        );
        break;
      }
      if (data.source_jid) {
        deactivateMirror(data.source_jid, data.target_jid);
      } else {
        logger.warn({ data }, 'deactivate_mirror: missing source_jid');
      }
      break;
    }

    case 'push_changes': {
      // Main-only: push code changes to GitHub
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized push_changes attempt blocked',
        );
        break;
      }
      if (data.files && data.files.length > 0 && data.commitMessage) {
        try {
          await handlePushChanges(
            data as {
              files: Array<{ path: string; content: string }>;
              commitMessage: string;
              branch?: string;
              createPr?: boolean;
              prTitle?: string;
              prBody?: string;
            },
            sourceGroup,
            deps,
          );
        } catch (err) {
          logger.error({ err }, 'push_changes failed');
          const mainJid = Object.entries(deps.registeredGroups()).find(
            ([, g]) => g.isMain,
          )?.[0];
          if (mainJid) {
            await deps.sendMessage(
              mainJid,
              `Failed to push changes: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        logger.warn({ data }, 'push_changes: missing required fields');
      }
      break;
    }

    case 'skill:create':
    case 'skill:update': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          `Unauthorized ${data.type} attempt blocked`,
        );
        break;
      }
      if (!data.skill_name || !data.skill_content) {
        logger.warn(
          { data },
          `${data.type}: missing skill_name or skill_content`,
        );
        break;
      }
      if (!/^[a-z][a-z0-9-]*$/.test(data.skill_name)) {
        logger.warn(
          { skill: data.skill_name },
          `${data.type}: invalid skill name`,
        );
        break;
      }
      try {
        const scope = data.skill_scope || 'personal';
        const skillRoot =
          scope === 'project'
            ? path.join(process.cwd(), '.agents', 'skills')
            : getPersonalSkillLibraryPath();
        const skillDir = path.join(skillRoot, data.skill_name);

        if (data.type === 'skill:create' && fs.existsSync(skillDir)) {
          logger.warn({ skill: data.skill_name }, 'Skill already exists');
          break;
        }
        if (data.type === 'skill:update' && !fs.existsSync(skillDir)) {
          logger.warn({ skill: data.skill_name }, 'Skill not found for update');
          break;
        }

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), data.skill_content);

        await autoCommitSkillChange(
          skillRoot,
          data.type === 'skill:create'
            ? `Add ${data.skill_name}`
            : `Update ${data.skill_name}`,
          data.skill_name,
        );

        logger.info(
          { skill: data.skill_name, scope },
          `${data.type} completed`,
        );
      } catch (err) {
        logger.error({ err, skill: data.skill_name }, `${data.type} failed`);
      }
      break;
    }

    case 'skill:delete': {
      if (!hasElevatedPrivilege(isMain, isTrusted)) {
        logger.warn(
          { sourceGroup },
          'Unauthorized skill:delete attempt blocked',
        );
        break;
      }
      if (!data.skill_name) {
        logger.warn({ data }, 'skill:delete: missing skill_name');
        break;
      }
      if (!/^[a-z][a-z0-9-]*$/.test(data.skill_name)) {
        logger.warn(
          { skill: data.skill_name },
          'skill:delete: invalid skill name',
        );
        break;
      }
      try {
        const scope = data.skill_scope || 'personal';
        const skillRoot =
          scope === 'project'
            ? path.join(process.cwd(), '.agents', 'skills')
            : getPersonalSkillLibraryPath();
        const skillDir = path.join(skillRoot, data.skill_name);

        if (!fs.existsSync(skillDir)) {
          logger.warn(
            { skill: data.skill_name },
            'Skill not found for deletion',
          );
          break;
        }

        fs.rmSync(skillDir, { recursive: true, force: true });
        await autoCommitSkillChange(
          skillRoot,
          `Remove ${data.skill_name}`,
          data.skill_name,
        );

        logger.info(
          { skill: data.skill_name, scope },
          'skill:delete completed',
        );
      } catch (err) {
        logger.error({ err, skill: data.skill_name }, 'skill:delete failed');
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/** Auto-commit a skill change in the given root directory. */
async function autoCommitSkillChange(
  skillRoot: string,
  message: string,
  skillName?: string,
): Promise<void> {
  const { execSync } = await import('child_process');
  try {
    // Scope staging to the skill directory to avoid committing unrelated changes
    const addTarget = skillName ? `-- "${skillName}"` : '-A';
    execSync(`git add ${addTarget}`, { cwd: skillRoot, stdio: 'pipe' });
    // Check if there are staged changes for this skill
    try {
      execSync('git diff --cached --quiet', { cwd: skillRoot, stdio: 'pipe' });
      // No changes staged — skip commit
    } catch {
      // Non-zero exit = there are staged changes — commit only the skill path
      const commitTarget = skillName ? `-- "${skillName}"` : '';
      execSync(
        `git commit -m "${message.replace(/"/g, '\\"')}" ${commitTarget}`,
        {
          cwd: skillRoot,
          stdio: 'pipe',
        },
      );
      logger.info({ skillRoot, message }, 'Auto-committed skill change');
    }
  } catch (err) {
    // Git not initialized or other error — log but don't fail
    logger.warn({ err, skillRoot }, 'Auto-commit skipped (git not available)');
  }
}

async function handlePushChanges(
  data: {
    files: Array<{ path: string; content: string }>;
    commitMessage: string;
    branch?: string;
    createPr?: boolean;
    prTitle?: string;
    prBody?: string;
  },
  sourceGroup: string,
  deps: IpcDeps,
): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO; // e.g., "owner/repo"
  const resolvedBranch = resolvePushChangesBranch(data.branch);

  assertPushChangesAllowed(data.createPr);
  const request = {
    ...data,
    branch: resolvedBranch,
  };

  if (IS_RAILWAY) {
    // Railway: use GitHub API to create commits (no local git repo)
    if (!githubToken || !githubRepo) {
      throw new Error(
        'GITHUB_TOKEN and GITHUB_REPO env vars required for push_changes on Railway',
      );
    }
    await pushViaGitHubApi(request, githubToken, githubRepo);
  } else {
    // Local: use git CLI directly
    await pushViaGitCli(request);
  }

  // Notify the main group
  const mainJid = Object.entries(deps.registeredGroups()).find(
    ([, g]) => g.isMain,
  )?.[0];
  if (mainJid) {
    const fileList = data.files.map((f) => f.path).join(', ');
    await deps.sendMessage(
      mainJid,
      `Pushed ${data.files.length} file(s) to GitHub: ${fileList}`,
    );
  }
}

async function pushViaGitHubApi(
  data: {
    files: Array<{ path: string; content: string }>;
    commitMessage: string;
    branch: string;
    createPr?: boolean;
    prTitle?: string;
    prBody?: string;
  },
  token: string,
  repo: string,
): Promise<void> {
  const branch = data.branch;
  const apiBase = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // Get the current commit SHA for the branch
  const refRes = await fetch(`${apiBase}/git/ref/heads/${branch}`, { headers });
  if (!refRes.ok) throw new Error(`Failed to get ref: ${await refRes.text()}`);
  const refData = (await refRes.json()) as { object: { sha: string } };
  const baseSha = refData.object.sha;

  // Get the base tree
  const commitRes = await fetch(`${apiBase}/git/commits/${baseSha}`, {
    headers,
  });
  if (!commitRes.ok)
    throw new Error(`Failed to get commit: ${await commitRes.text()}`);
  const commitData = (await commitRes.json()) as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const treeEntries = [];
  for (const file of data.files) {
    const blobRes = await fetch(`${apiBase}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: file.content,
        encoding: 'utf-8',
      }),
    });
    if (!blobRes.ok)
      throw new Error(`Failed to create blob: ${await blobRes.text()}`);
    const blobData = (await blobRes.json()) as { sha: string };
    treeEntries.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    });
  }

  // Create tree
  const treeRes = await fetch(`${apiBase}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeEntries,
    }),
  });
  if (!treeRes.ok)
    throw new Error(`Failed to create tree: ${await treeRes.text()}`);
  const treeData = (await treeRes.json()) as { sha: string };

  // Create commit
  const newCommitRes = await fetch(`${apiBase}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: data.commitMessage,
      tree: treeData.sha,
      parents: [baseSha],
    }),
  });
  if (!newCommitRes.ok)
    throw new Error(`Failed to create commit: ${await newCommitRes.text()}`);
  const newCommitData = (await newCommitRes.json()) as { sha: string };

  if (data.createPr) {
    // Create a branch and PR instead of pushing directly to main
    const prBranch = `nanoclaw-auto/${Date.now()}`;
    await fetch(`${apiBase}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ref: `refs/heads/${prBranch}`,
        sha: newCommitData.sha,
      }),
    });

    const prRes = await fetch(`${apiBase}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: data.prTitle || data.commitMessage,
        body: data.prBody || 'Automated change from NanoClaw agent.',
        head: prBranch,
        base: branch,
      }),
    });
    if (!prRes.ok)
      throw new Error(`Failed to create PR: ${await prRes.text()}`);
    const prData = (await prRes.json()) as { html_url: string };
    logger.info({ pr: prData.html_url }, 'Created PR for push_changes');
  } else {
    // Update the branch ref directly
    const updateRefRes = await fetch(`${apiBase}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: newCommitData.sha }),
    });
    if (!updateRefRes.ok)
      throw new Error(`Failed to update ref: ${await updateRefRes.text()}`);
    logger.info(
      { sha: newCommitData.sha, branch },
      'Pushed changes directly to branch',
    );
  }
}

async function pushViaGitCli(data: {
  files: Array<{ path: string; content: string }>;
  commitMessage: string;
  branch: string;
}): Promise<void> {
  const { execFileSync } = await import('child_process');
  const projectRoot = process.cwd();

  // Write files
  for (const file of data.files) {
    const fullPath = path.join(projectRoot, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
  }

  // Stage, commit, push
  const filePaths = data.files.map((f) => f.path);
  execFileSync('git', ['add', ...filePaths], { cwd: projectRoot });
  execFileSync('git', ['commit', '-m', data.commitMessage], {
    cwd: projectRoot,
  });
  const branch = data.branch;
  execFileSync('git', ['push', 'origin', branch], { cwd: projectRoot });

  logger.info(
    { branch, fileCount: data.files.length },
    'Pushed changes via git CLI',
  );
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
): Promise<{ channelId: string; jid: string; folder: string }> {
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
  const projectOwnerFolder = resolveProjectOwnerFolder(
    sourceGroup,
    registeredGroups,
  );

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

  // Use the canonical project owner for templates and registry updates.
  // This keeps Brain Router discovery working even if another elevated group
  // invokes create_project directly.
  const templateName =
    data.projectType === 'code'
      ? 'code-project-claude.md'
      : 'general-project-claude.md';
  const projectOwnerDir = resolveGroupFolderPath(projectOwnerFolder);
  const templatePath = path.join(projectOwnerDir, 'templates', templateName);

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

  // Update the canonical project registry, not the calling group's directory.
  const projectsYamlPath = path.join(projectOwnerDir, 'projects.yaml');
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
  scheduleCanonicalSnapshot('create-project');

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

  return { channelId, jid, folder };
}

async function handleDeleteProject(
  data: { slug: string; discord_channel_id?: string },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<{
  removedFolder: boolean;
  removedYamlEntry: boolean;
  deletedChannel: boolean;
  unregisteredGroup: boolean;
}> {
  const folder = `project:${data.slug}`;
  const result = {
    removedFolder: false,
    removedYamlEntry: false,
    deletedChannel: false,
    unregisteredGroup: false,
  };

  // 1. Find and remove from projects.yaml
  const projectOwnerFolder = resolveProjectOwnerFolder(
    sourceGroup,
    registeredGroups,
  );
  const projectOwnerDir = resolveGroupFolderPath(projectOwnerFolder);
  const projectsYamlPath = path.join(projectOwnerDir, 'projects.yaml');

  let channelId = data.discord_channel_id;

  if (fs.existsSync(projectsYamlPath)) {
    const existing = yaml.parse(fs.readFileSync(projectsYamlPath, 'utf-8'));
    let projects: any[] = [];
    if (Array.isArray(existing)) {
      projects = existing;
    } else if (existing?.projects && Array.isArray(existing.projects)) {
      projects = existing.projects;
    }

    const entry = projects.find((p: any) => p.slug === data.slug);
    if (entry && !channelId) {
      channelId = entry.discord_channel_id;
    }

    const filtered = projects.filter((p: any) => p.slug !== data.slug);
    if (filtered.length < projects.length) {
      fs.writeFileSync(projectsYamlPath, yaml.stringify(filtered));
      result.removedYamlEntry = true;
    }
  }

  // 2. Delete the Discord channel
  if (channelId && deps.deleteDiscordChannel) {
    result.deletedChannel = await deps.deleteDiscordChannel(channelId);
  }

  // 3. Unregister the group
  const jid = channelId ? `dc:${channelId}` : null;
  if (!jid) {
    // Try to find by folder
    for (const [groupJid, group] of Object.entries(registeredGroups)) {
      if (group.folder === folder) {
        if (deps.unregisterGroup) {
          deps.unregisterGroup(groupJid);
          result.unregisteredGroup = true;
        }
        break;
      }
    }
  } else if (registeredGroups[jid]) {
    if (deps.unregisterGroup) {
      deps.unregisterGroup(jid);
      result.unregisteredGroup = true;
    }
  }

  // 4. Remove the project folder
  const projectDir = resolveGroupFolderPath(folder);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true });
    result.removedFolder = true;
    // Trigger immediate Syncthing rescan so the deletion propagates to peers
    triggerSyncthingScan(data.slug).catch(() => {});
  }

  scheduleCanonicalSnapshot('delete-project');

  logger.info({ slug: data.slug, channelId, ...result }, 'Project deleted');

  return result;
}
