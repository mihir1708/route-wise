// Model pricing and cost calculation

import { PricingTable, ModelName } from '@/types';

// Pricing per 1K tokens (as of January 2026)
export const PRICING: PricingTable = {
  'gpt-3.5-turbo': {
    prompt: 0.0015,
    completion: 0.002
  },
  'gpt-4': {
    prompt: 0.03,
    completion: 0.06
  }
};

// Calculate cost based on token usage
export function calculateCost(
  model: ModelName,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = PRICING[model];
  
  if (!pricing) {
    throw new Error(`Unknown model: ${model}`);
  }

  const promptCost = (promptTokens / 1000) * pricing.prompt;
  const completionCost = (completionTokens / 1000) * pricing.completion;

  return promptCost + completionCost;
}

// Estimate cost before making a call (useful for budget checks)
export function estimateCost(model: ModelName, inputLength: number): number {
  // Roughly 4 chars per token
  const estimatedPromptTokens = Math.ceil(inputLength / 4);
  // Assume response is about 2x the input length
  const estimatedCompletionTokens = estimatedPromptTokens * 2;

  return calculateCost(model, estimatedPromptTokens, estimatedCompletionTokens);
}
