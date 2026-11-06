'use strict';
/**
 * Per-bot "join command" settings: an optional chat message or /command that a bot sends once it
 * is inside the server after (re)connecting. Pure helper functions so they stay easy to test.
 */

const MAX_COMMAND = 256;
const RUN_ON = ['reconnect', 'always'];

/**
 * Validates and normalizes the reconnect settings of one bot.
 * Fields that are missing in `input` keep the value from `previous`.
 */
function normalizeReconnectSettings(input, previous = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const prev = previous && typeof previous === 'object' ? previous : {};

  const commandEnabled = src.commandEnabled !== undefined ? !!src.commandEnabled : !!prev.commandEnabled;
  const command = src.command !== undefined ? String(src.command).trim() : String(prev.command || '');
  if (command.length > MAX_COMMAND) throw new Error(`Command: at most ${MAX_COMMAND} characters`);
  if (/[\r\n\u0000]/.test(command)) throw new Error('Command: only a single line is allowed');
  if (commandEnabled && !command) throw new Error('The reconnect command is enabled but empty');

  const delaySec = src.delaySec !== undefined ? Number(src.delaySec) : (prev.delaySec ?? 5);
  if (!Number.isInteger(delaySec) || delaySec < 0 || delaySec > 120) throw new Error('Wait time: a whole number between 0 and 120 seconds is required');

  const runOn = src.runOn !== undefined ? String(src.runOn) : (prev.runOn || 'reconnect');
  if (!RUN_ON.includes(runOn)) throw new Error('Run on: choose "reconnect" or "always"');

  return { commandEnabled, command, delaySec, runOn };
}

/** What the dashboard receives. */
function publicReconnectSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    commandEnabled: !!s.commandEnabled,
    command: String(s.command || ''),
    delaySec: s.delaySec ?? 5,
    runOn: RUN_ON.includes(s.runOn) ? s.runOn : 'reconnect',
  };
}

module.exports = { normalizeReconnectSettings, publicReconnectSettings, RUN_ON };
