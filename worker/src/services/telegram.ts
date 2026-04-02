import { Bot, webhookCallback, Context } from "grammy/web";
import type { Env } from "../types/env";

export type BotContext = Context;

// Telegram message limit
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long message into chunks that fit Telegram's limit
 * Tries to split at paragraph/sentence boundaries when possible
 */
function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH - 100): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point (paragraph, then sentence, then word, then hard cut)
    let splitPoint = -1;

    // Try paragraph break
    const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      splitPoint = paragraphBreak + 2;
    }

    // Try single newline
    if (splitPoint === -1) {
      const lineBreak = remaining.lastIndexOf("\n", maxLength);
      if (lineBreak > maxLength * 0.5) {
        splitPoint = lineBreak + 1;
      }
    }

    // Try sentence end
    if (splitPoint === -1) {
      const sentenceEnd = Math.max(
        remaining.lastIndexOf(". ", maxLength),
        remaining.lastIndexOf("! ", maxLength),
        remaining.lastIndexOf("? ", maxLength)
      );
      if (sentenceEnd > maxLength * 0.5) {
        splitPoint = sentenceEnd + 2;
      }
    }

    // Try word boundary
    if (splitPoint === -1) {
      const wordBreak = remaining.lastIndexOf(" ", maxLength);
      if (wordBreak > maxLength * 0.5) {
        splitPoint = wordBreak + 1;
      }
    }

    // Hard cut if nothing else works
    if (splitPoint === -1) {
      splitPoint = maxLength;
    }

    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}

/**
 * Escape special characters for Telegram Markdown
 * Telegram Markdown is finicky - unmatched special chars cause parse errors
 */
function escapeMarkdown(text: string): string {
  // Count occurrences of special chars - if odd, they're unbalanced
  const underscoreCount = (text.match(/_/g) || []).length;
  const asteriskCount = (text.match(/\*/g) || []).length;
  const backtickCount = (text.match(/`/g) || []).length;

  let result = text;

  // If underscores are unbalanced (used for emphasis), escape them
  if (underscoreCount % 2 !== 0) {
    result = result.replace(/_/g, "\\_");
  }

  // If asterisks are unbalanced, escape them
  if (asteriskCount % 2 !== 0) {
    result = result.replace(/\*/g, "\\*");
  }

  // If backticks are unbalanced, escape them
  if (backtickCount % 2 !== 0) {
    result = result.replace(/`/g, "\\`");
  }

  // Escape square brackets that aren't part of links [text](url)
  // This is tricky - only escape if not followed by (
  result = result.replace(/\[([^\]]+)\](?!\()/g, "\\[$1\\]");

  return result;
}

export class TelegramService {
  private bot: Bot;
  private ownerId: string;

  constructor(env: Env) {
    this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    this.ownerId = env.OWNER_TELEGRAM_ID;
  }

  getBot(): Bot {
    return this.bot;
  }

  /**
   * Create webhook handler for Cloudflare Workers
   */
  createWebhookHandler(): (request: Request) => Promise<Response> {
    return webhookCallback(this.bot, "cloudflare-mod");
  }

  /**
   * Check if message is from the owner
   */
  isFromOwner(ctx: BotContext): boolean {
    return ctx.from?.id.toString() === this.ownerId;
  }

  /**
   * Send typing indicator
   */
  async sendTyping(ctx: BotContext): Promise<void> {
    await ctx.replyWithChatAction("typing");
  }

