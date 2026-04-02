/**
 * Cloudflare Workers AI REST API client.
 *
 * Calls the Workers AI inference API directly from VPS,
 * bypassing the Worker for higher throughput.
 *
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN
 */

const MODELS = {
  tagging: '@cf/meta/llama-4-scout-17b-16e-instruct',
  embedding: '@cf/baai/bge-m3',
};

const TAGGING_PROMPT = `Analyze this message. Extract tags and named entities.

Message: "{MESSAGE}"

Respond with JSON only:
{"tags": ["tag1", "tag2"], "entities": {"people": [], "companies": [], "projects": [], "places": []}}

Rules:
- tags: 1-5 lowercase tags using snake_case. Capture themes, topics, emotions, activities.
- entities.people: Names of people mentioned (first name, full name, or nickname).
- entities.companies: Company or organization names.
- entities.projects: Project names, product names, creative works.
- entities.places: Cities, countries, locations, venues.

Only include entities that are explicitly mentioned. Empty arrays if none found.`;

export class WorkersAIClient {
  constructor(accountId, apiToken) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
    this.headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  async tagMessage(text) {
    const prompt = TAGGING_PROMPT.replace('{MESSAGE}', text.substring(0, 4000));
    const res = await fetch(`${this.baseUrl}/${MODELS.tagging}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI tagging failed (${res.status}): ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const emptyResult = { tags: [], entities: { people: [], companies: [], projects: [], places: [] } };

    try {
      let responseText = '';
      if (typeof data.result?.response === 'string') {
        responseText = data.result.response;
      } else if (data.result?.response && typeof data.result.response === 'object') {
        responseText = JSON.stringify(data.result.response);
      } else {
        return emptyResult;
      }

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return emptyResult;

      const parsed = JSON.parse(jsonMatch[0]);
      const tags = (parsed.tags || [])
        .map(t => t.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))
        .filter(t => t.length > 0)
        .slice(0, 5);

      const cleanArray = arr => (arr || []).filter(x => typeof x === 'string' && x.trim().length > 0);
      return {
        tags,
        entities: {
          people: cleanArray(parsed.entities?.people),
          companies: cleanArray(parsed.entities?.companies),
          projects: cleanArray(parsed.entities?.projects),
          places: cleanArray(parsed.entities?.places),
        },
      };
    } catch {
      return emptyResult;
    }
  }

  async generateEmbedding(text) {
    const res = await fetch(`${this.baseUrl}/${MODELS.embedding}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ text: [text.substring(0, 8000)] }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI embedding failed (${res.status}): ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    if (!data.result?.data?.[0]) throw new Error('No embedding returned');
    return data.result.data[0];
  }
}
