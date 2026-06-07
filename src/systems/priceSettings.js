const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getSettings, updateSettings } = require('../lib/botSettings');
const { formatTicketPanelPrices, getMoneyBuyPrice } = require('../lib/sellPricing');
const { refreshPanel } = require('../lib/panelManager');
const { btnPriceSetPrefix, priceSetModalPrefix } = require('../lib/autosellConfig');
const { buildTicketPanel, buildPanelButtonRow } = require('./tickets');

const PRICE_FIELDS = {
  money_buy: {
    label: 'Buy Money',
    title: 'Set Buy Money Price',
    setting: 'moneyBuyPricePerMillion',
    description: 'USD we pay per 1m DonutSMP money',
    example: '0.038',
  },
  money_sell: {
    label: 'Sell Money',
    title: 'Set Sell Money Price',
    setting: 'moneySellPricePerMillion',
    description: 'USD customers pay per 1m DonutSMP money',
    example: '0.05',
  },
  spawner_buy: {
    label: 'Buy Spawner',
    title: 'Set Buy Spawner Price',
    setting: 'spawnerBuyPriceEach',
    description: 'USD we pay per skeleton spawner',
    example: '0.16',
  },
  spawner_sell: {
    label: 'Sell Spawner',
    title: 'Set Sell Spawner Price',
    setting: 'spawnerSellPriceEach',
    description: 'USD customers pay per skeleton spawner',
    example: '0.2',
  },
};

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isAdmin(interaction) {
  return getAdminIds().includes(interaction.user.id);
}

function pricePanelPayload(settings) {
  const priceText = formatTicketPanelPrices(settings);
  const moneyBuy = getMoneyBuyPrice(settings) || settings.moneyBuyPricePerMillion || 0.038;

  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [
      new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              '## ⚙️ Price Settings',
              '',
              `**We Buy Money:** ${priceText.moneyPerBillion} ($${moneyBuy} per 1m)`,
              `**We Sell Money:** ${priceText.moneySellPerBillion} ($${settings.moneySellPricePerMillion || 0} per 1m)`,
              `**We Buy Skeleton Spawners:** ${priceText.spawnerEach} / ${priceText.spawnerShulker}`,
              `**We Sell Skeleton Spawners:** ${priceText.spawnerSellEach} / ${priceText.spawnerSellShulker}`,
              '',
              'Spawner shulker prices are calculated from the per-spawner price.',
            ].join('\n'),
          ),
        ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${btnPriceSetPrefix}:money_buy`).setLabel('Buy Money').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${btnPriceSetPrefix}:money_sell`).setLabel('Sell Money').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${btnPriceSetPrefix}:spawner_buy`).setLabel('Buy Spawner').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${btnPriceSetPrefix}:spawner_sell`).setLabel('Sell Spawner').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function refreshTicketPanel(interaction) {
  const settings = await getSettings();
  if (!settings.ticketPanelChannelId || !settings.ticketPanelMessageId) return;

  const channel = await interaction.client.channels.fetch(settings.ticketPanelChannelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(settings.ticketPanelMessageId).catch(() => null);
  if (!message) return;

  await message.edit({
    components: [
      buildTicketPanel(
        getMoneyBuyPrice(settings) || 0.038,
        settings.spawnerBuyPriceEach || 0.16,
        settings.moneySellPricePerMillion || 0.05,
        settings.spawnerSellPriceEach || 0.2,
      ),
      buildPanelButtonRow(),
    ],
  }).catch(() => null);
}

async function refreshAutosellPanel() {
  const settings = await getSettings();
  if (!settings.panelChannelId || !settings.panelMessageId) return;
  await refreshPanel(settings.panelChannelId, settings.panelMessageId);
}

async function handleSetPricePanel(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('You do not have permission to use this command.'),
        ),
      ],
    });
  }

  const settings = await getSettings();
  return interaction.reply(pricePanelPayload(settings));
}

async function handlePriceSetButton(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('You do not have permission to use this panel.'),
        ),
      ],
    });
  }

  const key = `${interaction.customId || ''}`.split(':')[1];
  const field = PRICE_FIELDS[key];
  if (!field) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('Invalid price setting.'),
        ),
      ],
    });
  }

  const settings = await getSettings();
  const current = Number(settings[field.setting] || 0);
  const modal = new ModalBuilder()
    .setCustomId(`${priceSetModalPrefix}:${key}`)
    .setTitle(field.title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('price')
          .setLabel(field.description.slice(0, 45))
          .setPlaceholder(`Example: ${field.example}`)
          .setValue(current > 0 ? `${current}` : '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20),
      ),
    );

  return interaction.showModal(modal);
}

async function handlePriceSetModal(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('You do not have permission to use this panel.'),
        ),
      ],
    });
  }

  const key = `${interaction.customId || ''}`.split(':')[1];
  const field = PRICE_FIELDS[key];
  const price = Number(interaction.fields.getTextInputValue('price'));
  if (!field || !Number.isFinite(price) || price <= 0) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('Enter a valid price above 0.'),
        ),
      ],
    });
  }

  if (field.setting === 'moneyBuyPricePerMillion') {
    const settings = await updateSettings({
      pricePerMillionUsd: price,
      moneyBuyPricePerMillion: price,
    });
    await refreshTicketPanel(interaction);
    await refreshAutosellPanel();
    return interaction.reply(pricePanelPayload(settings));
  }

  const updates = { [field.setting]: price };
  const settings = await updateSettings(updates);
  await refreshTicketPanel(interaction);

  return interaction.reply(pricePanelPayload(settings));
}

module.exports = {
  handleSetPricePanel,
  handlePriceSetButton,
  handlePriceSetModal,
  pricePanelPayload,
};
