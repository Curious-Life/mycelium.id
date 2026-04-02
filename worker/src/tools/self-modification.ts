/**
 * Self-Modification Tools
 *
 * Tools that allow agents to propose changes to their own codebase.
 * All changes go through PR review before being applied.
 */

import type { Env } from "../types/env";
import type { AgentId } from "../config/mya-agents";

export interface CodeChange {
  file_path: string;
  operation: "create" | "modify" | "delete";
  content?: string;
  description: string;
}

export interface PRProposal {
  id: string;
  agent_id: AgentId;
  title: string;
  description: string;
  changes: CodeChange[];
  risk_level: "low" | "medium" | "high";
  requires_human_review: boolean;
  created_at: string;
}

export interface PRReview {
  pr_id: string;
  reviewer: "mya-qa" | "human";
  decision: "approve" | "request_changes" | "reject";
  security_issues: string[];
  quality_issues: string[];
  missing_tests: string[];
  missing_docs: string[];
  suggestions: string[];
  auto_fixes_applied: string[];
  reviewed_at: string;
}

/**
 * Tool definitions for self-modification capabilities
 */
export const SELF_MODIFICATION_TOOLS = [
  {
    name: "propose_code_change",
    description: "Propose a change to your own codebase. Creates a PR that will be reviewed by the QA agent before merging. Use for adding features, fixing bugs, or improving your capabilities.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Short title for the PR (e.g., 'Add calendar integration tool')",
        },
        description: {
          type: "string",
          description: "Detailed description of what this change does and why",
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Path to the file (e.g., 'src/tools/calendar.ts')",
              },
              operation: {
                type: "string",
                enum: ["create", "modify", "delete"],
              },
              content: {
                type: "string",
                description: "New file content (for create/modify)",
              },
              description: {
                type: "string",
                description: "What this specific change does",
              },
            },
            required: ["file_path", "operation", "description"],
          },
          description: "List of file changes to make",
        },
        risk_level: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Self-assessed risk: low (docs/comments), medium (new features), high (core logic/security)",
        },
      },
      required: ["title", "description", "changes", "risk_level"],
    },
  },
  {
    name: "add_tool",
    description: "Add a new tool to your capabilities. Generates the tool definition and implementation, then creates a PR.",
    input_schema: {
      type: "object" as const,
      properties: {
        tool_name: {
          type: "string",
          description: "Name of the new tool (e.g., 'fetch_calendar_events')",
        },
        description: {
          type: "string",
          description: "What the tool does",
        },
        parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
            },
          },
          description: "Tool parameters",
        },
        implementation_notes: {
          type: "string",
          description: "Notes on how the tool should be implemented",
        },
      },
      required: ["tool_name", "description", "parameters"],
    },
  },
  {
    name: "update_my_prompt",
    description: "Propose an update to your own system prompt. High-risk change that always requires human review.",
    input_schema: {
      type: "object" as const,
      properties: {
        section: {
          type: "string",
          description: "Which section to update (e.g., 'capabilities', 'personality', 'constraints')",
        },
        current_text: {
          type: "string",
          description: "The current text you want to change (for context)",
        },
        new_text: {
          type: "string",
          description: "The new text to replace it with",
        },
        rationale: {
          type: "string",
          description: "Why this change improves your effectiveness",
        },
      },
      required: ["section", "new_text", "rationale"],
    },
  },
  {
    name: "request_capability",
    description: "Request a capability you don't have yet. Creates an issue for review rather than a PR.",
    input_schema: {
      type: "object" as const,
      properties: {
        capability: {
          type: "string",
          description: "What capability you need (e.g., 'access to Slack API')",
        },
        use_case: {
          type: "string",
          description: "Why you need this capability - specific use cases",
        },
        frequency: {
          type: "string",
          description: "How often this need comes up",
        },
      },
      required: ["capability", "use_case"],
    },
  },
  {
    name: "view_my_code",
    description: "View your own source code to understand your current implementation",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file you want to view",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_my_files",
    description: "List files in your codebase",
    input_schema: {
      type: "object" as const,
      properties: {
        directory: {
          type: "string",
          description: "Directory to list (default: root)",
        },
        pattern: {
          type: "string",
          description: "Glob pattern to filter files (e.g., '*.ts')",
        },
      },
      required: [],
    },
  },
];

/**
 * Self-modification tool executor
 */
export class SelfModificationExecutor {
  private env: Env;
  private agentId: AgentId;
  private repoPath: string;

  constructor(env: Env, agentId: AgentId, repoPath: string) {
    this.env = env;
    this.agentId = agentId;
    this.repoPath = repoPath;
  }

