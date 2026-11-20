/** Model clients: one interface (ChatClient), one implementation per backend, and the factory that picks one. */
import { GeminiClient } from "./gemini.ts";
import { OpenRouterClient } from "./openrouter.ts";
import { BACKENDS, type Backend, type ChatClient } from "./types.ts";

export * from "./types.ts";
export { DEFAULT_ATTEMPTS, RETRY_WAIT } from "./stream.ts";
export { GeminiClient, OpenRouterClient };

/** The client for `backend`. Both talk to the gateway with the same key; the gateway holds the real ones. */
export function createClient(backend: Backend, apiKey: string): ChatClient {
  switch (backend) {
    case "openrouter":
      return new OpenRouterClient(apiKey);
    case "gemini":
      return new GeminiClient(apiKey);
    default:
      throw new Error(`unknown backend "${backend as string}"; backends are ${BACKENDS.join(", ")}`);
  }
}
