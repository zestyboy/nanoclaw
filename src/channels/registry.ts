import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

/**
 * Callback for native slash commands (Discord interactions, Telegram bot commands, etc.).
 * Channels call this when a user invokes a platform-native command.
 * The channel is responsible for acknowledging the interaction (e.g. ephemeral reply).
 */
export type OnSlashCommand = (
  chatJid: string,
  command: string,
  respond: (text: string) => Promise<void>,
) => void;

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onSlashCommand: OnSlashCommand;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
