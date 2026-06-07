const { EmbedBuilder, MessageFlags } = require('discord.js');
const { validateIgn } = require('../lib/donut');
const { validateLtcAddress } = require('../lib/ltc');
const { addToQueue, hasActiveTrade } = require('../queue');
const { setUserSettings, getUserSettings } = require('../lib/userSettings');
const {
  flowSellMoneyModal,
  flowSellSpawnersModal,
  flowBuyModal,
  flowSupportModal,
  flowBuyMoneyModal,
  flowBuySpawnersModal,
  priceSetModalPrefix,
  giveawayClaimIgnModalPrefix,
} = require('../lib/autosellConfig');
const { handleFlowModal } = require('../systems/tickets');
const { handleGiveawayClaimIgnModal } = require('../systems/giveaway');
const { handlePriceSetModal } = require('../systems/priceSettings');
const { inviteRewardClaimModalCustomId, handleInviteRewardClaimModal } = require('../systems/inviteRewards');

function errEmbed(description) {
  return new EmbedBuilder().setColor(0xED4245).setDescription(description);
}

module.exports = async function handleModal(interaction) {
  const { customId, user } = interaction;

  if (customId === 'autosell_settings_modal') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ign = interaction.fields.getTextInputValue('ign').trim();
    const ltcAddress = interaction.fields.getTextInputValue('ltc_address').trim();

    if (!validateLtcAddress(ltcAddress)) {
      return interaction.editReply({
        embeds: [errEmbed('Invalid LTC address. Double-check it.\nAccepted: `L...` (legacy), `M...` (P2SH), `ltc1...` (bech32)')],
      });
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Validating IGN...')],
    });

    let ignResult;
    try {
      ignResult = await validateIgn(ign);
    } catch (err) {
      return interaction.editReply({
        embeds: [errEmbed(`Couldn't validate IGN: ${err.message}`)],
      });
    }

    if (!ignResult.valid) {
      return interaction.editReply({
        embeds: [errEmbed(ignResult.reason)],
      });
    }

    try {
      await setUserSettings(user.id, ignResult.normalized, ltcAddress);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setDescription(`✅ Settings saved!\n**IGN:** ${ignResult.normalized}\n**LTC Address:** ${ltcAddress.slice(0, 10)}...`),
        ],
      });
    } catch (err) {
      return interaction.editReply({
        embeds: [errEmbed(`Failed to save settings: ${err.message}`)],
      });
    }
    return;
  }

  // ── Ticket flow modals ─────────────────────────────────────────────────────

  if (
    customId === flowSellMoneyModal ||
    customId === flowSellSpawnersModal ||
    customId === flowBuyMoneyModal ||
    customId === flowBuySpawnersModal ||
    customId === flowBuyModal ||
    customId === flowSupportModal
  ) {
    await handleFlowModal(interaction);
    return;
  }

  if (customId.startsWith(`${priceSetModalPrefix}:`)) {
    await handlePriceSetModal(interaction);
    return;
  }

  // ── Giveaway claim IGN modal ───────────────────────────────────────────────

  if (customId.startsWith(`${giveawayClaimIgnModalPrefix}:`)) {
    await handleGiveawayClaimIgnModal(interaction);
    return;
  }

  if (customId === inviteRewardClaimModalCustomId) {
    await handleInviteRewardClaimModal(interaction);
    return;
  }
};
