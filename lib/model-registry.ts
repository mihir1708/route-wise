export type ModelTier = 'low' | 'mid' | 'high';
export type Provider = 'openai' | 'anthropic';
export interface ModelConfig {
  id: string; provider: Provider; tier: ModelTier;
  inputPricePerMillion: number; outputPricePerMillion: number;
  enabled: boolean;
  /** Null leaves the provider default; newer reasoning models reject a sampling temperature. */
  temperature: number | null;
  maxOutputTokens: number;
  pricingVersion: string;
  /** OpenAI reasoning_effort or Anthropic output_config.effort. Omitted when unset. */
  reasoningEffort?: string;
  /** Anthropic only: "off" sends thinking {type: "between_tools"}, which disables thinking when no tools are used. */
  thinking?: 'default' | 'off';
  /** Hidden reasoning tokens allowed on top of the visible answer; billed as output, so counted in worst-case cost. */
  reasoningHeadroomTokens?: number;
}
export const LEGACY_REGISTRY_VERSION = 'legacy-2026-01';
export const LEGACY_MODELS: readonly ModelConfig[] = [
  { id: 'gpt-3.5-turbo', provider: 'openai', tier: 'low', inputPricePerMillion: 1.5, outputPricePerMillion: 2, enabled: true, temperature: 0.5, maxOutputTokens: 1000, pricingVersion: LEGACY_REGISTRY_VERSION },
  { id: 'gpt-4', provider: 'openai', tier: 'high', inputPricePerMillion: 30, outputPricePerMillion: 60, enabled: true, temperature: 0.7, maxOutputTokens: 1000, pricingVersion: LEGACY_REGISTRY_VERSION },
];

/**
 * The gateway default: three tiers, each with an OpenAI primary and an Anthropic fallback.
 * Prices are USD per million tokens from the providers' pricing pages (checked 2026-10-05).
 * Registry order decides the primary: the first enabled model of a tier.
 */
export const GATEWAY_REGISTRY_VERSION = 'gateway-2026-10';
export const GATEWAY_MODELS: readonly ModelConfig[] = [
  { id: 'gpt-5.6-luna', provider: 'openai', tier: 'low', inputPricePerMillion: 0.2, outputPricePerMillion: 1.2, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: GATEWAY_REGISTRY_VERSION, reasoningEffort: 'none' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', tier: 'low', inputPricePerMillion: 1, outputPricePerMillion: 5, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: GATEWAY_REGISTRY_VERSION },
  { id: 'gpt-5.6-terra', provider: 'openai', tier: 'mid', inputPricePerMillion: 2, outputPricePerMillion: 12, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: GATEWAY_REGISTRY_VERSION, reasoningEffort: 'low', reasoningHeadroomTokens: 2000 },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', tier: 'mid', inputPricePerMillion: 2, outputPricePerMillion: 10, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: GATEWAY_REGISTRY_VERSION, reasoningEffort: 'low', thinking: 'off' },
  { id: 'gpt-5.6-sol', provider: 'openai', tier: 'high', inputPricePerMillion: 5, outputPricePerMillion: 30, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: GATEWAY_REGISTRY_VERSION, reasoningEffort: 'low', reasoningHeadroomTokens: 2000 },
  // Thinking cannot be disabled on Opus 5.5; low effort plus headroom keeps it bounded.
  { id: 'claude-opus-5-5', provider: 'anthropic', tier: 'high', inputPricePerMillion: 4, outputPricePerMillion: 20, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: GATEWAY_REGISTRY_VERSION, reasoningEffort: 'low', reasoningHeadroomTokens: 2000 },
];

const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
export function parseRegistry(raw: string): ModelConfig[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || !values.length) throw new Error('Registry must be a nonempty array');
  const ids = new Set<string>(); const slots = new Set<string>(); const tiers = new Set<string>();
  for (const m of values) {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || ids.has(m.id) || !['openai', 'anthropic'].includes(m.provider) ||
      !['low','mid','high'].includes(m.tier) || typeof m.enabled !== 'boolean' ||
      typeof m.pricingVersion !== 'string' || !m.pricingVersion.trim() ||
      ![m.inputPricePerMillion, m.outputPricePerMillion].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
      !(m.temperature === null || (typeof m.temperature === 'number' && m.temperature >= 0 && m.temperature <= 2)) ||
      !Number.isSafeInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0 ||
      (m.reasoningEffort !== undefined && (typeof m.reasoningEffort !== 'string' || !m.reasoningEffort.trim())) ||
      (m.thinking !== undefined && !['default', 'off'].includes(m.thinking)) ||
      (m.reasoningHeadroomTokens !== undefined && !isCount(m.reasoningHeadroomTokens))) throw new Error('Invalid model registry');
    // One enabled model per tier per provider: a primary and at most one fallback from the other provider.
    const slot = `${m.tier}/${m.provider}`;
    if (m.enabled && slots.has(slot)) throw new Error('Only one enabled model per tier per provider');
    ids.add(m.id); if (m.enabled) { slots.add(slot); tiers.add(m.tier); }
  }
  if (!tiers.has('low') || !tiers.has('high')) throw new Error('Enabled low and high tiers are required');
  return values as ModelConfig[];
}
export function runtimeModels(): readonly ModelConfig[] {
  return process.env.ROUTEWISE_MODELS_JSON ? parseRegistry(process.env.ROUTEWISE_MODELS_JSON) : GATEWAY_MODELS;
}
/** Enabled models for a tier, primary first, then fallbacks in registry order. */
export function tierCandidates(tier: ModelTier, models = runtimeModels()): ModelConfig[] {
  return models.filter(m => m.tier === tier && m.enabled);
}
export function modelForTier(tier: ModelTier, models = runtimeModels()): ModelConfig {
  const model = tierCandidates(tier, models)[0];
  if (!model) throw new Error(`No enabled ${tier} model`);
  return model;
}
/** Looks up a model by id; without an explicit list, legacy ids still resolve for historical records. */
export function getModel(id: string, models?: readonly ModelConfig[]): ModelConfig {
  const model = (models ?? [...runtimeModels(), ...LEGACY_MODELS]).find(m => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}
export function modelCost(model: ModelConfig, input: number, output: number): number {
  return input / 1000000 * model.inputPricePerMillion + output / 1000000 * model.outputPricePerMillion;
}
/** Output tokens a call may be billed for: the visible cap plus reasoning headroom. */
export function billableOutputCap(model: ModelConfig, visibleCap: number): number {
  return Math.min(visibleCap, model.maxOutputTokens) + (model.reasoningHeadroomTokens ?? 0);
}
