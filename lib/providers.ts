// Provider adapters behind one call shape, and one error type the gateway can reason about.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { billableOutputCap, type ModelConfig } from '@/lib/model-registry';
import type { ModelResponse } from '@/types';

export type ProviderErrorKind =
  | 'rate_limited' | 'overloaded' | 'server' | 'timeout' | 'network'
  | 'auth' | 'bad_request' | 'refused' | 'empty' | 'not_configured' | 'unknown';
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limited', 'overloaded', 'server', 'timeout', 'network']);

/** Tokens the provider billed for a call that still failed, such as an empty or refused answer. */
export interface BilledUsage { prompt_tokens: number; completion_tokens: number }

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind, readonly status: number | null = null, readonly retryAfterMs: number | null = null,
    readonly usage: BilledUsage | null = null,
  ) {
    super(`provider_${kind}`);
  }
  /** Worth another try on the same model: a transient, provider-side condition. */
  get retryable(): boolean { return RETRYABLE.has(this.kind); }
}

function retryAfterMs(headers: unknown): number | null {
  const get = (name: string) => (headers && typeof (headers as Headers).get === 'function' ? (headers as Headers).get(name) : null);
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

/** Both SDKs share the same error hierarchy shape; classify by class name and HTTP status. */
export function classifyProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { name?: string; status?: unknown; headers?: unknown } | null;
  if (e?.name === 'APIConnectionTimeoutError') return new ProviderError('timeout');
  if (e?.name === 'APIConnectionError') return new ProviderError('network');
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status === null) return new ProviderError('unknown');
  const after = retryAfterMs(e?.headers);
  if (status === 429) return new ProviderError('rate_limited', status, after);
  if (status === 529 || status === 503) return new ProviderError('overloaded', status, after);
  if (status === 408) return new ProviderError('timeout', status);
  if (status >= 500) return new ProviderError('server', status, after);
  if (status === 401 || status === 403) return new ProviderError('auth', status);
  return new ProviderError('bad_request', status);
}

export interface CallOptions {
  system: string;
  /** Visible answer cap; reasoning headroom from the registry is added on top. */
  maxOutputTokens: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60000;
let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;
// SDK retries are off: the gateway owns retries, backoff and fallback so every attempt is visible.
function openaiClient() {
  if (!process.env.OPENAI_API_KEY) throw new ProviderError('not_configured');
  return (openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 0 }));
}
function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new ProviderError('not_configured');
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 0 }));
}

async function callOpenAI(user: string, model: ModelConfig, options: CallOptions): Promise<ModelResponse> {
  const response = await openaiClient().chat.completions.create({
    model: model.id,
    messages: [{ role: 'system', content: options.system }, { role: 'user', content: user }],
    max_completion_tokens: billableOutputCap(model, options.maxOutputTokens),
    ...(model.temperature === null ? {} : { temperature: model.temperature }),
    ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort as OpenAI.ReasoningEffort } : {}),
  }, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const choice = response.choices[0];
  const result = {
    content: choice?.message?.content ?? '',
    prompt_tokens: response.usage?.prompt_tokens ?? NaN,
    completion_tokens: response.usage?.completion_tokens ?? NaN,
    total_tokens: response.usage?.total_tokens ?? NaN,
    truncated: choice?.finish_reason === 'length',
  };
  if (choice?.message?.refusal) throw new ProviderError('refused', null, null, billed(result));
  return result;
}

async function callAnthropic(user: string, model: ModelConfig, options: CallOptions): Promise<ModelResponse> {
  const response = await anthropicClient().messages.create({
    model: model.id,
    max_tokens: billableOutputCap(model, options.maxOutputTokens),
    system: options.system,
    messages: [{ role: 'user', content: user }],
    ...(model.temperature === null ? {} : { temperature: model.temperature }),
    ...(model.thinking === 'off' ? { thinking: { type: 'between_tools' as const } } : {}),
    ...(model.reasoningEffort ? { output_config: { effort: model.reasoningEffort as 'low' | 'medium' | 'high' } } : {}),
  }, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const content = response.content.map(block => (block.type === 'text' ? block.text : '')).join('');
  const input = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
  const result = {
    content, prompt_tokens: input, completion_tokens: response.usage.output_tokens,
    total_tokens: input + response.usage.output_tokens, truncated: response.stop_reason === 'max_tokens',
  };
  if (response.stop_reason === 'refusal') throw new ProviderError('refused', null, null, billed(result));
  return result;
}

/** Usage worth charging from a response that is about to be rejected, or null if it is not usable. */
function billed(r: ModelResponse): BilledUsage | null {
  return [r.prompt_tokens, r.completion_tokens].every(n => Number.isSafeInteger(n) && n >= 0)
    ? { prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens } : null;
}

/** One attempt against one model. Throws ProviderError; never retries. */
export async function callProvider(user: string, model: ModelConfig, options: CallOptions): Promise<ModelResponse> {
  if (!model.enabled) throw new ProviderError('not_configured');
  let response: ModelResponse;
  try {
    response = model.provider === 'anthropic' ? await callAnthropic(user, model, options) : await callOpenAI(user, model, options);
  } catch (error) { throw classifyProviderError(error); }
  // An empty answer is still billed, for example when reasoning used the whole output budget.
  if (!response.content.trim()) throw new ProviderError('empty', null, null, billed(response));
  return response;
}