  /**
   * Reply with markdown - handles long messages and parsing errors
   * Splits messages > 4096 chars and falls back to plain text on parse errors
   */
  async reply(ctx: BotContext, text: string): Promise<void> {
    const chunks = splitMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLastChunk = i === chunks.length - 1;

      // Add continuation indicator for multi-part messages
      const prefix = chunks.length > 1 && i > 0 ? "" : "";
      const suffix = chunks.length > 1 && !isLastChunk ? "\n\n..." : "";
      const messageText = prefix + chunk + suffix;

      try {
        // Try markdown first with escaped special chars
        await ctx.reply(escapeMarkdown(messageText), { parse_mode: "Markdown" });
      } catch (markdownError) {
        console.warn("Markdown parse failed, trying plain text:", markdownError);
        try {
          // Fall back to plain text
          await ctx.reply(messageText);
        } catch (plainError) {
          console.error("Plain text reply also failed:", plainError);
          // If even plain text fails, try a simple error message
          if (i === 0) {
            try {
              await ctx.reply("I have a response but encountered an error sending it. Please try again.");
            } catch {
              // Last resort failed - nothing more we can do
              console.error("All reply attempts failed");
            }
          }
        }
      }

      // Small delay between chunks to avoid rate limiting
      if (!isLastChunk) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Send message directly to a chat (for scheduled messages)
   * Handles long messages and parsing errors
   */
  async sendMessage(chatId: string | number, text: string): Promise<void> {
    const chunks = splitMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLastChunk = i === chunks.length - 1;
      const suffix = chunks.length > 1 && !isLastChunk ? "\n\n..." : "";
      const messageText = chunk + suffix;

      try {
        await this.bot.api.sendMessage(chatId, escapeMarkdown(messageText), { parse_mode: "Markdown" });
      } catch (markdownError) {
        console.warn("Markdown parse failed, trying plain text:", markdownError);
        try {
          await this.bot.api.sendMessage(chatId, messageText);
        } catch (plainError) {
          console.error("Plain text send also failed:", plainError);
        }
      }

      if (!isLastChunk) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Send message to context chat and return message object
   */
  async sendMessageToCtx(ctx: BotContext, text: string): Promise<{ message_id: number }> {
    const msg = await ctx.reply(text, { parse_mode: "Markdown" });
    return { message_id: msg.message_id };
  }

  /**
   * Delete a message from context chat
   */
  async deleteMessage(ctx: BotContext, messageId: number): Promise<void> {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, messageId);
    } catch {
      // Ignore deletion errors (message may already be deleted)
    }
  }

