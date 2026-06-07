const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getLtcUsdPrice } = require('../lib/price');
const { getWalletBalanceLtc } = require('../lib/ltc');
const { getUserSettings } = require('../lib/userSettings');
const { addToQueueNoAmount } = require('../queue');
const { getBotKilled, getPricePerMillionUsd } = require('../lib/botSettings');
const { updateVoiceChannelName } = require('../lib/voiceChannel');
const {
  btnClosePrefix,
  btnClaimPrefix,
  btnGiveawayJoinPrefix,
  btnGiveawayLeavePrefix,
  btnGiveawayClaimPrefix,
  btnGiveawayHostPaidPrefix,
  btnGiveawayClaimerConfirmPrefix,
  panelCategoryCustomId,
  flowConfirmYes,
  flowConfirmNo,
  flowTermsYes,
  flowTermsNo,
  flowCancelConfirmYes,
  flowCancelConfirmNo,
  btnPriceSetPrefix,
} = require('../lib/autosellConfig');
const {
  handleTicketButton,
  handlePanelCategoryButton,
  handleFlowConfirm,
  handleFlowTerms,
} = require('../systems/tickets');
const { handleGiveawayButton } = require('../systems/giveaway');
const { handlePriceSetButton } = require('../systems/priceSettings');
const {
  inviteRewardCheckCustomId,
  inviteRewardClaimCustomId,
  handleInviteRewardCheck,
  handleInviteRewardClaimButton,
} = require('../systems/inviteRewards');

function formatRate(pricePerMillionUsd) {
  const per100m = pricePerMillionUsd * 100;
  return `${parseFloat(per100m.toFixed(2))}Usd per 100m`;
}

module.exports = async function handleButton(interaction) {
  const { customId } = interaction;

  // ── AutoSell panel buttons ─────────────────────────────────────────────────

  if (customId === 'autosell_settings') {
    const modal = new ModalBuilder()
      .setCustomId('autosell_settings_modal')
      .setTitle('Money AutoSell Settings');

    const ignInput = new TextInputBuilder()
      .setCustomId('ign')
      .setLabel('Minecraft IGN')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. YourUsername')
      .setRequired(true)
      .setMaxLength(32);

    const ltcInput = new TextInputBuilder()
      .setCustomId('ltc_address')
      .setLabel('LTC Address')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. LYour...Address or ltc1q...')
      .setRequired(true)
      .setMaxLength(100);

    modal.addComponents(
      new ActionRowBuilder().addComponents(ignInput),
      new ActionRowBuilder().addComponents(ltcInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (customId === 'autosell_balance') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const ltcUsd = await getLtcUsdPrice();
      const walletLtc = await getWalletBalanceLtc();
      const pricePerMillionUsd = await getPricePerMillionUsd();

      const walletUsd = walletLtc * ltcUsd;
      const maxSellDonuts = (walletUsd / pricePerMillionUsd) * 1_000_000;
      const currentRateValue = `\`${formatRate(pricePerMillionUsd)}\``;
      const usdBalanceValue = `\`$${walletUsd.toFixed(2)}\``;
      const ltcBalanceValue = `\`${walletLtc.toFixed(4)} LTC\``;
      const maxSellValue = `\`${(maxSellDonuts / 1_000_000).toFixed(2)}m\``;

      if (interaction.message?.embeds?.[0]) {
        const panelEmbed = EmbedBuilder.from(interaction.message.embeds[0]).setFields(
          { name: 'Current Rate –', value: currentRateValue, inline: false },
          { name: 'USD Balance –', value: usdBalanceValue, inline: false },
          { name: 'LTC Balance –', value: ltcBalanceValue, inline: false },
          { name: 'Max Sell –', value: maxSellValue, inline: false },
        );
        await interaction.message.edit({ embeds: [panelEmbed] });
      }

      updateVoiceChannelName(walletUsd).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle('Money AutoSell Balance')
        .setColor(0x5865F2)
        .setDescription([
          `**Current Rate**: ${currentRateValue}`,
          `**USD Balance**: ${usdBalanceValue}`,
          `**LTC Balance**: ${ltcBalanceValue}`,
          `**Max Sell**: ${maxSellValue}`,
        ].join('\n'));

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`Failed to fetch balance: ${err.message}`)],
      });
    }
    return;
  }

  if (customId === 'autosell_sell') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (await getBotKilled()) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ The bot is currently paused. Please try again later.')],
      });
    }

    const settings = await getUserSettings(interaction.user.id);
    if (!settings) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Please set IGN and LTC address in Settings first.')],
      });
    }

    const receiverIgn = `${process.env.DONUTSMP_RECEIVER_IGN || ''}`.trim();
    const { ign, ltcAddress } = settings;

    await addToQueueNoAmount({
      userId: interaction.user.id,
      ign,
      ltcAddress,
      receiverIgn,
      status: 'awaiting_payment',
      createdAt: new Date(),
      intervalId: null,
      timeoutId: null,
      ltcAmount: null,
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('Sell Money')
          .setDescription([
            `**User:** <@${interaction.user.id}>`,
            `**IGN:** ${ign}`,
            `Use this in-game command: \`/pay ${receiverIgn} <amount>\``,
            `You can use amounts like \`10m\`, \`25m\`, \`1.5b\`. Minimum: \`10m\`.`,
            `**Important**: the IGN in your settings must match the IGN that pays the bot, or the payment will be ignored.`,
          ].join('\n')),
      ],
    });
    return;
  }

  if (customId === inviteRewardCheckCustomId) {
    await handleInviteRewardCheck(interaction);
    return;
  }

  if (customId === inviteRewardClaimCustomId) {
    await handleInviteRewardClaimButton(interaction);
    return;
  }

  // ── Ticket panel category buttons ──────────────────────────────────────────

  if (customId.startsWith(`${panelCategoryCustomId}:`)) {
    await handlePanelCategoryButton(interaction);
    return;
  }

  // ── Ticket flow confirm/cancel ─────────────────────────────────────────────

  if (customId === flowConfirmYes || customId === flowConfirmNo) {
    await handleFlowConfirm(interaction);
    return;
  }

  if (
    customId === flowTermsYes ||
    customId === flowTermsNo ||
    customId === flowCancelConfirmYes ||
    customId === flowCancelConfirmNo
  ) {
    await handleFlowTerms(interaction);
    return;
  }

  if (customId.startsWith(`${btnPriceSetPrefix}:`)) {
    await handlePriceSetButton(interaction);
    return;
  }

  // ── Ticket claim / close buttons ───────────────────────────────────────────

  if (
    customId.startsWith(`${btnClaimPrefix}:`) ||
    customId.startsWith(`${btnClosePrefix}:`) ||
    customId.startsWith(`${btnGiveawayHostPaidPrefix}:`) ||
    customId.startsWith(`${btnGiveawayClaimerConfirmPrefix}:`)
  ) {
    await handleTicketButton(interaction);
    return;
  }

  // ── Giveaway buttons ────────────────────────────────────────────────────────

  if (
    customId.startsWith(`${btnGiveawayJoinPrefix}:`) ||
    customId.startsWith(`${btnGiveawayLeavePrefix}:`) ||
    customId.startsWith(`${btnGiveawayClaimPrefix}:`)
  ) {
    await handleGiveawayButton(interaction);
    return;
  }
};