  async proposeCodeChange(input: {
    title: string;
    description: string;
    changes: CodeChange[];
    risk_level: "low" | "medium" | "high";
  }): Promise<string> {
    const proposalId = crypto.randomUUID();

    // Determine if human review is required
    const requiresHumanReview =
      input.risk_level === "high" ||
      input.changes.some((c) =>
        c.file_path.includes("prompt") ||
        c.file_path.includes("security") ||
        c.file_path.includes("auth")
      );

    const proposal: PRProposal = {
      id: proposalId,
      agent_id: this.agentId,
      title: input.title,
      description: input.description,
      changes: input.changes,
      risk_level: input.risk_level,
      requires_human_review: requiresHumanReview,
      created_at: new Date().toISOString(),
    };

    // Store proposal for QA agent to pick up
    if (this.env.KV) {
      await this.env.KV.put(
        `pr_proposal:${proposalId}`,
        JSON.stringify(proposal),
        { expirationTtl: 86400 * 7 } // 7 day TTL
      );

      // Add to pending queue
      const pending = await this.env.KV.get("pr_proposals:pending");
      const queue = pending ? JSON.parse(pending) : [];
      queue.push(proposalId);
      await this.env.KV.put("pr_proposals:pending", JSON.stringify(queue));
    }

    console.log(`[SelfMod] ${this.agentId} proposed PR: ${input.title}`, {
      id: proposalId,
      files: input.changes.length,
      risk: input.risk_level,
      requiresHuman: requiresHumanReview,
    });

    const humanNote = requiresHumanReview
      ? "\n\n⚠️ This change requires human approval due to its risk level."
      : "";

    return `PR Proposal Created:
- ID: ${proposalId}
- Title: ${input.title}
- Files changed: ${input.changes.length}
- Risk level: ${input.risk_level}
- Status: Pending QA review${humanNote}

The QA agent will review this proposal for security, quality, and test coverage.`;
  }

  async addTool(input: {
    tool_name: string;
    description: string;
    parameters: Array<{
      name: string;
      type: string;
      description: string;
      required?: boolean;
    }>;
    implementation_notes?: string;
  }): Promise<string> {
    // Generate tool definition
    const toolDef = this.generateToolDefinition(input);
    const toolImpl = this.generateToolImplementation(input);

    // Create as a code change proposal
    return this.proposeCodeChange({
      title: `Add tool: ${input.tool_name}`,
      description: `Add new tool "${input.tool_name}": ${input.description}\n\n${input.implementation_notes || ""}`,
      changes: [
        {
          file_path: `src/tools/custom/${input.tool_name}.ts`,
          operation: "create",
          content: toolImpl,
          description: `Implementation of ${input.tool_name} tool`,
        },
        {
          file_path: "src/tools/custom/index.ts",
          operation: "modify",
          content: `// Add export for ${input.tool_name}`,
          description: `Export ${input.tool_name} from custom tools index`,
        },
      ],
      risk_level: "medium",
    });
  }

  async updatePrompt(input: {
    section: string;
    current_text?: string;
    new_text: string;
    rationale: string;
  }): Promise<string> {
    // Prompt changes always require human review
    return this.proposeCodeChange({
      title: `Update prompt: ${input.section}`,
      description: `Update ${input.section} section of system prompt.\n\nRationale: ${input.rationale}`,
      changes: [
        {
          file_path: "src/prompts/agent.ts",
          operation: "modify",
          content: input.new_text,
          description: `Update ${input.section}: ${input.rationale}`,
        },
      ],
      risk_level: "high", // Always high for prompt changes
    });
  }

  async requestCapability(input: {
    capability: string;
    use_case: string;
    frequency?: string;
  }): Promise<string> {
    const requestId = crypto.randomUUID();

    const request = {
      id: requestId,
      agent_id: this.agentId,
      capability: input.capability,
      use_case: input.use_case,
      frequency: input.frequency || "unknown",
      status: "pending",
      created_at: new Date().toISOString(),
    };

    if (this.env.KV) {
      await this.env.KV.put(
        `capability_request:${requestId}`,
        JSON.stringify(request),
        { expirationTtl: 86400 * 30 } // 30 day TTL
      );
    }

    console.log(`[SelfMod] ${this.agentId} requested capability: ${input.capability}`);

    return `Capability Request Submitted:
- ID: ${requestId}
- Capability: ${input.capability}
- Use case: ${input.use_case}
- Status: Pending human review

This request has been logged for the development team to evaluate.`;
  }

  private generateToolDefinition(input: {
    tool_name: string;
    description: string;
    parameters: Array<{
      name: string;
      type: string;
      description: string;
      required?: boolean;
    }>;
  }): string {
    const params = input.parameters.map((p) => `
        ${p.name}: {
          type: "${p.type}",
          description: "${p.description}",
        }`).join(",");

    const required = input.parameters
      .filter((p) => p.required)
      .map((p) => `"${p.name}"`)
      .join(", ");

    return `{
  name: "${input.tool_name}",
  description: "${input.description}",
  input_schema: {
    type: "object",
    properties: {${params}
    },
    required: [${required}],
  },
}`;
  }

  private generateToolImplementation(input: {
    tool_name: string;
    description: string;
    parameters: Array<{
      name: string;
      type: string;
      description: string;
      required?: boolean;
    }>;
    implementation_notes?: string;
  }): string {
    const paramTypes = input.parameters
      .map((p) => `${p.name}${p.required ? "" : "?"}: ${p.type}`)
      .join("; ");

    return `/**
 * ${input.description}
 *
 * Auto-generated tool - review and customize implementation
 * ${input.implementation_notes ? `\nNotes: ${input.implementation_notes}` : ""}
 */

export interface ${this.toPascalCase(input.tool_name)}Input {
  ${paramTypes};
}

export async function ${input.tool_name}(input: ${this.toPascalCase(input.tool_name)}Input): Promise<string> {
  // TODO: Implement ${input.tool_name}
  // ${input.implementation_notes || "Add implementation here"}

  return \`${input.tool_name} executed with: \${JSON.stringify(input)}\`;
}
`;
  }

  private toPascalCase(str: string): string {
    return str
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  }
}
