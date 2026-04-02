/**
 * Handler for importing MYA chat logs
 * Processes consciousness_acceleration_mvp/output/all_chats_combined.json
 */

import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { parseMyaLogs, analyzeMyaLogs, type ParsedMyaMessage } from "../parsers/mya-logs";
import { corsOrigin } from "../utils/cors";

function makeCorsHeaders(request: Request) {
  return {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Token",
  };
}

/**
 * Analyze MYA logs file without importing
 * POST /api/import-mya-logs/analyze
 */
export async function handleAnalyzeMyaLogs(request: Request, env: Env): Promise<Response> {
  try {
    // Get session token from header
    const sessionToken = request.headers.get("X-Session-Token");
    if (!sessionToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      });
    }

    // Verify session and get user
    const supabase = new SupabaseService(env);
    const session = await supabase.getSession(sessionToken);
    if (!session || new Date(session.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "Session expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      });
    }
    const userId = session.user_id;

    // Get file from form data
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      });
    }

    // Read file content
    const content = await file.text();

    // Parse and analyze
    let analysis;
    try {
      analysis = analyzeMyaLogs(content);
    } catch (parseError: any) {
      return new Response(
        JSON.stringify({
          error: "Failed to parse MYA logs file",
          details: parseError.message,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
        }
      );
    }

    // Check for existing messages (deduplication preview)
    const messages = parseMyaLogs(content);
    const existingCount = await checkExistingMessages(supabase, userId, messages);

    return new Response(
      JSON.stringify({
        analysis,
        deduplication: {
          total: messages.length,
          existing: existingCount,
          new: messages.length - existingCount,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      }
    );
  } catch (error: any) {
    console.error("Error analyzing MYA logs:", error);
    return new Response(
      JSON.stringify({ error: "Failed to analyze file", details: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      }
    );
  }
}

/**
 * Import MYA logs into messages table
 * POST /api/import-mya-logs
 */
export async function handleImportMyaLogs(request: Request, env: Env): Promise<Response> {
  try {
    // Get session token from header
    const sessionToken = request.headers.get("X-Session-Token");
    if (!sessionToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      });
    }

    // Verify session and get user
    const supabase = new SupabaseService(env);
    const session = await supabase.getSession(sessionToken);
    if (!session || new Date(session.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "Session expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      });
    }
    const userId = session.user_id;

    // Get file from form data
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      });
    }

    // Read and parse file
    const content = await file.text();
    let messages: ParsedMyaMessage[];
    try {
      messages = parseMyaLogs(content);
    } catch (parseError: any) {
      return new Response(
        JSON.stringify({
          error: "Failed to parse MYA logs file",
          details: parseError.message,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
        }
      );
    }

    // Import messages (with deduplication)
    const stats = await importMessages(supabase, userId, messages);

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
    });
  } catch (error: any) {
    console.error("Error importing MYA logs:", error);
    return new Response(
      JSON.stringify({ error: "Failed to import", details: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...makeCorsHeaders(request) },
      }
    );
  }
}

/**
 * Check how many messages already exist (for deduplication preview)
 */
async function checkExistingMessages(
  supabase: SupabaseService,
  userId: string,
  messages: ParsedMyaMessage[]
): Promise<number> {
  // Sample from beginning, middle, and end to get representative coverage
  const sampleSize = Math.min(100, messages.length);
  const indices: number[] = [];

  // Distribute samples across the entire message range
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor((i / sampleSize) * messages.length);
    if (!indices.includes(idx)) {
      indices.push(idx);
    }
  }

  const sample = indices.map(i => messages[i]);
  let existingCount = 0;

  for (const msg of sample) {
    // Check for existing message with same timestamp AND role
    const existing = await supabase.client
      .from("messages")
      .select("id")
      .eq("user_id", userId)
      .eq("created_at", msg.timestamp.toISOString())
      .eq("role", msg.role)
      .limit(1);

    if (existing.data && existing.data.length > 0) {
      existingCount++;
    }
  }

  // Extrapolate to full dataset
  const ratio = existingCount / sample.length;
  return Math.round(messages.length * ratio);
}

/**
 * Import messages into database with deduplication
 * Processes in chunks: for each chunk, query existing timestamps, then insert new ones
 * Memory efficient - doesn't load all existing timestamps at once
 */
async function importMessages(
  supabase: SupabaseService,
  userId: string,
  messages: ParsedMyaMessage[]
): Promise<{
  total: number;
  imported: number;
  skipped: number;
  errors: number;
}> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  // Process in chunks of 100 messages at a time
  const chunkSize = 100;

  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    const chunkTimestamps = chunk.map(m => m.timestamp.toISOString());

    // Query which timestamp+role combinations from this chunk already exist
    // Use 'in' filter on timestamps, then filter by role in memory
    // (Supabase doesn't support composite 'in' filters)
    const existingResult = await supabase.client
      .from("messages")
      .select("created_at, role")
      .eq("user_id", userId)
      .in("created_at", chunkTimestamps);

    // Create composite keys for existing messages (timestamp:role)
    const existingSet = new Set(
      (existingResult.data || []).map(row => `${row.created_at}:${row.role}`)
    );

    // Filter to only new messages in this chunk (check timestamp + role)
    const newInChunk = chunk.filter(msg => {
      const compositeKey = `${msg.timestamp.toISOString()}:${msg.role}`;
      if (existingSet.has(compositeKey)) {
        skipped++;
        return false;
      }
      return true;
    });

    // Batch insert new messages from this chunk (50 at a time)
    const insertBatchSize = 50;
    for (let j = 0; j < newInChunk.length; j += insertBatchSize) {
      const batch = newInChunk.slice(j, j + insertBatchSize);
      const records = batch.map(msg => ({
        user_id: userId,
        role: msg.role,
        content: msg.content,
        message_type: 'text',
        metadata: msg.metadata,
        created_at: msg.timestamp.toISOString(),
      }));

      try {
        const result = await supabase.client.from("messages").insert(records);

        if (result.error) {
          console.error("Error inserting batch:", result.error);
          errors += batch.length;
        } else {
          imported += batch.length;
        }
      } catch (error) {
        console.error("Error processing batch:", error);
        errors += batch.length;
      }
    }

    // Log progress every 500 messages
    if ((i + chunkSize) % 500 === 0 || i + chunkSize >= messages.length) {
      console.log(`Progress: ${Math.min(i + chunkSize, messages.length)}/${messages.length} processed, ${imported} imported, ${skipped} skipped`);
    }
  }

  return {
    total: messages.length,
    imported,
    skipped,
    errors,
  };
}
