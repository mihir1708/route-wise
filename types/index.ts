// Type definitions for the project

// Historical model strings are retained even when runtime configuration changes.
export type ModelName = string;

export type DifficultyScore = number;

// Budget tracking data
export interface BudgetStatus {
  month: string;
  total_cost: number;
  total_requests: number;
  cheap_model_count: number;
  mid_model_count: number;
  expert_model_count: number;
  budget_limit: number;
  updated_at: string;
}

// Individual request log
export interface RouterLog {
  id?: string;
  timestamp?: string;
  query_text: string;
  query_hash: string;
  chosen_model: ModelName;
  estimated_difficulty: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  response_time_ms: number;
  was_successful: boolean;
}

// API types
/** The body /api/generate and the demo endpoint return for an answered request. */
export interface GatewayAnswer {
  answer: string;
  /** Parsed JSON, for tasks with structured output. */
  output?: unknown;
  metadata: {
    request_id: string; task_type: string; prompt_version: string; model: string;
    tier: import('@/lib/model-registry').ModelTier; provider?: string;
    cache_hit: boolean; fallback_used: boolean; escalated: boolean; truncated: boolean; attempts: number;
    /** Absent on cache hits, which skip routing. */
    route_reasons?: string[]; difficulty_score?: number | null;
    tokens: { input: number; output: number; total: number }; cost_usd: number; accounting_status: string;
    tenant_budget?: number; tenant_budget_remaining?: number; latency_ms: number;
  };
}

// Pricing data structure
export interface ModelPricing {
  prompt: number;
  completion: number;
}

export interface PricingTable {
  [key: string]: ModelPricing;
}

// OpenAI response format
export interface ModelResponse {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** The provider stopped at the output cap. */
  truncated?: boolean;
}

// Admin dashboard: production telemetry for whole UTC days, optionally for one tenant
// (gateway_dashboard in migration 012).
type ModelTierName = import('@/lib/model-registry').ModelTier;
export interface DashboardStats {
  window_start: string; window_end: string; days: number; tenant: string | null;
  tenants: { id: string; name: string }[];
  summary: {
    requests: number; succeeded: number; cost_usd: number; provider_requests: number;
    cache_hits: number; fallbacks: number; escalations: number; rate_limited: number; budget_rejected: number;
    unsettled: number; unknown_usage: number; p50_ms: number | null; p95_ms: number | null;
  };
  tiers: { tier: ModelTierName; requests: number; succeeded: number; cost_usd: number; p50_ms: number | null; p95_ms: number | null }[];
  models: Record<string, number>;
  daily: { date: string; requests: number; succeeded: number; cost_usd: number; cache: number; low: number; mid: number; high: number }[];
  recent: {
    request_id: string; timestamp: string; tenant_name: string | null; task_type: string | null;
    selected_model: string | null; selected_tier: ModelTierName | null; routing_policy_version: string;
    cache_hit: boolean; fallback_used: boolean; escalated: boolean; application_succeeded: boolean;
    failure_stage: string | null; error_category: string | null; cost_usd: number | null; latency_ms: number;
  }[];
  /** This month's budget: the selected tenant's, or the global one. */
  budget: { scope: 'tenant' | 'global'; month: string; limit: number; spent: number };
}
