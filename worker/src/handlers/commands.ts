import type { Env } from "../types/env";
import type { BotContext } from "../services/telegram";
import { TelegramService } from "../services/telegram";
import { SupabaseService } from "../services/supabase";

export async function handleCommand(
  ctx: BotContext,
  command: string,
  args: string,
  env: Env
): Promise<boolean> {
  const telegram = new TelegramService(env);
  const supabase = new SupabaseService(env);

  switch (command) {
    case "start":
      await handleStart(ctx, telegram, supabase, env);
      return true;

    case "help":
      await handleHelp(ctx, telegram);
      return true;

    case "status":
      await handleStatus(ctx, telegram, supabase, env);
      return true;

    case "tags":
      await handleTags(ctx, telegram, supabase, env);
      return true;

    case "register":
      await handleRegister(ctx, telegram, supabase, env);
      return true;

    case "portal":
      await handlePortal(ctx, telegram, env);
      return true;

    case "thinking":
      await handleThinking(ctx, args, telegram, supabase, env);
      return true;

    default:
      return false; // Command not handled, treat as regular message
  }
}

async function handleStart(
  ctx: BotContext,
  telegram: TelegramService,
  supabase: SupabaseService,
  env: Env
): Promise<void> {
  const userInfo = telegram.getUserInfo(ctx);
  if (!userInfo) return;

  // Check if user is already registered
  const existingUser = await supabase.getUserByTelegramId(userInfo.id);

  if (existingUser) {
    // Existing user - welcome back
    await telegram.reply(ctx, `Welcome back, ${existingUser.display_name || existingUser.username || "there"}! You're all set.

Send /help for commands, or just talk to me naturally.`);
    return;
  }

  // New user - prompt for invite code
  await telegram.reply(ctx, `Welcome to Mya!

To complete your registration, send:
/register YOUR_INVITE_CODE

Don't have an invite code? Contact ${env.OWNER_NAME || "the admin"}.`);
}

async function handleHelp(
  ctx: BotContext,
  telegram: TelegramService
): Promise<void> {
  await telegram.reply(ctx, `*Commands*

/start - Initialize or reset
/status - Current state summary
/tags - View your tag vocabulary
/thinking - Toggle extended thinking mode
/portal - Access the web portal
/register - Set up web portal access
/help - This message

*Most interaction is natural conversation.*

You can share:
- Text thoughts and updates
- Voice notes (I'll transcribe)
- Images (I'll describe and remember)
- Dreams, synchronicities, insights

I'll tag and organize everything, building context over time.`);
}

