const path = require('path');
const { EventEmitter } = require('events');
const { logInfo, logSuccess, logError } = require('./logger');

const DEFAULT_HOST = 'donutsmp.net';
const DEFAULT_PORT = 25565;
const DEFAULT_AUTH = 'microsoft';
const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;
const DEFAULT_PROFILES_FOLDER = path.join(process.cwd(), '.minecraft-auth');
const AUTH_PROFILE = 'invite-reward-payer';
const PACKET_TRACE_LIMIT = 80;
const PAYMENT_REPLY_LOG_LIMIT = 5;
const PAYMENT_REPLY_LOG_WINDOW_MS = 5_000;

class MinecraftPayoutError extends Error {
  constructor(message, { type = 'minecraft_error' } = {}) {
    super(message);
    this.name = 'MinecraftPayoutError';
    this.type = type;
  }
}

class DonutMinecraftPayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bot = null;
    this.connected = false;
    this.connecting = null;
    this.manuallyDisconnected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.paymentQueue = Promise.resolve();
  }

  getConfig() {
    return {
      host: this.options.host || DEFAULT_HOST,
      port: Number(this.options.port || DEFAULT_PORT),
      auth: this.options.auth || DEFAULT_AUTH,
      version: this.options.version || '',
      profilesFolder: this.options.profilesFolder || DEFAULT_PROFILES_FOLDER,
    };
  }

  async connect() {
    if (this.connected && this.bot) return this.bot;
    if (this.connecting) return this.connecting;

    const config = this.getConfig();
    const username = getMinecraftAuthProfile();

    this.connecting = new Promise((resolve, reject) => {
      let mineflayer;
      try {
        mineflayer = require('mineflayer');
      } catch (err) {
        reject(new MinecraftPayoutError('mineflayer is not installed. Run npm install before starting the bot.'));
        return;
      }

      this.manuallyDisconnected = false;
      this.clearReconnectTimer();
      this.destroyBot();

      const botOptions = buildMinecraftBotOptions({ config, mineflayer });

      console.log(`[InviteRewards] Connecting Minecraft payer to ${config.host}:${config.port} as ${username}.`);
      this.bot = mineflayer.createBot(botOptions);

      // physics plugin is disabled — its lookAt awaits a physics-tick promise that
      // never resolves, so activateBlock (called by openBlock) hangs forever before
      // writing block_place. Override unconditionally: calculate rotation, send a
      // look packet immediately, and return without waiting.
      this.bot.lookAt = async (point) => {
        const bot = this.bot;
        if (!point || !bot.entity?.position) return;
        try {
          const packet = buildPositionLookPacket(bot.entity, point);
          bot.entity.yaw = packet._yaw;
          bot.entity.pitch = packet._pitch;
          bot._client.write('look', {
            yaw: packet.yaw,
            pitch: packet.pitch,
            onGround: true,                                           // pre-1.21.3
            flags: { onGround: true, hasHorizontalCollision: false }, // 1.21.3+
          });
        } catch {}
      };

      // Physics is disabled, so the bot never sends a serverbound position packet.
      // Without one the server has no confirmed client position and silently drops
      // block interactions (e.g. opening an enderchest never fires windowOpen). Send
      // a position_look establishing where we stand, on the ground, optionally aimed
      // at a target block, before interacting. Version-safe: include both the legacy
      // onGround boolean and the 1.21.3+ flags object.
      this.bot.sendServerPosition = (lookAtPoint = null) => {
        const bot = this.bot;
        if (!bot?.entity?.position) return;
        try {
          const packet = buildPositionLookPacket(bot.entity, lookAtPoint);
          bot.entity.yaw = packet._yaw;
          bot.entity.pitch = packet._pitch;
          bot._client.write('position_look', {
            x: packet.x,
            y: packet.y,
            z: packet.z,
            yaw: packet.yaw,
            pitch: packet.pitch,
            onGround: true,                                           // pre-1.21.3
            flags: { onGround: true, hasHorizontalCollision: false }, // 1.21.3+
          });
        } catch {}
      };
      const packetTrace = attachPacketDiagnostics(this.bot);

      const failBeforeSpawn = (err) => {
        if (this.connected) return;
        reject(err);
      };

      this.bot.once('spawn', () => {
        this.connected = true;
        this.connecting = null;
        this.reconnectAttempts = 0;
        const actualUsername = this.bot.username || this.bot.player?.username || 'unknown';
        console.log(`[InviteRewards] Minecraft payer connected as ${actualUsername} (auth profile ${username}).`);
        logSuccess(
          'Invite Reward Minecraft Online',
          `Connected to **${config.host}** as Minecraft user **${actualUsername}**.\nAuth cache profile: \`${username}\`.`,
          [],
          { category: 'invite' },
        ).catch(() => null);
        this.emit('ready', this.bot);
        resolve(this.bot);
      });

      this.bot.on('messagestr', (message, position, jsonMsg) => {
        this.emit('serverMessage', { message, position, jsonMsg });
        this.emit('message', message);
      });
      this.bot.on('message', (jsonMsg) => this.emit('rawMessage', jsonMsg));

      // Physics is disabled, so mineflayer never sends teleport_confirm.
      // Without it the server doesn't register the bot at teleported positions,
      // breaking item pickup. Confirm every incoming position packet manually.
      this.bot._client.on('packet', (data, meta) => {
        if (
          meta?.name !== 'position' &&
          meta?.name !== 'player_position_and_look' &&
          meta?.name !== 'synchronize_player_position'
        ) return;
        if (typeof data?.teleportId === 'number') {
          try { this.bot._client.write('teleport_confirm', { teleportId: data.teleportId }); } catch {}
        }
      });

      this.bot.on('error', (err) => {
        console.warn('[InviteRewards] Minecraft payer error:', err.message);
        failBeforeSpawn(err);
      });

      this.bot.on('kicked', (reason) => {
        const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
        console.warn('[InviteRewards] Minecraft payer kicked:', text.slice(0, 200));
        failBeforeSpawn(new Error(`Kicked from DonutSMP: ${text.slice(0, 200)}`));
        this.handleDisconnect('kicked');
      });

      this.bot.on('end', (reason) => {
        console.warn('[InviteRewards] Minecraft payer disconnected:', reason || 'ended');
        failBeforeSpawn(new Error(`Connection ended before spawn: ${reason || 'ended'}`));
        this.handleDisconnect(reason || 'ended');
      });
    }).finally(() => {
      if (!this.connected) this.connecting = null;
    });

    return this.connecting;
  }

  destroyBot() {
    if (!this.bot) return;
    try {
      this.bot.removeAllListeners();
      this.bot.quit();
    } catch {
      // ignore shutdown cleanup failures
    }
    this.bot = null;
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  handleDisconnect() {
    this.connected = false;
    this.connecting = null;
    this.destroyBot();
    if (this.manuallyDisconnected) return;
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 5_000 * this.reconnectAttempts);
    console.log(`[InviteRewards] Reconnecting Minecraft payer in ${Math.round(delay / 1000)}s.`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.warn('[InviteRewards] Minecraft reconnect failed:', err.message);
        this.scheduleReconnect();
      }
    }, delay);
  }

  disconnect() {
    this.manuallyDisconnected = true;
    this.connected = false;
    this.connecting = null;
    this.clearReconnectTimer();
    this.destroyBot();
  }

  async ensureConnected() {
    if (this.connected && this.bot) return this.bot;
    return this.connect();
  }

  async sendPayment(ign, amount, parser, timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS) {
    this.paymentQueue = this.paymentQueue
      .catch(() => null)
      .then(() => this.sendPaymentNow(ign, amount, parser, timeoutMs));
    return this.paymentQueue;
  }

  async sendPaymentNow(ign, amount, parser, timeoutMs) {
    const bot = await this.ensureConnected();
    const command = `/pay ${ign} ${Math.trunc(amount)}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopReplyLogging();
        this.off('serverMessage', onPaymentMessage);
        fn(value);
      };

      let replyLogCount = 0;
      const stopReplyLogging = () => {
        clearTimeout(replyLogTimer);
        this.off('serverMessage', onServerMessage);
      };
      const onServerMessage = ({ message, position } = {}) => {
        replyLogCount += 1;
        logInfo(
          `Invite Reward Minecraft Reply ${replyLogCount}/${PAYMENT_REPLY_LOG_LIMIT}`,
          `${message || '(empty message)'}`,
          [
            { name: 'Command', value: `\`${command}\``, inline: false },
            { name: 'Position', value: `\`${position || 'unknown'}\``, inline: true },
          ],
          { category: 'invite' },
        ).catch(() => null);
        if (replyLogCount >= PAYMENT_REPLY_LOG_LIMIT) stopReplyLogging();
      };
      const replyLogTimer = setTimeout(stopReplyLogging, PAYMENT_REPLY_LOG_WINDOW_MS);

      const onPaymentMessage = ({ message, position } = {}) => {
        const parsed = parser(message, position);
        if (!parsed) return;
        if (parsed.type === 'paid') {
          finish(resolve, { ok: true, command, message });
          return;
        }
        if (parsed.type === 'insufficient_balance') {
          finish(reject, new MinecraftPayoutError('The Minecraft account has insufficient DonutSMP balance.', { type: 'insufficient_balance' }));
          return;
        }
        if (parsed.type === 'payment_rejected') {
          finish(reject, new MinecraftPayoutError('DonutSMP could not process the payment.', { type: 'payment_rejected' }));
          return;
        }
        if (parsed.type === 'invalid_player') {
          finish(reject, new MinecraftPayoutError('DonutSMP rejected the target player.', { type: 'invalid_player' }));
        }
      };

      const timer = setTimeout(() => {
        finish(reject, new MinecraftPayoutError('No DonutSMP payment confirmation was received.', { type: 'confirmation_timeout' }));
      }, timeoutMs);

      this.on('serverMessage', onServerMessage);
      this.on('serverMessage', onPaymentMessage);
      bot.chat(command);
    });
  }
}

