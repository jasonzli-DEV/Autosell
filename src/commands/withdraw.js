const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { sendLtc, validateLtcAddress, getWalletBalanceLtc } = require('../lib/ltc');
const { getSettings } = require('../lib/botSettings');
const { refreshPanel } = require('../lib/panelManager');
const { logSuccess, logError } = require('../lib/logger');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Withdraw LTC from the bot wallet (admins only)')
    .addStringOption(opt =>
      opt.setName('address').setDescription('Your LTC wallet address').setRequired(true),
    )
    .addNumberOption(opt =>
      opt
        .setName('amount')
        .setDescription('Amount of LTC to withdraw (e.g. 0.5)')
        .setRequired(true)
        .setMinValue(0.0001),
    ),

  async execute(interaction) {
    if (!getAdminIds().includes(interaction.user.id)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const address = interaction.options.getString('address').trim();
    const amount = interaction.options.getNumber('amount');

    if (!validateLtcAddress(address)) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Invalid LTC address.')],
      });
    }

    try {
      const balance = await getWalletBalanceLtc();
      if (amount > balance) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xED4245)
              .setDescription(`❌ Insufficient balance. Wallet has **${balance.toFixed(8)} LTC**, you requested **${amount.toFixed(8)} LTC**.`),
          ],
        });
      }

      const txHash = await sendLtc(address, amount);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Withdrawal Sent')
            .addFields(
              { name: 'Amount', value: `${amount.toFixed(8)} LTC`, inline: true },
              { name: 'To', value: `\`${address}\``, inline: false },
              { name: 'TX Hash', value: `\`${txHash}\``, inline: false },
              { name: 'Explorer', value: `https://live.blockcypher.com/ltc/tx/${txHash}/`, inline: false },
            ),
        ],
      });

      logSuccess('Withdrawal Sent', `<@${interaction.user.id}> withdrew from the bot wallet`, [
        { name: 'Amount', value: `${amount.toFixed(8)} LTC`, inline: true },
        { name: 'To', value: address, inline: false },
        { name: 'TX Hash', value: txHash, inline: false },
      ], { category: 'ltc' }).catch(() => null);

      const settings = await getSettings();
      if (settings.panelChannelId && settings.panelMessageId) {
        await refreshPanel(settings.panelChannelId, settings.panelMessageId);
      }
    } catch (err) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Withdrawal failed: ${err.message}`)],
      });
      logError('Withdrawal Failed', `<@${interaction.user.id}> attempted withdrawal — ${err.message}`, [], { category: 'ltc' }).catch(() => null);
    }
  },
};
