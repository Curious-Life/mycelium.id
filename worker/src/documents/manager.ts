import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";
import type { Document, InsertDocument } from "../types/database";
import { ALL_TEMPLATES, type DocumentTemplate } from "./templates";
import { extractWikiLinks, getUniqueLinkTargets, resolveWikiLink } from "../parsers/wikilinks";

export interface DocumentEntry {
  timestamp: string;
  type: "observation" | "shift" | "note" | "wondering";
  confidence: "low" | "medium" | "provisional";
  content: string;
  context?: string;
}

export class DocumentManager {
  private supabase: SupabaseService;
  private workersAI: WorkersAIService;

  constructor(env: Env) {
    this.supabase = new SupabaseService(env);
    this.workersAI = new WorkersAIService(env);
  }

  /**
   * Initialize all documents for a new user
   */
  async initializeDocuments(userId: string): Promise<void> {
    for (const template of ALL_TEMPLATES) {
      const existing = await this.supabase.getDocument(userId, template.path);
      if (!existing) {
        await this.createDocument(userId, template);
      }
    }
  }

  /**
   * Create a document from template
   * Note: Template documents are structural and don't belong in any folder.
   * Only user content routed via #hashtag goes to folders.
   */
  async createDocument(userId: string, template: DocumentTemplate): Promise<Document> {
    const embedding = await this.workersAI.generateEmbedding(template.content);

    const doc: InsertDocument = {
      user_id: userId,
      path: template.path,
      title: template.title,
      content: template.content,
      summary: this.generateInitialSummary(template),
      is_internal: template.isInternal,
      folder_id: null, // Template docs don't belong in folders
      metadata: {},
    };

    return await this.supabase.upsertDocument(doc);
  }

  /**
   * Get a document by path
   */
  async getDocument(userId: string, path: string): Promise<Document | null> {
    return await this.supabase.getDocument(userId, path);
  }