function getMinecraftAuthProfile() {
  return AUTH_PROFILE;
}

function getMinecraftVersion(config, mineflayer) {
  const configured = `${config.version || ''}`.trim();
  if (configured) return configured;
  return mineflayer?.latestSupportedVersion || '1.21.11';
}

// Builds the serverbound position/look fields for a physics-disabled bot.
// Returns notch-converted yaw/pitch (the protocol units) plus the raw radian
// values (_yaw/_pitch) so callers can keep bot.entity rotation in sync.
//   toNotchianYaw  = (PI - yaw) * 180/PI    (0=south, 90=west, 180=north …)
//   toNotchianPitch = -pitch * 180/PI        (-90=up, 0=horizontal, 90=down)
function buildPositionLookPacket(entity, lookAtPoint = null) {
  const pos = entity?.position ?? { x: 0, y: 0, z: 0 };
  let yaw = entity?.yaw ?? 0;
  let pitch = entity?.pitch ?? 0;

  if (lookAtPoint) {
    const ey = pos.y + (entity?.eyeHeight ?? 1.62);
    const dx = lookAtPoint.x - pos.x;
    const dy = lookAtPoint.y - ey;
    const dz = lookAtPoint.z - pos.z;
    yaw = Math.atan2(-dx, -dz);
    pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  }

  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    yaw: Math.fround((Math.PI - yaw) * 180 / Math.PI),
    pitch: Math.fround(-pitch * 180 / Math.PI),
    onGround: true,
    flags: { onGround: true, hasHorizontalCollision: false },
    _yaw: yaw,
    _pitch: pitch,
  };
}

