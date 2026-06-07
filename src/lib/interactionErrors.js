const STALE_INTERACTION_ERROR_CODES = new Set([
  10062, // Unknown interaction: the acknowledgement window expired.
  40060, // Interaction has already been acknowledged.
]);

function getDiscordErrorCode(err) {
  return err?.code ?? err?.rawError?.code;
}

function isStaleInteractionError(err) {
  return STALE_INTERACTION_ERROR_CODES.has(getDiscordErrorCode(err));
}

module.exports = { isStaleInteractionError };
