import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { flattenOpenAIConversation, type OpenAIConversation } from "../parsers/openai";
import { corsOrigin } from "../utils/cors";

interface OpenAIImportResult {
  conversations: number;
  messages: number;
  skipped_duplicates: number;
  errors: string[];
}

/**
 * Handle OpenAI (ChatGPT) conversation export import
 */
export async function handleImportOpenAI(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token from header
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Verify session
  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const body = await request.json() as {
      conversations?: OpenAIConversation[];
    };

    if (!body.conversations) {
      return new Response(
        JSON.stringify({ error: "No conversations provided" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Get existing message UUIDs for dedup
    const existingMessages = await supabase.getMessagesByMetadataField(
      userId,
      "openai_message_id"
    );
    const existingUuids = new Set<string>();
    for (const msg of existingMessages) {
      const uuid = (msg.metadata as Record<string, unknown>)?.openai_message_id;
      if (uuid) existingUuids.add(uuid as string);
    }

    const stats: OpenAIImportResult = {
      conversations: 0,
      messages: 0,
      skipped_duplicates: 0,
      errors: [],
    };

    const messagesToInsert: Array<{
      user_id: string;
      role: "user" | "assistant";
      content: string;
      message_type: "text";
      tags: null;
      entities_people: null;
      entities_projects: null;
      suggested_new_tag: null;
      attachment_id: null;
      folder_id: null;
      embedding: null;
      metadata: Record<string, unknown>;
      created_at: string;
    }> = [];

    for (const conv of body.conversations) {
      try {
        const flatMessages = flattenOpenAIConversation(conv);
        stats.conversations++;

        for (const msg of flatMessages) {
          if (existingUuids.has(msg.uuid)) {
            stats.skipped_duplicates++;
            continue;
          }

          messagesToInsert.push({
            user_id: userId,
            role: msg.role,
            content: msg.content,
            message_type: "text",
            tags: null,
            entities_people: null,
            entities_projects: null,
            suggested_new_tag: null,
            attachment_id: null,
            folder_id: null,
            embedding: null,
            metadata: {
              source: "openai_export",
              openai_message_id: msg.uuid,
              conversation_title: conv.title,
              original_created_at: msg.created_at,
            },
            created_at: msg.created_at,
          });
        }
      } catch (e) {
        const err = e as Error;
        stats.errors.push(`Failed to process conversation "\${conv.title}": \${err.message}`);
      }
    }

    // Batch insert
    if (messagesToInsert.length > 0) {
      const inserted = await supabase.insertMessagesBatch(messagesToInsert);
      stats.messages = inserted;
    }

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("Error importing OpenAI export:", error);
    return new Response(
      JSON.stringify({ error: "Failed to import export" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Analyze OpenAI export to show deduplication stats before importing
 */
export async function handleAnalyzeOpenAI(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token from header
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Verify session
  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const body = await request.json() as {
      conversations?: OpenAIConversation[];
    };

    if (!body.conversations) {
      return new Response(
        JSON.stringify({ error: "No conversations provided" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Get existing message UUIDs
    const existingMessages = await supabase.getMessagesByMetadataField(
      userId,
      "openai_message_id"
    );
    const existingUuids = new Set<string>();
    for (const msg of existingMessages) {
      const uuid = (msg.metadata as Record<string, unknown>)?.openai_message_id;
      if (uuid) existingUuids.add(uuid as string);
    }

    // Count total and new messages
    let total = 0;
    let existing = 0;

    for (const conv of body.conversations) {
      const flatMessages = flattenOpenAIConversation(conv);
      for (const msg of flatMessages) {
        total++;
        if (existingUuids.has(msg.uuid)) {
          existing++;
        }
      }
    }

    const analysis = {
      total,
      new: total - existing,
      existing,
      conversations: body.conversations.length,
    };

    return new Response(JSON.stringify(analysis), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("Error analyzing OpenAI export:", error);
    return new Response(
      JSON.stringify({ error: "Failed to analyze export" }),
      { status: 500, headers: corsHeaders }
    );
  }
}