async function handleStatus(
  ctx: BotContext,
  telegram: TelegramService,
  supabase: SupabaseService,
  env: Env
): Promise<void> {
  const userInfo = telegram.getUserInfo(ctx);
  if (!userInfo) return;

  const user = await supabase.getUserByTelegramId(userInfo.id);
  if (!user) {
    await telegram.reply(ctx, `You need to register first. Send /start to begin.`);
    return;
  }

  const todayMessages = await supabase.getTodayMessages(user.id);
  const vocabulary = await supabase.getTagVocabulary(user.id);
  const pendingSuggestions = await supabase.getPendingSuggestedTags(user.id);

  // Count today's tags
  const tagCounts: Record<string, number> = {};
  for (const msg of todayMessages) {
    if (msg.tags) {
      for (const tag of msg.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => `${tag} (${count})`)
    .join(", ");

  await telegram.reply(ctx, `*Today's Activity*

Messages: ${todayMessages.length}
Top tags: ${topTags || "none yet"}

*Vocabulary*
Active tags: ${vocabulary.length}
Pending suggestions: ${pendingSuggestions.length}`);
}

async function handleTags(
  ctx: BotContext,
  telegram: TelegramService,
  supabase: SupabaseService,
  env: Env
): Promise<void> {
  const userInfo = telegram.getUserInfo(ctx);
  if (!userInfo) return;

  const user = await supabase.getUserByTelegramId(userInfo.id);
  if (!user) {
    await telegram.reply(ctx, `You need to register first. Send /start to begin.`);
    return;
  }

  const vocabulary = await supabase.getTagVocabulary(user.id);

  const tagList = vocabulary
    .slice(0, 20)
    .map((v) => `• ${v.tag} (${v.usage_count})`)
    .join("\n");

  await telegram.reply(ctx, `*Tag Vocabulary* (${vocabulary.length} total)

${tagList}

Tags are auto-detected from your messages. New tags can be suggested and will be reviewed.`);
}

/**
 * Handle registration - two modes:
 * 1. /register INVITE_CODE - New user claiming invite code (uses secure RPC)
 * 2. /register (no args) - Existing user getting portal passkey link
 *
 * Security:
 * - Rate limiting is handled in webhook handler (5 attempts/15min, then 1hr lockout)
 * - Invite codes are claimed atomically via database RPC
 * - All attempts are logged for audit trail
 * - Generic error messages prevent enumeration
 */
async function handleRegister(
  ctx: BotContext,
  telegram: TelegramService,
  supabase: SupabaseService,
  env: Env
): Promise<void> {
  const userInfo = telegram.getUserInfo(ctx);
  if (!userInfo) return;

  // Extract invite code from message if present
  const messageText = ctx.message?.text || "";
  const parts = messageText.split(/\s+/);
  const inviteCode = parts.length > 1 ? parts[1].toUpperCase().trim() : null;

  // Check if user is already registered
  const existingUser = await supabase.getUserByTelegramId(userInfo.id);

  if (inviteCode) {
    // ========================================
    // MODE 1: New user with invite code
    // ========================================

    if (existingUser) {
      await telegram.reply(
        ctx,
        `You're already registered! Use /register (without a code) to add a new device.`
      );
      return;
    }

    // Attempt to claim the code via secure RPC (handles atomicity + timing attack prevention)
    const result = await supabase.claimInviteCodeSecure(
      inviteCode,
      userInfo.id,
      userInfo.username,
      userInfo.displayName
    );

    if (!result.success) {
      // Log the failed attempt for audit
      await supabase.logAuthEvent(
        userInfo.id,
        userInfo.username,
        "register_attempt",
        false,
        inviteCode,
        result.errorCode,
        "telegram"
      );

      // Generic error message (never reveal why it failed specifically)
      if (result.errorCode === "ALREADY_REGISTERED") {
        await telegram.reply(
          ctx,
          `You're already registered! Use /register (without a code) to add a new device.`
        );
      } else {
        await telegram.reply(
          ctx,
          `Invalid, expired, or already-used invite code.\n\nPlease check your code and try again.`
        );
      }
      return;
    }

    // SUCCESS - Log it
    await supabase.logAuthEvent(
      userInfo.id,
      userInfo.username,
      "register_success",
      true,
      inviteCode,
      null,
      "telegram"
    );

    const userId = result.userId!;

    // Initialize documents for new user
    const { DocumentManager } = await import("../documents/manager");
    const docManager = new DocumentManager(env);
    await docManager.initializeDocuments(userId);

    // Seed initial tags
    await supabase.seedInitialTags(userId);

    // Generate registration token for portal setup
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await supabase.createRegistrationToken(userId, token, expiresAt);

    const portalUrl = env.PORTAL_URL || "https://localhost:5173";
    const registerUrl = `${portalUrl}/login?token=${token}`;

    // Get user info for personalized message
    const newUser = await supabase.getUserById(userId);
    const displayName = newUser?.display_name || "there";

    await telegram.reply(
      ctx,
      `Welcome, ${displayName}!

Your account is now active. Click here to set up your device:

[Open Registration](${registerUrl})

This link expires in 10 minutes. After setting up, you can access the portal at ${portalUrl}`
    );
    return;
  }

  // ========================================
  // MODE 2: Existing user needs portal link
  // ========================================

  if (!existingUser) {
    await telegram.reply(
      ctx,
      `You need to register first.

Send: /register YOUR_INVITE_CODE

Don't have an invite code? Contact the admin.`
    );
    return;
  }

  // Generate secure token for existing user
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Store token (delete any existing ones first)
  await supabase.deleteRegistrationTokens(existingUser.id);
  await supabase.createRegistrationToken(existingUser.id, token, expiresAt);

  const portalUrl = env.PORTAL_URL || "https://localhost:5173";
  const registerUrl = `${portalUrl}/login?token=${token}`;

  await telegram.reply(
    ctx,
    `*Portal Registration*

Here's your one-time registration link. It expires in 10 minutes.

Use this to register a passkey (Face ID, Touch ID, or security key) for the Mya web portal:

[Open Registration](${registerUrl})

After registering, you can sign in to ${portalUrl} anytime using your passkey.`
  );
}

async function handlePortal(
  ctx: BotContext,
  telegram: TelegramService,
  env: Env
): Promise<void> {
  const portalUrl = env.PORTAL_URL || "https://localhost:5173";
  await telegram.reply(ctx, `*Mya Portal*

Access your complete knowledge base via the portal.

The portal includes:
• All documents and conversation history
• Visual canvas showing connections between data
• Full search across everything
• Edit and create documents

*First time?* Use /register to set up passkey access.

[Open Portal](${portalUrl})`);
}

/**
 * Handle /thinking command - toggle extended thinking mode
 * Usage: /thinking [on|off]
 * Without args: shows current state
 */
async function handleThinking(
  ctx: BotContext,
  args: string,
  telegram: TelegramService,
  supabase: SupabaseService,
  env: Env
): Promise<void> {
  const userInfo = telegram.getUserInfo(ctx);
  if (!userInfo) return;

  const user = await supabase.getUserByTelegramId(userInfo.id);
  if (!user) {
    await telegram.reply(ctx, `You need to register first. Send /start to begin.`);
    return;
  }

  // Current setting (default: true)
  const currentSetting = user.settings?.thinking_enabled !== false;
  const arg = args.trim().toLowerCase();

  if (!arg) {
    // Show current status
    const status = currentSetting ? "ON" : "OFF";
    await telegram.reply(ctx, `*Extended Thinking*

Current: ${status}

When ON, I reason through complex questions more thoroughly before responding. You'll see a "Reasoned ~X tokens" indicator.

Usage:
• /thinking on - Enable thinking
• /thinking off - Disable thinking`);
    return;
  }

  if (arg === "on" || arg === "true" || arg === "1") {
    await supabase.updateUserSettings(user.id, { thinking_enabled: true });
    await telegram.reply(ctx, `Extended thinking is now *ON*

I'll reason through questions more thoroughly before responding.`);
  } else if (arg === "off" || arg === "false" || arg === "0") {
    await supabase.updateUserSettings(user.id, { thinking_enabled: false });
    await telegram.reply(ctx, `Extended thinking is now *OFF*

Responses will be faster but may have less depth on complex questions.`);
  } else {
    await telegram.reply(ctx, `Invalid option. Use /thinking on or /thinking off`);
  }
}