  /**
   * Add an entry to a document (for state/log documents)
   */
  async addEntry(
    userId: string,
    path: string,
    entry: DocumentEntry
  ): Promise<Document> {
    const doc = await this.supabase.getDocument(userId, path);
    if (!doc) {
      throw new Error(`Document not found: ${path}`);
    }

    // Format entry
    const formattedEntry = this.formatEntry(entry);

    // Find insertion point (after "## Recent" or "## Log" section)
    let newContent: string;
    const recentMatch = doc.content.match(/(## Recent\n+)/);
    const logMatch = doc.content.match(/(## Log\n+)/);
    const dreamLogMatch = doc.content.match(/(## Dream Log\n+)/);

    if (recentMatch) {
      const insertPoint = recentMatch.index! + recentMatch[0].length;
      newContent =
        doc.content.slice(0, insertPoint) +
        formattedEntry +
        "\n\n" +
        doc.content.slice(insertPoint);
    } else if (logMatch) {
      const insertPoint = logMatch.index! + logMatch[0].length;
      newContent =
        doc.content.slice(0, insertPoint) +
        formattedEntry +
        "\n\n" +
        doc.content.slice(insertPoint);
    } else if (dreamLogMatch) {
      const insertPoint = dreamLogMatch.index! + dreamLogMatch[0].length;
      newContent =
        doc.content.slice(0, insertPoint) +
        formattedEntry +
        "\n\n" +
        doc.content.slice(insertPoint);
    } else {
      // Append to end
      newContent = doc.content + "\n\n" + formattedEntry;
    }

    // Update document
    return await this.updateDocument(userId, path, newContent, "bot", entry.content);
  }

  /**
   * Update a document's content
   */
  async updateDocument(
    userId: string,
    path: string,
    newContent: string,
    changedBy: "user" | "bot" | "reflection",
    changeSummary?: string
  ): Promise<Document> {
    const doc = await this.supabase.getDocument(userId, path);
    if (!doc) {
      throw new Error(`Document not found: ${path}`);
    }

    // Store version diff
    const diff = this.createDiff(doc.content, newContent);
    await this.supabase.insertDocumentVersion(doc.id, diff, changedBy, changeSummary);

    // Generate new embedding
    const embedding = await this.workersAI.generateEmbedding(newContent);

    // Update document
    const updated: InsertDocument = {
      user_id: userId,
      path,
      title: doc.title,
      content: newContent,
      summary: await this.generateSummary(newContent, path),
      is_internal: doc.is_internal,
      metadata: doc.metadata,
    };

    const result = await this.supabase.upsertDocument(updated);

    // Extract and update wiki links
    await this.updateWikiLinks(userId, result.id, path, newContent);

    return result;
  }

  /**
   * Add to internal model (AI-private)
   */
  async updateInternalModel(
    userId: string,
    section: string,
    content: string
  ): Promise<Document> {
    const path = "internal/model";
    const doc = await this.supabase.getDocument(userId, path);
    if (!doc) {
      throw new Error("Internal model document not found");
    }

    // Map section names to headers
    const sectionHeaders: Record<string, string> = {
      observations: "## Observations",
      hypotheses: "## Working Hypotheses",
      questions: "## Open Questions",
      contradictions: "## Contradictions I'm Tracking",
      patterns: "## Patterns I'm Watching",
      uncertainty: "## Where I Might Be Wrong",
      notes: "## Notes to Self",
      dream_fragments: "## Dream Fragments",
    };

    const header = sectionHeaders[section];
    if (!header) {
      throw new Error(`Unknown section: ${section}`);
    }

    // Find section and add content
    const timestamp = new Date().toISOString().split("T")[0];
    const entry = `\n- [${timestamp}] ${content}`;

    const sectionIndex = doc.content.indexOf(header);
    if (sectionIndex === -1) {
      throw new Error(`Section not found: ${header}`);
    }

    // Find end of section (next ## or end of file)
    const nextSectionMatch = doc.content.slice(sectionIndex + header.length).match(/\n## /);
    const insertPoint = nextSectionMatch
      ? sectionIndex + header.length + nextSectionMatch.index!
      : doc.content.length;

    const newContent =
      doc.content.slice(0, insertPoint) +
      entry +
      doc.content.slice(insertPoint);

    return await this.updateDocument(userId, path, newContent, "bot", `Added to ${section}`);
  }

  /**
   * Add reflection entry
   */
  async addReflection(
    userId: string,
    reflection: string,
    flaggedForDiscussion?: string
  ): Promise<Document> {
    const path = "internal/reflection_log";
    const doc = await this.supabase.getDocument(userId, path);
    if (!doc) {
      throw new Error("Reflection log not found");
    }

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    let entry = `## ${timestamp}\n\n${reflection}`;

    if (flaggedForDiscussion) {
      entry += `\n\n**Something I want to bring up:** ${flaggedForDiscussion}`;
    }

    entry += "\n\n---";

    // Insert after the header
    const insertPoint = doc.content.indexOf("---") + 3;
    const newContent =
      doc.content.slice(0, insertPoint) +
      "\n\n" +
      entry +
      doc.content.slice(insertPoint);

    return await this.updateDocument(userId, path, newContent, "reflection", "Reflection entry");
  }


  // ============ PRIVATE HELPERS ============

  /**
   * Extract wiki links from content and update note_links table
   */
  private async updateWikiLinks(
    userId: string,
    documentId: string,
    documentPath: string,
    content: string
  ): Promise<void> {
    // Extract wiki links from content
    const wikiLinks = extractWikiLinks(content);

    // Delete existing links for this document
    await this.supabase.deleteNoteLinks(userId, 'document', documentId);

    if (wikiLinks.length === 0) {
      return;
    }

    // Get all user documents for resolution
    const allDocs = await this.supabase.getUserDocuments(userId);
    const documentPaths = allDocs.map(d => d.path);

    // Insert new links
    for (const link of wikiLinks) {
      // Try to resolve the link
      const targetPath = resolveWikiLink(link.target, documentPaths);
      const targetDoc = targetPath ? allDocs.find(d => d.path === targetPath) : null;

      await this.supabase.insertNoteLink({
        user_id: userId,
        source_type: 'document',
        source_id: documentId,
        source_path: documentPath,
        target_name: link.target,
        target_path: targetPath || null,
        target_id: targetDoc?.id || null,
        link_type: link.isEmbed ? 'embed' : 'wiki',
        anchor: link.anchor || null,
        display_text: link.displayText || null,
        resolved: !!targetPath,
      });
    }
  }

  private formatEntry(entry: DocumentEntry): string {
    return `${entry.timestamp} | ${entry.type} | ${entry.confidence}
${entry.content}${entry.context ? `\n(${entry.context})` : ""}

---`;
  }

  private createDiff(oldContent: string, newContent: string): string {
    const timestamp = new Date().toISOString();

    // Find what was added (simple approach: if new is longer and starts/ends same, extract middle)
    let addedContent: string | null = null;
    let removedContent: string | null = null;
    let changeType: "append" | "prepend" | "insert" | "replace" | "unknown" = "unknown";

    if (newContent.length > oldContent.length) {
      // Check if content was appended
      if (newContent.startsWith(oldContent)) {
        addedContent = newContent.slice(oldContent.length);
        changeType = "append";
      }
      // Check if content was prepended
      else if (newContent.endsWith(oldContent)) {
        addedContent = newContent.slice(0, newContent.length - oldContent.length);
        changeType = "prepend";
      }
      // Check for insertion (old content split by new content)
      else {
        // Find common prefix
        let prefixLen = 0;
        while (prefixLen < oldContent.length && oldContent[prefixLen] === newContent[prefixLen]) {
          prefixLen++;
        }
        // Find common suffix
        let suffixLen = 0;
        while (
          suffixLen < oldContent.length - prefixLen &&
          oldContent[oldContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]
        ) {
          suffixLen++;
        }

        if (prefixLen + suffixLen >= oldContent.length * 0.5) {
          // Likely an insertion
          addedContent = newContent.slice(prefixLen, newContent.length - suffixLen);
          changeType = "insert";
        }
      }
    } else if (newContent.length < oldContent.length) {
      // Content was removed
      if (oldContent.startsWith(newContent)) {
        removedContent = oldContent.slice(newContent.length);
        changeType = "append"; // removed from end
      } else if (oldContent.endsWith(newContent)) {
        removedContent = oldContent.slice(0, oldContent.length - newContent.length);
        changeType = "prepend"; // removed from start
      }
    }

    return JSON.stringify({
      timestamp,
      changeType,
      oldLength: oldContent.length,
      newLength: newContent.length,
      charDelta: newContent.length - oldContent.length,
      added: addedContent,
      removed: removedContent,
    });
  }

  private generateInitialSummary(template: DocumentTemplate): string {
    return `${template.title}: Not yet populated`;
  }

  private async generateSummary(content: string, path: string): Promise<string> {
    // Simple summary extraction - first meaningful line after title
    const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const preview = lines.slice(0, 2).join(" ").substring(0, 100);
    return preview || `Document at ${path}`;
  }
}
