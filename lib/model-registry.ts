export type ModelTier = 'low' | 'mid' | 'high';
export interface ModelConfig {
  id: string; provider: 'openai'; tier: ModelTier;
  inputPricePerMillion: number; outputPricePerMillion: number;
  enabled: boolean; temperature: number; maxOutputTokens: number;
  pricingVersion: string;
}
export const LEGACY_REGISTRY_VERSION = 'legacy-2026-01';
export const LEGACY_MODELS: readonly ModelConfig[] = [
  { id: 'gpt-3.5-turbo', provider: 'openai', tier: 'low', inputPricePerMillion: 1.5, outputPricePerMillion: 2, enabled: true, temperature: 0.5, maxOutputTokens: 1000, pricingVersion: LEGACY_REGISTRY_VERSION },
  { id: 'gpt-4', provider: 'openai', tier: 'high', inputPricePerMillion: 30, outputPricePerMillion: 60, enabled: true, temperature: 0.7, maxOutputTokens: 1000, pricingVersion: LEGACY_REGISTRY_VERSION },
];
export function parseRegistry(raw: string): ModelConfig[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || !values.length) throw new Error('Registry must be a nonempty array');
  const ids = new Set<string>(); const tiers = new Set<string>();
  for (const m of values) {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || ids.has(m.id) || m.provider !== 'openai' ||
      !['low','mid','high'].includes(m.tier) || typeof m.enabled !== 'boolean' ||
      typeof m.pricingVersion !== 'string' || !m.pricingVersion.trim() ||
      ![m.inputPricePerMillion, m.outputPricePerMillion, m.temperature].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
      m.temperature > 2 || !Number.isSafeInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0) throw new Error('Invalid model registry');
    if (m.enabled && tiers.has(m.tier)) throw new Error('Only one enabled model per tier');
    ids.add(m.id); if (m.enabled) tiers.add(m.tier);
  }
  if (!tiers.has('low') || !tiers.has('high')) throw new Error('Enabled low and high tiers are required');
  return values as ModelConfig[];
}
export function runtimeModels(): readonly ModelConfig[] {
  return process.env.ROUTEWISE_MODELS_JSON ? parseRegistry(process.env.ROUTEWISE_MODELS_JSON) : LEGACY_MODELS;
}
export function modelForTier(tier: ModelTier, models = runtimeModels()): ModelConfig {
  const model = models.find(m => m.tier === tier && m.enabled);
  if (!model) throw new Error(`No enabled ${tier} model`);
  return model;
}
export function getModel(id: string, models = runtimeModels()): ModelConfig {
  const model = models.find(m => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}
export function modelCost(model: ModelConfig, input: number, output: number): number {
  return input / 1000000 * model.inputPricePerMillion + output / 1000000 * model.outputPricePerMillion;
}
