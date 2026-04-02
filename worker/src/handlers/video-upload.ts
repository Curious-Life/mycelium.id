import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { StreamService } from "../services/stream";
import { corsOrigin } from "../utils/cors";

/**
 * Authenticate request using session token
 * Returns user_id if authenticated, null otherwise
 */
async function authenticateRequest(request: Request, env: Env): Promise<string | null> {
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return null;
  }

  const supabase = new SupabaseService(env);
  const session = await supabase.getSession(sessionToken);

  if (!session || new Date(session.expires_at) < new Date()) {
    return null;
  }

  return session.user_id;
}

/**
 * Create a direct upload URL for client-side video uploads
 * This allows clients to upload directly to Cloudflare Stream (up to 200GB)
 * bypassing the Worker's 100MB request body limit
 */
export async function handleCreateDirectUpload(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  try {
    // Authenticate request
    const userId = await authenticateRequest(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Check Stream is configured
    if (!StreamService.isConfigured(env)) {
      return new Response(
        JSON.stringify({ error: "Video uploads not configured" }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Parse request body for optional parameters
    const body = (await request.json().catch(() => ({}))) as {
      maxDurationSeconds?: number;
      filename?: string;
      folderId?: string;
    };

    const maxDuration = Math.min(body.maxDurationSeconds || 1800, 3600); // Cap at 1 hour
    const stream = new StreamService(env);

    // Create direct upload URL
    const { uploadUrl, uid } = await stream.createDirectUpload(maxDuration, 3600);

    return new Response(
      JSON.stringify({
        success: true,
        uploadUrl,
        videoUid: uid,
        // Include metadata that client should send back when finalizing
        metadata: {
          userId,
          filename: body.filename,
          folderId: body.folderId,
        },
      }),
      { headers: corsHeaders }
    );
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("Create direct upload error:", errorMessage);
    return new Response(
      JSON.stringify({ error: "Failed to create upload URL", details: errorMessage }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Finalize a direct video upload - called after client uploads directly to Stream
 * Creates the attachment record in database
 */
export async function handleFinalizeVideoUpload(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  try {
    // Authenticate request
    const userId = await authenticateRequest(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const body = (await request.json()) as {
      videoUid: string;
      filename: string;
      folderId?: string;
    };

    if (!body.videoUid || !body.filename) {
      return new Response(
        JSON.stringify({ error: "videoUid and filename are required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Check Stream is configured
    if (!StreamService.isConfigured(env)) {
      return new Response(
        JSON.stringify({ error: "Video uploads not configured" }),
        { status: 500, headers: corsHeaders }
      );
    }

    const stream = new StreamService(env);

    // Verify video exists and check status
    const status = await stream.getVideoStatus(body.videoUid);
    if (!status) {
      return new Response(
        JSON.stringify({ error: "Video not found or upload failed" }),
        { status: 404, headers: corsHeaders }
      );
    }

    // Video may still be processing - that's OK, we can create the record
    // The status will update automatically

    const supabase = new SupabaseService(env);

    // Sanitize filename
    const sanitizedFilename = body.filename
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/__+/g, "_")
      .substring(0, 200);

    // Create attachment record
    const attachmentData = {
      user_id: userId,
      filename: sanitizedFilename,
      mime_type: "video/mp4", // Stream transcodes to MP4
      size_bytes: 0, // Will be updated when video is ready
      storage_path: "", // Not using R2 for Stream videos
      storage_type: "stream" as const,
      stream_uid: body.videoUid,
      folder_id: body.folderId || null,
    };

    const attachment = await supabase.insertAttachment(attachmentData);

    return new Response(
      JSON.stringify({
        success: true,
        attachment: {
          id: attachment.id,
          filename: attachment.filename,
          streamUid: body.videoUid,
          processingStatus: status.status,
          ready: status.ready,
        },
      }),
      { headers: corsHeaders }
    );
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("Finalize video upload error:", errorMessage);
    return new Response(
      JSON.stringify({ error: "Failed to finalize upload", details: errorMessage }),
      { status: 500, headers: corsHeaders }
    );
  }
}
