const TICKET_TYPES = {
  SELL_MONEY: 'sell_money',
  SELL_SPAWNERS: 'sell_spawners',
  BUY_MONEY: 'buy_money',
  BUY_SPAWNERS: 'buy_spawners',
  BUY: 'buy',
  SUPPORT: 'support',
};

const TICKET_CATEGORY_NAMES = {
  [TICKET_TYPES.SELL_MONEY]: '「Sell Money Tickets」',
  [TICKET_TYPES.SELL_SPAWNERS]: '「Sell Spawner Tickets」',
  [TICKET_TYPES.BUY_MONEY]: '「Buy Money Tickets」',
  [TICKET_TYPES.BUY_SPAWNERS]: '「Buy Spawner Tickets」',
  [TICKET_TYPES.BUY]: '「Buy Tickets」',
  [TICKET_TYPES.SUPPORT]: '「Support Tickets」',
};

const STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CLOSED: 'closed',
};

const STATUS_ICON = {
  [STATUS.OPEN]: '🟩',
  [STATUS.IN_PROGRESS]: '🟨',
  [STATUS.COMPLETED]: '🟥',
  [STATUS.CLOSED]: 'closed',
};

const GIVEAWAY_STATUS = {
  ACTIVE: 'active',
  CLAIMABLE: 'claimable',
  CLOSED: 'closed',
};

const GIVEAWAY_CLAIM_FLOW_STATE = {
  AWAITING_HOST_PAID: 'awaiting_host_paid',
  AWAITING_CLAIMER_CONFIRM: 'awaiting_claimer_confirm',
  COMPLETED: 'completed',
};

const FLOW_TTL_MS = 10 * 60 * 1000;

// Panel select menu
const panelCategoryCustomId = 'panel_category';
const flowPaymentMethodCustomId = 'flow_payment_method';
const flowSpawnerUnitCustomId = 'flow_spawner_unit';

// Flow modals
const flowSellMoneyModal = 'flow_sell_money_modal';
const flowSellSpawnersModal = 'flow_sell_spawners_modal';
const flowBuyMoneyModal = 'flow_buy_money_modal';
const flowBuySpawnersModal = 'flow_buy_spawners_modal';
const flowBuyModal = 'flow_buy_modal';
const flowSupportModal = 'flow_support_modal';

// Price setting panel
const btnPriceSetPrefix = 'price_set';
const priceSetModalPrefix = 'price_set_modal';

// Flow confirm order / cancel
const flowConfirmYes = 'flow_confirm_yes';
const flowConfirmNo = 'flow_confirm_no';

// Flow terms agree / cancel
const flowTermsYes = 'flow_terms_yes';
const flowTermsNo = 'flow_terms_no';

// Flow cancel-confirmation (when user clicks Cancel on terms)
const flowCancelConfirmYes = 'flow_cancel_confirm_yes';
const flowCancelConfirmNo = 'flow_cancel_confirm_no';

// Ticket buttons
const btnClosePrefix = 'tkt_close';
const btnClaimPrefix = 'tkt_claim';

// Giveaway buttons
const btnGiveawayJoinPrefix = 'gw_join';
const btnGiveawayLeavePrefix = 'gw_leave';
const btnGiveawayClaimPrefix = 'gw_claim';
const btnGiveawayHostPaidPrefix = 'gw_host_paid';
const btnGiveawayClaimerConfirmPrefix = 'gw_claimer_confirm';
const giveawayClaimIgnModalPrefix = 'gw_claim_ign';

function flowKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

module.exports = {
  TICKET_TYPES,
  TICKET_CATEGORY_NAMES,
  STATUS,
  STATUS_ICON,
  GIVEAWAY_STATUS,
  GIVEAWAY_CLAIM_FLOW_STATE,
  FLOW_TTL_MS,
  panelCategoryCustomId,
  flowPaymentMethodCustomId,
  flowSpawnerUnitCustomId,
  flowSellMoneyModal,
  flowSellSpawnersModal,
  flowBuyMoneyModal,
  flowBuySpawnersModal,
  flowBuyModal,
  flowSupportModal,
  btnPriceSetPrefix,
  priceSetModalPrefix,
  flowConfirmYes,
  flowConfirmNo,
  flowTermsYes,
  flowTermsNo,
  flowCancelConfirmYes,
  flowCancelConfirmNo,
  btnClosePrefix,
  btnClaimPrefix,
  btnGiveawayJoinPrefix,
  btnGiveawayLeavePrefix,
  btnGiveawayClaimPrefix,
  btnGiveawayHostPaidPrefix,
  btnGiveawayClaimerConfirmPrefix,
  giveawayClaimIgnModalPrefix,
  flowKey,
};
