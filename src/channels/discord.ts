import fs from 'fs';
import path from 'path';

import {
  Attachment,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, IS_RAILWAY, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts, OnSlashCommand } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMessageOptions,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onSlashCommand: OnSlashCommand;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function describeAttachment(att: Attachment): string {
  const contentType = att.contentType || '';
  if (contentType.startsWith('image/')) {
    return 'Image';
  }
  if (contentType.startsWith('video/')) {
    return 'Video';
  }
  if (contentType.startsWith('audio/')) {
    return 'Audio';
  }
  return 'File';
}

function sanitizeAttachmentName(
  name: string | null | undefined,
  index: number,
): string {
  const fallback = `attachment-${index + 1}`;
  const baseName = path.basename(name?.trim() || fallback);
  const sanitized = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || fallback;
}

function ensureUniqueFilename(filename: string, seen: Set<string>): string {
  if (!seen.has(filename)) {
    seen.add(filename);
    return filename;
  }

  const parsed = path.parse(filename);
  let suffix = 2;
  while (true) {
    const candidate = `${parsed.name}-${suffix}${parsed.ext}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function toWorkspacePath(relativePath: string, groupFolder?: string): string {
  const basePath =
    IS_RAILWAY && groupFolder
      ? resolveGroupFolderPath(groupFolder)
      : '/workspace/group';
  return path.posix.join(basePath, relativePath.split(path.sep).join('/'));
}

async function downloadAttachments(
  message: Message,
  groupFolder: string,
): Promise<string[]> {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const attachmentDir = path.join(
    'attachments',
    `${message.createdAt.toISOString().replace(/[:.]/g, '-')}-${message.id}`,
  );
  const hostAttachmentDir = path.join(groupDir, attachmentDir);
  fs.mkdirSync(hostAttachmentDir, { recursive: true });

  const seenFilenames = new Set<string>();
  const descriptions: string[] = [];
  let index = 0;

  for (const att of message.attachments.values()) {
    const attachmentType = describeAttachment(att);
    const filename = ensureUniqueFilename(
      sanitizeAttachmentName(att.name, index),
      seenFilenames,
    );
    index += 1;

    if (!att.url) {
      descriptions.push(`[${attachmentType}: ${filename}]`);
      continue;
    }

    try {
      const response = await fetch(att.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const relativeFilePath = path.join(attachmentDir, filename);
      const hostFilePath = path.join(groupDir, relativeFilePath);
      fs.writeFileSync(hostFilePath, buffer);

      descriptions.push(
        `[${attachmentType}: ${filename}] Staged at ${toWorkspacePath(relativeFilePath, groupFolder)}`,
      );
      logger.info(
        {
          groupFolder,
          messageId: message.id,
          attachmentName: filename,
          size: buffer.length,
        },
        'Discord attachment downloaded',
      );
    } catch (err) {
      descriptions.push(`[${attachmentType}: ${filename}] Download failed`);
      logger.warn(
        {
          err,
          groupFolder,
          messageId: message.id,
          attachmentName: filename,
          url: att.url,
        },
        'Failed to download Discord attachment',
      );
    }
  }

  return descriptions;
}

function isUnknownDiscordMessageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: number; message?: string };
  return (
    candidate.code === 10008 ||
    candidate.message?.includes('Unknown Message') === true
  );
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      if (message.attachments.size > 0) {
        const attachmentDescriptions = await downloadAttachments(
          message,
          group.folder,
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    // Handle native slash commands (Discord Interactions API)
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const chatJid = `dc:${interaction.channelId}`;
      const command = interaction.commandName;

      logger.info(
        { chatJid, command, user: interaction.user.tag },
        'Discord slash command received',
      );

      const args = interaction.options.getString('message') || '';

      this.opts.onSlashCommand(chatJid, command, args, async (text: string) => {
        try {
          await interaction.reply({ content: text, ephemeral: true });
        } catch (err) {
          logger.warn(
            { chatJid, command, err },
            'Failed to reply to slash command',
          );
        }
      });
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Register slash commands with the Discord API
        await this.registerSlashCommands(readyClient.user.id);

        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        if (options?.silent) {
          await textChannel.send({
            content: text,
            flags: MessageFlags.SuppressNotifications,
          });
        } else {
          await textChannel.send(text);
        }
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const chunk = text.slice(i, i + MAX_LENGTH);
          if (options?.silent) {
            await textChannel.send({
              content: chunk,
              flags: MessageFlags.SuppressNotifications,
            });
          } else {
            await textChannel.send(chunk);
          }
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async deleteMessage(
    jid: string,
    messageId: string,
  ): Promise<'deleted' | 'not_found'> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return 'not_found';
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('messages' in channel)) {
        logger.warn({ jid, messageId }, 'Discord channel not found');
        return 'not_found';
      }

      const textChannel = channel as TextChannel;
      const message = await textChannel.messages.fetch(messageId);
      await message.delete();
      logger.info({ jid, messageId }, 'Discord message deleted');
      return 'deleted';
    } catch (err) {
      if (isUnknownDiscordMessageError(err)) {
        logger.warn({ jid, messageId }, 'Discord message not found');
        return 'not_found';
      }
      logger.error({ jid, messageId, err }, 'Failed to delete Discord message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async createTextChannel(
    guildId: string,
    name: string,
    categoryId?: string,
  ): Promise<string> {
    if (!this.client) throw new Error('Discord client not initialized');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error(`Guild ${guildId} not found in cache`);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    return channel.id;
  }

  async deleteTextChannel(channelId: string): Promise<boolean> {
    if (!this.client) throw new Error('Discord client not initialized');
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel) {
        await channel.delete();
        return true;
      }
      return false;
    } catch (err) {
      logger.warn({ channelId, err }, 'Failed to delete Discord channel');
      return false;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  /**
   * Register native slash commands with the Discord API.
   * Uses global commands (available in all guilds the bot is in).
   */
  private async registerSlashCommands(applicationId: string): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear the current session context'),
      new SlashCommandBuilder()
        .setName('context')
        .setDescription('Show current session context usage'),
      new SlashCommandBuilder()
        .setName('reload')
        .setDescription('Reload skills and CLAUDE.md'),
      new SlashCommandBuilder()
        .setName('cost')
        .setDescription('Show session token usage and cost'),
      new SlashCommandBuilder()
        .setName('diff')
        .setDescription('Show uncommitted changes in the group workspace'),
      new SlashCommandBuilder()
        .setName('export')
        .setDescription('Export the latest archived conversation'),
      new SlashCommandBuilder()
        .setName('tasks')
        .setDescription('List scheduled tasks for this group'),
      new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Name the current session')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('Session name')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('work')
        .setDescription('List or switch sessions')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription(
              'Session number or name to switch to (omit to list)',
            )
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName('effort')
        .setDescription('Set agent effort level')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('Effort level: low, medium, or high')
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName('rewind')
        .setDescription('Undo agent file changes (revert to last commit)'),
      new SlashCommandBuilder()
        .setName('catalog')
        .setDescription('Catalog information to a project')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('What to catalog (e.g. "for project: notes...")')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('execute')
        .setDescription('Execute a task in a project')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('What to execute (e.g. "for project: build...")')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('knowledge')
        .setDescription('Store or search the knowledge repository')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('What to store or search for')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask for help routing — list matching projects')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('Your question or message to route')
            .setRequired(true),
        ),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(this.botToken);
      await rest.put(Routes.applicationCommands(applicationId), {
        body: commands.map((c) => c.toJSON()),
      });
      logger.info(
        { commandCount: commands.length },
        'Discord slash commands registered',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to register Discord slash commands');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
