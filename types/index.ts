// Type definitions for the project

export type ModelName = 'gpt-3.5-turbo' | 'gpt-4';

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

// Admin dashboard stats
export interface UsageStats {
  total_requests: number;
  total_cost: number;
  budget_remaining: number;
  model_distribution: {
    [key: string]: number;
  };
  recent_logs: RouterLog[];
  daily_costs: {
    date: string;
    cost: number;
  }[];
}
