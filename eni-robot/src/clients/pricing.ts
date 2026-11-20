/**
 * USD per million tokens, for backends that do not report a cost themselves (the Gemini API reports token counts
 * only). Measured from OpenRouter's own bills for the same model (usage.cost_details, 2026-11-03): uncached input
 * $2, cached input $0.10, output $10 (thinking included). Prompts above 200k tokens may be billed higher upstream;
 * that tier is not modelled.
 */
const PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gemini-4-argon": { input: 2, cachedInput: 0.1, output: 10 },
};

/** The cost of one reply, or undefined for a model with no known price. */
export function costOf(model: string, usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }): number | undefined {
  const p = PRICES[model.replace(/^google\//, "")];
  if (!p) return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const usd = ((usage.prompt_tokens - cached) * p.input + cached * p.cachedInput + usage.completion_tokens * p.output) / 1e6;
  return Math.round(usd * 1e7) / 1e7;
}
