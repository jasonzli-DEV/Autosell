require('dotenv').config();

// Initialize bitcoinjs-lib ECC before any other imports that use it
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
bitcoin.initEccLib(ecc);

const { Client, GatewayIntentBits, REST, Routes, MessageFlags, EmbedBuilder } = require('discord.js');
const { initWallet, getWalletAddress } = require('./src/lib/ltc');
const { connectDb } = require('./src/lib/db');
const { getSettings } = require('./src/lib/botSettings');
const { setClient } = require('./src/queue');
const { setPanelClient } = require('./src/lib/panelManager');
const { setVcClient, updateVoiceChannelName } = require('./src/lib/voiceChannel');
const { setLoggerClient, logInfo } = require('./src/lib/logger');
const { setGiveawayClient, resumeActiveGiveaways } = require('./src/systems/giveaway');
const { initializeInviteRewardTracking, setCommandReregisterFn } = require('./src/systems/inviteRewards');
const { setSpawnerClient } = require('./src/systems/spawnerSell');
const { startMinecraftPayer } = require('./src/lib/minecraftPayer');
const { handlePanelCategorySelect, handleFlowPaymentMethod, handleFlowSpawnerUnit } = require('./src/systems/tickets');
const { panelCategoryCustomId, flowPaymentMethodCustomId, flowSpawnerUnitCustomId } = require('./src/lib/autosellConfig');
const panelCommand = require('./src/commands/panel');
const payCommand = require('./src/commands/pay');
const withdrawCommand = require('./src/commands/withdraw');
const killCommand = require('./src/commands/kill');
const startCommand = require('./src/commands/start');
const ticketCommand = require('./src/commands/ticket');
const giveawayCommand = require('./src/commands/giveaway');
const setCommand = require('./src/commands/set');
const lookupCommand = require('./src/commands/lookup');
const { buildInviteCommand, ...inviteCommand } = require('./src/commands/invite');
const handleButton = require('./src/interactions/button');
const handleModal = require('./src/interactions/modal');
const { isStaleInteractionError } = require('./src/lib/interactionErrors');

// Validate required env vars
const REQUIRED = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DONUTSMP_API_KEY', 'DONUTSMP_RECEIVER_IGN', 'LTC_SEED_PHRASE', 'PRICE_PER_MILLION_USD', 'MONGODB_URI'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Validate LTC wallet on startup
try {
  const walletAddress = initWallet();
  console.log(`LTC wallet address: ${walletAddress}`);
} catch (err) {
  console.error(`LTC wallet error: ${err.message}`);
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMembers],
});

setClient(client);
setPanelClient(client);
setVcClient(client);
setLoggerClient(client);
setGiveawayClient(client);
initializeInviteRewardTracking(client);
setSpawnerClient(client);

function buildCommandList(invitesEnabled = true) {
  return [
    panelCommand.data.toJSON(),
    payCommand.data.toJSON(),
    withdrawCommand.data.toJSON(),
    killCommand.data.toJSON(),
    startCommand.data.toJSON(),
    ticketCommand.data.toJSON(),
    giveawayCommand.data.toJSON(),
    setCommand.data.toJSON(),
    lookupCommand.data.toJSON(),
    buildInviteCommand(invitesEnabled).toJSON(),
  ];
}

async function registerCommands(rest, invitesEnabled) {
  const body = buildCommandList(invitesEnabled);
  if (process.env.DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body },
    );
  } else {
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body },
    );
  }
}

const commandMap = {
  panel: panelCommand,
  pay: payCommand,
  withdraw: withdrawCommand,
  kill: killCommand,
  start: startCommand,
  ticket: ticketCommand,
  giveaway: giveawayCommand,
  set: setCommand,
  lookup: lookupCommand,
  invite: inviteCommand,
};

function getInteractionLabel(interaction) {
  if (interaction.isChatInputCommand?.()) return `/${interaction.commandName}`;
  if (interaction.isButton?.()) return `button:${interaction.customId}`;
  if (interaction.isModalSubmit?.()) return `modal:${interaction.customId}`;
  if (interaction.isStringSelectMenu?.()) return `select:${interaction.customId}`;
  return `type:${interaction.type}`;
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(process.env.DISCORD_TOKEN);

  let initialInvitesEnabled = true;
  try {
    const settings = await getSettings();
    initialInvitesEnabled = settings.invitesEnabled !== false;
  } catch (err) {
    console.warn('Could not fetch settings for command registration:', err.message);
  }

  setCommandReregisterFn(async (invitesEnabled) => {
    await registerCommands(rest, invitesEnabled);
    console.log(`Slash commands re-registered (invites ${invitesEnabled ? 'enabled' : 'disabled'}).`);
  });

  try {
    await registerCommands(rest, initialInvitesEnabled);
    console.log(process.env.DISCORD_GUILD_ID
      ? 'Slash commands registered (guild — instant).'
      : 'Slash commands registered globally (may take up to 1 hour).');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  logInfo('Bot Online', `Logged in as **${client.user.tag}**`).catch(() => null);

  // Resume active giveaways
  try {
    await resumeActiveGiveaways();
  } catch (err) {
    console.error('Failed to resume giveaways:', err.message);
  }

  // Initialize voice channel with current balance
  if (process.env.VOICE_CHANNEL_ID) {
    try {
      const { getLtcUsdPrice } = require('./src/lib/price');
      const { getWalletBalanceLtc } = require('./src/lib/ltc');
      const ltcUsd = await getLtcUsdPrice();
      const walletLtc = await getWalletBalanceLtc();
      await updateVoiceChannelName(walletLtc * ltcUsd);
    } catch (err) {
      console.error('Failed to initialize voice channel name:', err.message);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    const ageMs = Date.now() - interaction.createdTimestamp;
    if (ageMs > 2500) {
      console.warn(`[Interaction] Received late ${getInteractionLabel(interaction)} interaction after ${ageMs}ms.`);
    }

    if (interaction.isChatInputCommand()) {
      const command = commandMap[interaction.commandName];
      if (command) {
        await command.execute(interaction);
      }
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === panelCategoryCustomId) {
        await handlePanelCategorySelect(interaction);
      } else if (interaction.customId === flowPaymentMethodCustomId) {
        await handleFlowPaymentMethod(interaction);
      } else if (interaction.customId === flowSpawnerUnitCustomId) {
        await handleFlowSpawnerUnit(interaction);
      }
    }
  } catch (err) {
    if (isStaleInteractionError(err)) {
      console.warn(`[Interaction] Ignored stale response for ${getInteractionLabel(interaction)}: ${err.message}`);
      return;
    }

    console.error('Unhandled interaction error:', err);
    try {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('An unexpected error occurred. Try again or contact an admin.');
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: null, embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      if (!isStaleInteractionError(replyErr)) {
        console.error('Failed to send interaction error response:', replyErr);
      }
    }
  }
});

(async () => {
  try {
    await connectDb();
  } catch (err) {
    console.error('Fatal error during DB connect:', err);
    process.exit(1);
  }

  try {
    await startMinecraftPayer();
  } catch (err) {
    console.warn(`[Minecraft] Could not connect to DonutSMP on startup: ${err.message}`);
    console.warn('[Minecraft] Spawner trades and invite reward payouts will be unavailable until reconnected.');
    logInfo(
      'Minecraft Offline at Startup',
      `Failed to connect to DonutSMP: ${err.message}\n\nSpawner trades and invite reward payouts will be unavailable until the bot reconnects.`,
      [],
      { category: 'invite' },
    ).catch(() => null);
  }

  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('Fatal error during Discord login:', err);
    process.exit(1);
  }
})();
