/**
 * Discord operator commands — /allow · /disallow · /channels, owner-only. Mirrors
 * commands.js (Telegram) but backed by the Discord channel allowlist
 * (identity_channels kind 'discord' via the vault). Acks go through the Discord
 * egress chokepoint as trusted (system-template) sends.
 */
const HELP = [
  'Mycelium assistant — operator commands:',
  '/allow — respond in THIS channel',
  '/disallow — stop responding in this channel',
  '/channels — list channels I respond in',
].join('\n');

/**
 * @param {object} deps
 * @param {{setDiscordChannel:Function, listDiscordChannels:Function}} deps.vault
 * @param {(a:{channelId:any,content:string,replyToMessageId?:any})=>Promise<any>} deps.sendReply
 * @param {string} deps.ownerDiscordId
 * @param {string} [deps.logPrefix]
 */
export function createDiscordCommandHandler({ vault, sendReply, ownerDiscordId, logPrefix = 'channel-daemon' }) {
  if (!vault) throw new TypeError('createDiscordCommandHandler: vault required');
  if (typeof sendReply !== 'function') throw new TypeError('createDiscordCommandHandler: sendReply required');

  const isCommand = (c) => typeof c === 'string' && c.trim().startsWith('/');
  const isOwner = (msg) => !!ownerDiscordId && String(msg.fromId) === String(ownerDiscordId);

  async function handle(msg) {
    if (!isCommand(msg.content)) return false;
    if (!isOwner(msg)) { console.warn(`[${logPrefix}] ignoring discord command from non-owner ${msg.fromId}`); return true; }

    const cmd = msg.content.trim().split(/\s+/)[0].toLowerCase();
    const reply = (content) => sendReply({ channelId: msg.chatId, content, replyToMessageId: msg.messageId });

    switch (cmd) {
      case '/allow':
        await vault.setDiscordChannel({ id: msg.chatId, name: msg.chatTitle, on: true });
        console.log(`[${logPrefix}] discord channel authorized: ${msg.chatId}`);
        await reply('✓ Authorized. I’ll respond in this channel now.');
        return true;
      case '/disallow':
        await vault.setDiscordChannel({ id: msg.chatId, name: msg.chatTitle, on: false });
        console.log(`[${logPrefix}] discord channel disallowed: ${msg.chatId}`);
        await reply('Stopped. I’ll no longer respond in this channel.');
        return true;
      case '/channels': {
        const chans = await vault.listDiscordChannels();
        await reply(chans.length ? 'Channels I respond in:\n' + chans.map((c) => `• ${c.name || c.id}`).join('\n') : 'No channels authorized yet. Run /allow in a channel.');
        return true;
      }
      case '/start':
      case '/help':
        await reply(HELP);
        return true;
      default:
        await reply(`Unknown command ${cmd}. Try /help.`);
        return true;
    }
  }

  return { isCommand, handle };
}
