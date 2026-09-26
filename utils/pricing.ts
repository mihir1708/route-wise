// Model pricing and cost calculation

import { PricingTable, ModelName } from '@/types';

import { LEGACY_MODELS, getModel } from '@/lib/model-registry';
// Compatibility export for the v1 baseline; prices originate in the registry.
export const PRICING: PricingTable = Object.fromEntries(LEGACY_MODELS.map(model => [model.id, {
  prompt: model.inputPricePerMillion / 1000,
  completion: model.outputPricePerMillion / 1000,
}]));

// Calculate cost based on token usage
export function calculateCost(
  model: ModelName,
  promptTokens: number,
  completionTokens: number
): number {
  const config = getModel(model);
  const pricing = { prompt: config.inputPricePerMillion / 1000, completion: config.outputPricePerMillion / 1000 };
  
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
