const mongoose = require('mongoose');
const { TICKET_TYPES, STATUS, GIVEAWAY_STATUS } = require('./autosellConfig');

const ticketSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    channelId: { type: String, required: true, unique: true },
    parentCategoryId: { type: String, required: true },
    openerId: { type: String, required: true },
    ticketType: { type: String, enum: Object.values(TICKET_TYPES), required: true },
    status: { type: String, enum: Object.values(STATUS), default: STATUS.OPEN },
    claimedBy: { type: String, default: null },
    addedUsers: { type: [String], default: [] },
    details: { type: Object, default: {} },
    closedAt: Date,
    closedBy: String,
  },
  { timestamps: true },
);

const giveawaySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    messageId: String,
    prizeText: { type: String, required: true },
    winnersCount: { type: Number, default: 1 },
    entrants: { type: [String], default: [] },
    winnerIds: { type: [String], default: [] },
    claimedByIds: { type: [String], default: [] },
    status: { type: String, enum: Object.values(GIVEAWAY_STATUS), default: GIVEAWAY_STATUS.ACTIVE },
    entryEndsAt: { type: Date, required: true },
    claimEndsAt: Date,
    claimDurationMs: { type: Number, default: 6 * 60 * 60 * 1000 },
    closeReason: String,
    createdBy: String,
  },
  { timestamps: true },
);

const inviteRewardInviteSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    inviterId: { type: String, required: true },
    inviterTag: { type: String, default: null },
    memberId: { type: String, required: true },
    memberTag: { type: String, default: null },
    inviteCode: { type: String, default: null },
    joinedAt: { type: Date, required: true },
    accountCreatedAt: { type: Date, required: true },
    fake: { type: Boolean, default: false },
    rejoin: { type: Boolean, default: false },
    leftAt: { type: Date, default: null },
    claimStatus: { type: String, enum: ['open', 'pending', 'paid'], default: 'open' },
    claimLockId: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    claimId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

inviteRewardInviteSchema.index({ guildId: 1, inviterId: 1 });
inviteRewardInviteSchema.index({ guildId: 1, memberId: 1 });
inviteRewardInviteSchema.index({ claimLockId: 1 });

const inviteRewardClaimSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    inviterId: { type: String, required: true },
    ign: { type: String, required: true },
    memberIds: { type: [String], default: [] },
    inviteCount: { type: Number, required: true },
    payoutPerInvite: { type: Number, required: true },
    amount: { type: Number, required: true },
    payCommand: { type: String, required: true },
    status: { type: String, enum: ['paid', 'failed'], default: 'paid' },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

inviteRewardClaimSchema.index({ guildId: 1, inviterId: 1 });

const Ticket = mongoose.model('Ticket', ticketSchema);
const Giveaway = mongoose.model('Giveaway', giveawaySchema);
const InviteRewardInvite = mongoose.model('InviteRewardInvite', inviteRewardInviteSchema);
const InviteRewardClaim = mongoose.model('InviteRewardClaim', inviteRewardClaimSchema);

module.exports = { Ticket, Giveaway, InviteRewardInvite, InviteRewardClaim };
