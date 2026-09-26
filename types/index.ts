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
export interface RouteQueryRequest {
  query: string;
}

export interface RouteQueryResponse {
  answer: string;
  metadata: {
    model_used: ModelName;
    difficulty_score: number;
    tokens_used: number;
    cost: number;
    remaining_budget: number;
    budget_limit: number;
    model_tier: import('@/lib/model-registry').ModelTier;
    accounting_status: string;
    request_id: string;
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
}

// Admin data is production telemetry only, for one UTC calendar month.
export interface UsageStats {
  total_requests: number; total_cost: number; budget_remaining: number;
  budget_limit: number; accounted_spend: number; failed_requests: number;
  unsettled_requests: number; unknown_usage_requests: number;
  window_start: string; window_end: string;
  model_distribution: Record<string, number>; tier_distribution: Record<string, number>;
  policy_distribution: Record<string, number>;
  recent_logs: import('@/lib/request-run').RequestRun[];
  daily_costs: { date: string; cost: number | null }[];
}
