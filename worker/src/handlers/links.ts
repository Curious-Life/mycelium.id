import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { corsOrigin } from "../utils/cors";

/**
 * Search documents for wiki link autocomplete
 * GET /api/links/search?q=query
 */
export async function handleSearchDocuments(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") || "";

    if (!query || query.length < 2) {
      return new Response(JSON.stringify({ documents: [] }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const documents = await supabase.searchDocumentsForLinking(userId, query, 10);

    return new Response(JSON.stringify({ documents }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("Document search error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to search documents" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Get backlinks for a document
 * GET /api/links/backlinks?document_id=uuid
 */
export async function handleGetBacklinks(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const url = new URL(request.url);
    const documentId = url.searchParams.get("document_id");

    if (!documentId) {
      return new Response(
        JSON.stringify({ error: "document_id required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const backlinks = await supabase.getBacklinks(userId, documentId);

    return new Response(JSON.stringify({ backlinks }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("Backlinks fetch error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch backlinks" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Resolve a wiki link target to a document
 * GET /api/links/resolve?target=Document%20Name
 */
export async function handleResolveLink(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const url = new URL(request.url);
    const target = url.searchParams.get("target");

    if (!target) {
      return new Response(
        JSON.stringify({ error: "target required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Try to find document by path (exact match or fuzzy)
    const document = await supabase.resolveWikiLinkTarget(userId, target);

    if (document) {
      return new Response(JSON.stringify({
        resolved: true,
        document: {
          id: document.id,
          path: document.path,
          title: document.title
        }
      }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({
      resolved: false,
      target
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("Link resolution error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to resolve link" }),
      { status: 500, headers: corsHeaders }
    );
  }
}
