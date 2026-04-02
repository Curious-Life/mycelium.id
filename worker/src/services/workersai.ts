import type { Env } from "../types/env";

// Model configuration - easy to update as new models release
const MODELS = {
  // Tagging/text generation - Llama 4 Scout for better reasoning
  tagging: "@cf/meta/llama-4-scout-17b-16e-instruct",
  // Embeddings - BGE-M3 for multilingual support (1024 dimensions)
  embedding: "@cf/baai/bge-m3",
  // Speech-to-text - Whisper Large v3 Turbo (better accuracy + speed)
  whisper: "@cf/openai/whisper-large-v3-turbo",
  // Vision - Llama 4 Scout (natively multimodal, same model for text+vision)
  vision: "@cf/meta/llama-4-scout-17b-16e-instruct",
  // Text-to-speech - Deepgram Aura-2 (natural, context-aware, OGG/Opus output)
  tts: "@cf/deepgram/aura-2-en",
} as const;

// BGE-M3 produces 1024-dimensional embeddings
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Convert ArrayBuffer to base64 in chunks to avoid stack overflow
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binaryString = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binaryString += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binaryString);
}

export interface TaggingResult {
  tags: string[];
  entities: {
    people: string[];
    companies: string[];
    projects: string[];
    places: string[];
  };
}

export class WorkersAIService {
  private ai: Ai;

  constructor(env: Env) {
    this.ai = env.AI;
  }

  /**
   * Tag a message using Llama 4 Scout
   * Fully open tagging - no vocabulary constraint
   * Extracts named entities: people, companies, projects, places
   */
  async tagMessage(message: string): Promise<TaggingResult> {
    const prompt = `Analyze this message. Extract tags and named entities.

Message: "${message}"

Respond with JSON only:
{"tags": ["tag1", "tag2"], "entities": {"people": [], "companies": [], "projects": [], "places": []}}

Rules:
- tags: 1-5 lowercase tags using snake_case. Capture themes, topics, emotions, activities.
- entities.people: Names of people mentioned (first name, full name, or nickname).
- entities.companies: Company or organization names.
- entities.projects: Project names, product names, creative works.
- entities.places: Cities, countries, locations, venues.

Only include entities that are explicitly mentioned. Empty arrays if none found.`;

    const response = await this.ai.run(MODELS.tagging, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    }) as { response?: string | unknown };

    const emptyResult: TaggingResult = {
      tags: [],
      entities: { people: [], companies: [], projects: [], places: [] },
    };

    try {
      let text = "";
      if (typeof response.response === "string") {
        text = response.response;
      } else if (response.response && typeof response.response === "object") {
        text = JSON.stringify(response.response);
      } else {
        console.error("Unexpected tagging response type:", typeof response.response, response);
        return emptyResult;
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("No JSON found in tagging response:", text);
        return emptyResult;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Normalize tags to lowercase snake_case
      const tags = (parsed.tags || [])
        .map((t: string) => t.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""))
        .filter((t: string) => t.length > 0)
        .slice(0, 5);

      // Extract and clean entities
      const entities = parsed.entities || {};
      const cleanArray = (arr: unknown[]): string[] =>
        (arr || []).filter((x): x is string => typeof x === "string" && x.trim().length > 0);

      return {
        tags,
        entities: {
          people: cleanArray(entities.people),
          companies: cleanArray(entities.companies),
          projects: cleanArray(entities.projects),
          places: cleanArray(entities.places),
        },
      };
    } catch (e) {
      console.error("Failed to parse tagging response:", e);
      return emptyResult;
    }
  }

  /**
   * Generate embeddings using BGE-M3 (multilingual, 1024 dimensions)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.ai.run(MODELS.embedding, {
      text: [text],
    }) as { data: number[][] };

    return response.data[0];
  }

  /**
   * Transcribe audio using Whisper Large v3 Turbo
   */
  async transcribeAudio(audioData: ArrayBuffer): Promise<string> {
    // Workers AI Whisper expects audio as base64 encoded string
    const base64 = arrayBufferToBase64(audioData);

    const response = await this.ai.run(MODELS.whisper, {
      audio: base64,
    }) as { text?: string; vtt?: string };

    // Whisper returns text or vtt format
    if (response.text) {
      return response.text;
    }

    // Parse VTT if that's what we got
    if (response.vtt) {
      // Extract just the text from VTT format
      const lines = response.vtt.split('\n');
      const textLines = lines.filter(line =>
        line && !line.startsWith('WEBVTT') && !line.includes('-->') && !/^\d+$/.test(line.trim())
      );
      return textLines.join(' ').trim();
    }

    return "";
  }

  /**
   * Describe an image using Llama 4 Scout (natively multimodal)
   * Image must be sent as data URI: data:image/jpeg;base64,...
   */
  async describeImage(imageData: ArrayBuffer, mimeType: string = "image/jpeg"): Promise<string> {
    const base64 = arrayBufferToBase64(imageData);
    const dataUri = `data:${mimeType};base64,${base64}`;

    const response = await this.ai.run(MODELS.vision, {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this image concisely. Focus on the main subject and any text visible.",
            },
            {
              type: "image_url",
              image_url: {
                url: dataUri,
              },
            },
          ],
        },
      ],
      max_tokens: 200,
    }) as { response?: string };

    return response.response || "Unable to describe image";
  }

  /**
   * Process text with optional image (unified multimodal call)
   */
  async processMultimodal(
    text: string,
    imageData?: ArrayBuffer,
    mimeType: string = "image/jpeg"
  ): Promise<string> {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text },
    ];

    if (imageData) {
      const base64 = arrayBufferToBase64(imageData);
      const dataUri = `data:${mimeType};base64,${base64}`;
      content.push({
        type: "image_url",
        image_url: { url: dataUri },
      });
    }

    const response = await this.ai.run(MODELS.vision, {
      messages: [{ role: "user", content }],
      max_tokens: 500,
    }) as { response?: string };

    return response.response || "";
  }

  /**
   * Generate speech audio from text using Deepgram Aura-2
   * Returns OGG/Opus audio stream
   */
  async textToSpeech(text: string, speaker: string = "luna"): Promise<unknown> {
    const response = await this.ai.run(MODELS.tts, {
      text,
      speaker: speaker as "luna",
      encoding: "opus",
      container: "ogg",
    });
    return response;
  }
}
