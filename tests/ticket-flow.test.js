const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TICKET_TYPES,
  panelCategoryCustomId,
  flowConfirmYes,
  flowTermsNo,
  flowCancelConfirmNo,
  flowKey,
} = require('../src/lib/autosellConfig');
const { flowSessions } = require('../src/state');
const {
  handlePanelCategoryButton,
  handleFlowConfirm,
  handleFlowTerms,
} = require('../src/systems/tickets');

function makeInteraction(customId) {
  const calls = [];
  return {
    customId,
    guild: { id: 'guild-1' },
    user: { id: 'user-1' },
    member: { id: 'user-1', displayName: 'Ticket Opener', user: { username: 'ticketopener' } },
    calls,
    async update(payload) {
      calls.push(['update', payload]);
      this.replied = true;
    },
    async reply(payload) {
      calls.push(['reply', payload]);
      this.replied = true;
    },
    async deferUpdate() {
      calls.push(['deferUpdate']);
      this.deferred = true;
    },
    async showModal(payload) {
      calls.push(['showModal', payload]);
      this.replied = true;
    },
  };
}

function payloadText(payload) {
  return JSON.stringify(payload);
}

test('confirming an order routes to Aura-style terms before creating a ticket', async () => {
  flowSessions.clear();
  flowSessions.set(flowKey('guild-1', 'user-1'), {
    guildId: 'guild-1',
    userId: 'user-1',
    type: TICKET_TYPES.SELL_MONEY,
    createdAt: Date.now(),
    details: {
      ign: 'Homer',
      amountText: '10b',
      estimatedUsd: 380,
    },
  });

  const interaction = makeInteraction(flowConfirmYes);
  await handleFlowConfirm(interaction);

  assert.equal(interaction.calls[0][0], 'update');
  const text = payloadText(interaction.calls[0][1]);
  assert.match(text, /Terms & Conditions/);
  assert.match(text, /Agree to terms before creating this ticket/);
});

test('main ticket chooser button starts the selected ticket flow', async () => {
  flowSessions.clear();

  const interaction = makeInteraction(`${panelCategoryCustomId}:${TICKET_TYPES.SELL_MONEY}`);
  await handlePanelCategoryButton(interaction);

  assert.equal(interaction.calls[0][0], 'showModal');
  assert.equal(
    flowSessions.get(flowKey('guild-1', 'user-1')).type,
    TICKET_TYPES.SELL_MONEY,
  );
});

test('declining terms shows a cancel confirmation and no-go-back returns to terms', async () => {
  flowSessions.clear();
  flowSessions.set(flowKey('guild-1', 'user-1'), {
    guildId: 'guild-1',
    userId: 'user-1',
    type: TICKET_TYPES.SELL_SPAWNERS,
    createdAt: Date.now(),
    details: {
      ign: 'Homer',
      shulkers: '2',
      estimatedUsd: 540,
    },
  });

  const decline = makeInteraction(flowTermsNo);
  await handleFlowTerms(decline);

  assert.match(payloadText(decline.calls[0][1]), /Cancel Setup/);

  const goBack = makeInteraction(flowCancelConfirmNo);
  await handleFlowTerms(goBack);

  assert.match(payloadText(goBack.calls[0][1]), /Terms & Conditions/);
});