  /**
   * Download file from Telegram
   */
  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("File path not available");
    }

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    return response.arrayBuffer();
  }

  /**
   * Set webhook URL
   */
  async setWebhook(url: string, secret: string): Promise<boolean> {
    await this.bot.api.setWebhook(url, {
      secret_token: secret,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
    return true;
  }

  /**
   * Verify webhook secret
   */
  verifySecret(request: Request, secret: string): boolean {
    const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    return headerSecret === secret;
  }

  /**
   * Extract command from message
   */
  extractCommand(text: string | undefined): { command: string; args: string } | null {
    if (!text || !text.startsWith("/")) return null;

    const parts = text.split(" ");
    const command = parts[0].substring(1).split("@")[0]; // Remove / and @botname
    const args = parts.slice(1).join(" ");

    return { command, args };
  }

  /**
   * Get message content (text, caption, or transcribed voice)
   */
  getMessageContent(ctx: BotContext): string | undefined {
    return ctx.message?.text || ctx.message?.caption;
  }

  /**
   * Check if message has voice
   */
  hasVoice(ctx: BotContext): boolean {
    return !!ctx.message?.voice;
  }

  /**
   * Check if message has photo
   */
  hasPhoto(ctx: BotContext): boolean {
    return !!ctx.message?.photo && ctx.message.photo.length > 0;
  }

  /**
   * Check if message has video
   */
  hasVideo(ctx: BotContext): boolean {
    return !!ctx.message?.video;
  }

  /**
   * Check if message has video note (circular video message)
   */
  hasVideoNote(ctx: BotContext): boolean {
    return !!ctx.message?.video_note;
  }

  /**
   * Get voice file ID
   */
  getVoiceFileId(ctx: BotContext): string | undefined {
    return ctx.message?.voice?.file_id;
  }

  /**
   * Get largest photo file ID
   */
  getPhotoFileId(ctx: BotContext): string | undefined {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return undefined;
    // Get the largest photo (last in array)
    return photos[photos.length - 1].file_id;
  }

  /**
   * Get video file ID
   */
  getVideoFileId(ctx: BotContext): string | undefined {
    return ctx.message?.video?.file_id;
  }

  /**
   * Get video thumbnail file ID (provided by Telegram)
   */
  getVideoThumbnailFileId(ctx: BotContext): string | undefined {
    // Video thumbnail - Telegram generates this automatically
    return ctx.message?.video?.thumbnail?.file_id;
  }

  /**
   * Get video note file ID (circular video)
   */
  getVideoNoteFileId(ctx: BotContext): string | undefined {
    return ctx.message?.video_note?.file_id;
  }

  /**
   * Get video note thumbnail file ID
   */
  getVideoNoteThumbnailFileId(ctx: BotContext): string | undefined {
    return ctx.message?.video_note?.thumbnail?.file_id;
  }

  /**
   * Get video duration in seconds
   */
  getVideoDuration(ctx: BotContext): number | undefined {
    return ctx.message?.video?.duration || ctx.message?.video_note?.duration;
  }

  /**
   * Get video MIME type
   */
  getVideoMimeType(ctx: BotContext): string {
    return ctx.message?.video?.mime_type || "video/mp4";
  }

  /**
   * Check if message has a document (file attachment)
   */
  hasDocument(ctx: BotContext): boolean {
    return !!ctx.message?.document;
  }

  /**
   * Get document file ID
   */
  getDocumentFileId(ctx: BotContext): string | undefined {
    return ctx.message?.document?.file_id;
  }

  /**
   * Get document filename
   */
  getDocumentFilename(ctx: BotContext): string | undefined {
    return ctx.message?.document?.file_name;
  }

  /**
   * Get document MIME type
   */
  getDocumentMimeType(ctx: BotContext): string | undefined {
    return ctx.message?.document?.mime_type;
  }

  /**
   * Get document file size
   */
  getDocumentFileSize(ctx: BotContext): number | undefined {
    return ctx.message?.document?.file_size;
  }

  /**
   * Check if document is a text file (by MIME type or extension)
   */
  isTextDocument(ctx: BotContext): boolean {
    const mimeType = (this.getDocumentMimeType(ctx) || "").toLowerCase();
    const filename = (this.getDocumentFilename(ctx) || "").toLowerCase();

    // Check MIME type first
    const textMimeTypes = [
      "text/plain",
      "text/markdown",
      "text/x-markdown",
      "application/x-markdown",
      "text/csv",
      "application/json",
      "text/json",
    ];
    if (textMimeTypes.includes(mimeType)) return true;

    // Check file extension
    const textExtensions = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"];
    if (textExtensions.some(ext => filename.endsWith(ext))) return true;

    // application/octet-stream with text extension is likely text
    if (mimeType === "application/octet-stream" && textExtensions.some(ext => filename.endsWith(ext))) return true;

    return false;
  }

  /**
   * Check if document is an office document (needs Claude processing)
   */
  isOfficeDocument(ctx: BotContext): boolean {
    const mimeType = (this.getDocumentMimeType(ctx) || "").toLowerCase();
    const filename = (this.getDocumentFilename(ctx) || "").toLowerCase();

    // Office document MIME types
    const officeMimeTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "application/msword", // .doc
      "application/vnd.oasis.opendocument.text", // .odt
      "application/rtf", // .rtf
      "text/rtf",
      "application/pdf", // PDF
    ];
    if (officeMimeTypes.includes(mimeType)) return true;

    // Office document extensions
    const officeExtensions = [".docx", ".doc", ".odt", ".rtf", ".pdf"];
    if (officeExtensions.some(ext => filename.endsWith(ext))) return true;

    return false;
  }

  /**
   * Get user info
   */
  getUserInfo(ctx: BotContext): { id: number; username?: string; displayName: string } | null {
    const user = ctx.from;
    if (!user) return null;

    return {
      id: user.id,
      username: user.username,
      displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || "User",
    };
  }
}
