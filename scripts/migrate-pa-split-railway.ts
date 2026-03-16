/**
 * Railway migration: Split main group into Personal Assistant + Brain Router
 *
 * Run on Railway after deploying the code changes:
 *   node dist/scripts/migrate-pa-split-railway.js
 *
 * Or via railway shell:
 *   railway shell -s nanoclaw
 *   node -e "$(cat scripts/migrate-pa-split-railway.js)"
 *
 * This script:
 * 1. Creates a "personal-assistant" Discord channel via the API
 * 2. Re-registers the existing Brain Router channel as trusted (not main)
 * 3. Registers the new PA channel as the main group
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { initDatabase, setRegisteredGroup, getAllRegisteredGroups } from '../src/db.ts';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!BOT_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID');
  process.exit(1);
}

async function main() {
  console.log('Initializing database...');
  initDatabase();

  // Find the current Brain Router registration
  const groups = getAllRegisteredGroups();
  const brainRouterEntry = Object.entries(groups).find(
    ([, g]) => g.folder === 'main' && g.isMain,
  );

  if (!brainRouterEntry) {
    console.error('Could not find current main group (Brain Router)');
    process.exit(1);
  }

  const [brainRouterJid] = brainRouterEntry;
  console.log(`Found Brain Router at ${brainRouterJid}`);

  // Check if migration already ran
  const existingPa = Object.entries(groups).find(
    ([jid, g]) => g.folder === 'main' && jid !== brainRouterJid,
  );
  if (existingPa) {
    console.log('Migration already applied — PA channel exists.');
    process.exit(0);
  }

  console.log('Connecting to Discord...');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.login(BOT_TOKEN);
  });
  console.log(`Connected as ${client.user?.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);

  // Create PA channel (no category — top-level text channel)
  console.log('Creating "personal-assistant" Discord channel...');
  const paChannel = await guild.channels.create({
    name: 'personal-assistant',
    type: ChannelType.GuildText,
    topic: 'General-purpose personal assistant',
  });
  console.log(`Created: ${paChannel.name} (${paChannel.id})`);

  const paJid = `dc:${paChannel.id}`;

  // Re-register Brain Router
  console.log(`Re-registering Brain Router (${brainRouterJid}) as brain-router (trusted)...`);
  setRegisteredGroup(brainRouterJid, {
    name: 'Brain Router',
    folder: 'brain-router',
    trigger: '@NanoClaw',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
    trusted: true,
  });

  // Register PA as main
  console.log(`Registering Personal Assistant (${paJid}) as main...`);
  setRegisteredGroup(paJid, {
    name: 'Personal Assistant',
    folder: 'main',
    trigger: '@NanoClaw',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
    trusted: false,
  });

  console.log('\n=== Migration Complete ===');
  console.log(`Personal Assistant: ${paJid} (folder: main, isMain: true)`);
  console.log(`Brain Router: ${brainRouterJid} (folder: brain-router, trusted: true)`);

  client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
