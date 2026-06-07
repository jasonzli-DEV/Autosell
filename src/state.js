const flowSessions = new Map();
const giveawayEndTimers = new Map();
const giveawayClaimTimers = new Map();
const closeLocks = new Set();

module.exports = { flowSessions, giveawayEndTimers, giveawayClaimTimers, closeLocks };
