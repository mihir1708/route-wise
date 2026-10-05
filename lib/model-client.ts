// Single-model calls for the eval tooling. The gateway uses lib/provider-chain.ts,
// which adds retries, a circuit breaker and cross-provider fallback.
import { getModel } from '@/lib/model-registry';
import { callProvider } from '@/lib/providers';
import { ModelName, ModelResponse } from '@/types';
import { logger } from '@/utils/logger';

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant that provides accurate and concise answers to user questions.';

export async function callModel(query: string, model: ModelName): Promise<ModelResponse> {
  const config = getModel(model);
  const started = Date.now();
  try {
    const response = await callProvider(query, config, { system: DEFAULT_SYSTEM_PROMPT, maxOutputTokens: config.maxOutputTokens });
    logger.info(`Model response received in ${Date.now() - started}ms`, { model, tokens: response.total_tokens });
    return response;
  } catch (error) {
    logger.error('Error calling model', { model, error: (error as Error).message });
    throw new Error(`Failed to get response from ${model}`);
  }
}
