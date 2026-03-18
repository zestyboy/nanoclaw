# Add Discord Slash Commands

This skill adds or extends native Discord slash commands for NanoClaw. Use it when the user wants to add a new slash command to their Discord bot.

## Prerequisites

- Discord channel must already be configured (`/add-discord`)
- Bot must have the `applications.commands` OAuth2 scope (check Discord Developer Portal > OAuth2 > URL Generator)

## Architecture

NanoClaw's slash command system has three layers:

1. **Command registration** (`src/channels/discord.ts` → `registerSlashCommands()`) — Registers commands with the Discord API on bot startup using `REST.put(Routes.applicationCommands())`. Global commands propagate to all guilds within ~1 hour; guild-scoped commands are instant.

2. **Interaction handler** (`src/channels/discord.ts` → `Events.InteractionCreate`) — Listens for Discord interactions, maps them to the `onSlashCommand` callback. The channel is responsible for replying to the interaction (must respond within 3 seconds).

3. **Command dispatcher** (`src/index.ts` → `channelOpts.onSlashCommand`) — Routes commands to their handlers. Fast-path commands (like `/clear`) execute immediately without spawning a container.

Responses use `interaction.reply({ ephemeral: true })` so only the invoking user sees the response.

## How to Add a New Slash Command

### Step 1: Register the command

In `src/channels/discord.ts`, find the `registerSlashCommands()` method. Add a new `SlashCommandBuilder` entry to the `commands` array:

```typescript
private async registerSlashCommands(applicationId: string): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Clear the current session context'),
    // Add new command here:
    new SlashCommandBuilder()
      .setName('yourcommand')
      .setDescription('What this command does'),
  ];
  // ... rest of registration
}
```

For commands with options (arguments), use the builder's option methods:

```typescript
new SlashCommandBuilder()
  .setName('model')
  .setDescription('Change the AI model')
  .addStringOption(option =>
    option.setName('name')
      .setDescription('Model name')
      .setRequired(true)
      .addChoices(
        { name: 'Sonnet', value: 'sonnet' },
        { name: 'Opus', value: 'opus' },
      )
  )
```

### Step 2: Handle the command in the dispatcher

In `src/index.ts`, find the `onSlashCommand` callback inside `channelOpts`. Add a case for the new command:

```typescript
onSlashCommand: (chatJid, command, respond) => {
  const group = registeredGroups[chatJid];
  if (!group) {
    respond('This channel is not registered.').catch(() => {});
    return;
  }

  if (command === 'clear') {
    // ... existing clear logic
  } else if (command === 'yourcommand') {
    // Your handler here
    respond('Done!').catch(() => {});
  } else {
    respond(`Unknown command: /${command}`).catch(() => {});
  }
},
```

**Fast-path vs container commands:**
- **Fast-path** (like `/clear`): Handle directly in the callback. No container spawning, instant response.
- **Container commands** (if needed): You'd need to defer the interaction response using `interaction.deferReply()` since containers take longer than Discord's 3-second limit. This requires extending the callback signature — see Discord.js docs on deferred replies.

### Step 3: Add tests

In `src/channels/discord.test.ts`, add a test in the `slash commands` describe block:

```typescript
it('calls onSlashCommand for /yourcommand', async () => {
  const opts = createTestOpts();
  const channel = new DiscordChannel('test-token', opts);
  await channel.connect();

  const interaction = createInteraction({ commandName: 'yourcommand' });
  await triggerInteraction(interaction);

  expect(opts.onSlashCommand).toHaveBeenCalledWith(
    'dc:1234567890123456',
    'yourcommand',
    expect.any(Function),
  );
});
```

### Step 4: Build and verify

```bash
npm test && npm run build
```

### Step 5: Propagation

Global slash commands take up to 1 hour to appear in Discord after registration. For instant testing during development, use guild-scoped commands:

```typescript
// Instead of:
Routes.applicationCommands(applicationId)
// Use:
Routes.applicationGuildCommands(applicationId, guildId)
```

Guild-scoped commands appear immediately but only work in that specific server.

## Existing Commands

| Command | Type | Description |
|---------|------|-------------|
| `/clear` | Fast-path | Clears the session context for the current channel |

## Key Files

| File | Purpose |
|------|---------|
| `src/channels/discord.ts` | Command registration + interaction handler |
| `src/channels/registry.ts` | `OnSlashCommand` type definition |
| `src/index.ts` | Command dispatcher (in `channelOpts.onSlashCommand`) |
| `src/channels/discord.test.ts` | Tests for slash command handling |

## Troubleshooting

### Commands not appearing in Discord

1. Global commands take up to 1 hour to propagate after first registration
2. Check bot has `applications.commands` OAuth2 scope
3. Check server integration settings: Server Settings > Integrations > your bot > ensure "Use Slash Commands" is enabled
4. Check logs for `Failed to register Discord slash commands` errors

### "Unknown interaction" error

Discord requires a response within 3 seconds. If your handler takes longer, use `interaction.deferReply()` and then `interaction.editReply()` when ready.

### Duplicate or stale commands

Commands are overwritten on each startup via `REST.put()` (which replaces all commands). Removing a command from the `commands` array and restarting will remove it from Discord.