function buildMinecraftBotOptions({ config, mineflayer }) {
  return {
    host: config.host,
    port: config.port,
    username: getMinecraftAuthProfile(),
    auth: config.auth,
    profilesFolder: config.profilesFolder,
    version: getMinecraftVersion(config, mineflayer),
    hideErrors: true,
    plugins: { physics: false },
  };
}

function safeStringify(value, maxLength = 240) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function pushTrace(trace, entry) {
  trace.push({
    at: new Date().toISOString(),
    ...entry,
  });
  if (trace.length > PACKET_TRACE_LIMIT) trace.splice(0, trace.length - PACKET_TRACE_LIMIT);
}

function attachPacketDiagnostics(bot) {
  const trace = [];
  const client = bot?._client;
  if (!client) return trace;

  client.on('packet', (data, metadata, buffer) => {
    pushTrace(trace, {
      direction: 'in',
      state: metadata?.state || client.state || 'unknown',
      name: metadata?.name || 'unknown',
      size: buffer?.length || 0,
      hex: buffer?.toString('hex')?.slice(0, 96) || '',
      summary: safeStringify(data),
    });
  });

  const originalWrite = client.write.bind(client);
  client.write = (name, params) => {
    pushTrace(trace, {
      direction: 'out',
      state: client.state || 'unknown',
      name,
      size: 0,
      summary: safeStringify(params),
    });
    return originalWrite(name, params);
  };

  client.on('state', (next, previous) => {
    pushTrace(trace, {
      direction: 'state',
      state: next,
      name: `${previous || 'unknown'}->${next}`,
      size: 0,
    });
  });

  return trace;
}

function formatPacketTraceForLog(trace = []) {
  if (!trace.length) return '(no packets captured)';
  return trace.map((entry, index) => {
    const direction = entry.direction === 'in'
      ? 'clientbound'
      : entry.direction === 'out'
        ? 'serverbound'
        : 'state';
    const size = Number.isFinite(entry.size) ? `${entry.size}b` : '?b';
    const hex = entry.hex ? ` hex=${entry.hex}` : '';
    const summary = entry.summary ? ` ${entry.summary}` : '';
    return `${String(index + 1).padStart(2, '0')} ${direction} ${entry.state || 'unknown'}.${entry.name || 'unknown'} ${size}${hex}${summary}`;
  }).join('\n');
}

const payer = new DonutMinecraftPayer();

async function startMinecraftPayer() {
  return payer.connect();
}

async function sendDonutPayment(ign, amount, parser) {
  return payer.sendPayment(ign, amount, parser);
}

function getPayerBot() {
  return payer.bot;
}

module.exports = {
  DonutMinecraftPayer,
  MinecraftPayoutError,
  buildMinecraftBotOptions,
  buildPositionLookPacket,
  getMinecraftAuthProfile,
  formatPacketTraceForLog,
  startMinecraftPayer,
  sendDonutPayment,
  getPayerBot,
};
