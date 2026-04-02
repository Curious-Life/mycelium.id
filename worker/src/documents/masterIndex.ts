import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import type { Document, Realm, SemanticTheme, TerritoryProfile } from "../types/database";

/**
 * Generates and updates the master index document
 * This is always loaded into Claude's context
 *
 * The master index provides a compact mindscape overview:
 * - Realm names + essences (5 realms)
 * - Stats (theme/territory counts)
 * - Internal model summary
 *
 * Detailed realm/theme/territory info is retrieved via semantic search tools.
 */
export class MasterIndexGenerator {
  private supabase: SupabaseService;

  constructor(env: Env) {
    this.supabase = new SupabaseService(env);
  }

  /**
   * Regenerate the master index from realms and mindscape data
   */
  async regenerate(userId: string): Promise<Document> {
    // Fetch all mindscape data in parallel
    const [realms, semanticThemes, territories, messageCount, internalModel, reflectionLog] = await Promise.all([
      this.supabase.getRealms(userId),
      this.supabase.getSemanticThemes(userId),
      this.supabase.getTerritoryProfiles(userId),
      this.supabase.getMessageCount(userId),
      this.supabase.getDocument(userId, "internal/model"),
      this.supabase.getDocument(userId, "internal/reflection_log"),
    ]);

    // Build semantic theme lookup by realm
    const semanticThemesByRealm = new Map<number, SemanticTheme[]>();
    for (const st of semanticThemes) {
      const list = semanticThemesByRealm.get(st.realm_id) || [];
      list.push(st);
      semanticThemesByRealm.set(st.realm_id, list);
    }

    // Build territory lookup by realm
    const territoriesByRealm = new Map<number, TerritoryProfile[]>();
    for (const t of territories) {
      if (t.realm_id !== null) {
        const list = territoriesByRealm.get(t.realm_id) || [];
        list.push(t);
        territoriesByRealm.set(t.realm_id, list);
      }
    }

    // Count hypotheses and questions in internal model
    const hypothesesCount = this.countSection(internalModel?.content || "", "## Working Hypotheses");
    const questionsCount = this.countSection(internalModel?.content || "", "## Open Questions");
    const lastReflection = this.getLastReflectionDate(reflectionLog?.content || "");

    // Get flagged items
    const flaggedItems = this.extractFlaggedItems(reflectionLog?.content || "");

    const now = new Date().toISOString().split("T")[0];

    // Build compact realm overview (minimal - name + essence + top 3 themes)
    const realmOverview = realms.length > 0
      ? realms.map((realm) => {
          const themes = semanticThemesByRealm.get(realm.realm_id) || [];
          const territoryCount = territoriesByRealm.get(realm.realm_id)?.length || realm.territory_count || 0;
          const themeNames = themes.slice(0, 3).map(t => t.name).join(", ");
          const lines = [`- **${realm.name}** - ${realm.essence || 'No essence yet'} (${themes.length} themes, ${territoryCount} territories)`];
          if (themeNames) {
            lines.push(`  *Themes: ${themeNames}${themes.length > 3 ? ` (+${themes.length - 3} more)` : ''}*`);
          }
          return lines.join("\n");
        }).join("\n")
      : "*No realms generated yet. Run clustering to populate.*";

    const content = `# Mindscape Overview

*${messageCount.toLocaleString()} messages across ${realms.length} realms, ${semanticThemes.length} themes, ${territories.length} territories*

${realmOverview}

---

*Use searchRealms, searchThemes, searchTerritories tools to explore deeper.*

## Internal (summary only)

- Working hypotheses: ${hypothesesCount}
- Open questions: ${questionsCount}
- Last reflection: ${lastReflection}
${flaggedItems.length > 0 ? `- Flagged to discuss: ${flaggedItems.join(", ")}` : ""}
`;

    // Update the master index document
    return await this.supabase.upsertDocument({
      user_id: userId,
      path: "_master_index",
      title: "Master Index",
      content,
      summary: `Mindscape overview: ${realms.length} realms, ${territories.length} territories, ${messageCount} messages. Updated ${now}`,
      is_internal: false,
      metadata: {
        lastGenerated: now,
        realmCount: realms.length,
        territoryCount: territories.length,
        messageCount,
      },
    });
  }

  /**
   * Count items in a section (for internal model summary)
   */
  private countSection(content: string, header: string): number {
    const sectionIndex = content.indexOf(header);
    if (sectionIndex === -1) return 0;

    const afterSection = content.slice(sectionIndex + header.length);
    const nextSection = afterSection.search(/\n## /);
    const sectionContent = nextSection === -1 ? afterSection : afterSection.slice(0, nextSection);

    // Count bullet points
    const bullets = sectionContent.match(/\n- /g);
    return bullets?.length || 0;
  }

  /**
   * Get last reflection date from reflection log
   */
  private getLastReflectionDate(content: string): string {
    // Find most recent ## YYYY-MM-DD HH:MM
    const match = content.match(/## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
    return match ? match[1] : "never";
  }

  /**
   * Extract flagged items from reflection log
   */
  private extractFlaggedItems(content: string): string[] {
    const flagged: string[] = [];
    const regex = /\*\*Something I want to bring up:\*\* ([^\n]+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      flagged.push(match[1].trim());
    }
    return flagged.slice(0, 3); // Only show first 3
  }
}
