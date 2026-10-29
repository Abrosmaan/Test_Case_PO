import { config } from '../config.js';

export interface LlmProvider {
  name: string;
  model: string;
  /** Returns the raw model text. Throws on network/HTTP errors and on abort. */
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}

function gemini(apiKey: string, model: string): LlmProvider {
  return {
    name: 'gemini',
    model,
    async complete(prompt, signal) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    },
  };
}

function ollama(model: string): LlmProvider {
  return {
    name: 'ollama',
    model,
    async complete(prompt, signal) {
      const res = await fetch(`${config.llm.ollamaUrl}/api/generate`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        // think: false — reasoning models (qwen3, deepseek-r1) answer ~15× faster; others ignore it.
        body: JSON.stringify({ model, prompt, stream: false, format: 'json', think: false, options: { temperature: 0 } }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      return ((await res.json()) as { response?: string }).response ?? '';
    },
  };
}

/** null = LLM is off; the app works fully without it. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const { provider, model, defaultModels } = config.llm;
  const apiKey = env.LLM_API_KEY?.trim();
  if (provider === 'ollama') return ollama(model || defaultModels.ollama);
  if ((provider === 'gemini' || provider === 'auto') && apiKey) return gemini(apiKey, model || defaultModels.gemini);
  return null;
}
