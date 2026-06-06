/**
 * Operator commands (Phase 3 group binding) — the control plane the operator
 * uses to authorize the bot in a group. Distilled from the canonical telegram
 * bot's /allow · /disallow · /channels handlers, minus the multi-space/portal
 * coupling (single-user: no space resolution).
 *
 * Only the OWNER can run commands. Commands are never captured into the vault
 * and never trigger an agent turn — they're control-plane, not conversation.
 * Their acknowledgements are sent through the egress chokepoint with
 * `trusted:true` (system-template provenance — bypasses the authority gate so
 * the ack to a not-yet-authorized group still lands, and is audited).
 */

const HELP = [
  'Mycelium assistant — operator commands:',
  '/allow — authorize me to respond in THIS group',
  '/disallow — stop responding in this group',
  '/channels — list groups I respond in',
].join('\n');

/**
 * @param {object} deps
 * @param {object} deps.vault                 vault client (group methods)
 * @param {(a:{chatId:any,text:string,replyToMessageId?:any})=>Promise<any>} deps.sendReply  system reply via chokepoint
 * @param {string} deps.ownerTelegramId
 * @param {string} [deps.logPrefix]
 */
export function createCommandHandler({ vault, sendReply, ownerTelegramId, logPrefix = 'channel-daemon' }) {
  if (!vault) throw new TypeError('createCommandHandler: vault required');
  if (typeof sendReply !== 'function') throw new TypeError('createCommandHandler: sendReply required');

  function isCommand(content) {
    return typeof content === 'string' && content.trim().startsWith('/');
  }

  function isOwner(msg) {
    return !!ownerTelegramId && String(msg.fromId) === String(ownerTelegramId);
  }

  /** Handle a command message. Returns true iff it was consumed as a command. */
  async function handle(msg) {
    if (!isCommand(msg.content)) return false;
    // Non-owner commands are swallowed (not captured, not answered) — control
    // plane is owner-only.
    if (!isOwner(msg)) {
      console.warn(`[${logPrefix}] ignoring command from non-owner chat=${msg.chatId}`);
      return true;
    }

    const cmd = msg.content.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, ''); // strip @botname
    const reply = (text) => sendReply({ chatId: msg.chatId, text, replyToMessageId: msg.messageId });
    const inGroup = msg.channelKind === 'telegram-group';

    switch (cmd) {
      case '/allow':
        if (!inGroup) { await reply('Run /allow inside a group to authorize me there.'); return true; }
        await vault.authorizeTelegramGroup({ id: msg.chatId, title: msg.chatTitle });
        console.log(`[${logPrefix}] group authorized: ${msg.chatId}`);
        await reply('✓ Authorized. I’ll respond in this group now.');
        return true;

      case '/disallow':
        if (!inGroup) { await reply('Run /disallow inside the group you want me to leave.'); return true; }
        await vault.revokeTelegramGroup(msg.chatId);
        console.log(`[${logPrefix}] group revoked: ${msg.chatId}`);
        await reply('Stopped. I’ll no longer respond in this group.');
        return true;

      case '/channels': {
        const groups = await vault.listTelegramGroups();
        const body = groups.length
          ? 'Groups I respond in:\n' + groups.map((g) => `• ${g.title || g.id}`).join('\n')
          : 'No groups authorized yet. Add me to a group and run /allow.';
        await reply(body);
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
