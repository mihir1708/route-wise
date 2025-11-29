-- Database schema for RouteWise
-- Run this in your Supabase SQL Editor

-- Logs every query with metrics
CREATE TABLE IF NOT EXISTS router_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  query_text TEXT,
  query_hash TEXT,
  chosen_model VARCHAR(50),
  estimated_difficulty DECIMAL(3,2),
  prompt_tokens INT,
  completion_tokens INT,
  cost_usd DECIMAL(10,6),
  response_time_ms INT,
  was_successful BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_router_logs_timestamp ON router_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_router_logs_model ON router_logs(chosen_model);

-- Monthly budget tracking
CREATE TABLE IF NOT EXISTS budget_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  month VARCHAR(7),
  total_cost DECIMAL(10,2) DEFAULT 0,
  total_requests INT DEFAULT 0,
  cheap_model_count INT DEFAULT 0,
  mid_model_count INT DEFAULT 0,
  expert_model_count INT DEFAULT 0,
  budget_limit DECIMAL(10,2) DEFAULT 100.00,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(month)
);

CREATE INDEX IF NOT EXISTS idx_budget_tracking_month ON budget_tracking(month);

-- Auto-update timestamp on changes
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_budget_tracking_updated_at
    BEFORE UPDATE ON budget_tracking
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Initialize current month
INSERT INTO budget_tracking (month, total_cost, total_requests, cheap_model_count, mid_model_count, expert_model_count, budget_limit)
VALUES (
  TO_CHAR(NOW(), 'YYYY-MM'),
  0,
  0,
  0,
  0,
  0,
  100.00
)
ON CONFLICT (month) DO NOTHING;

-- Useful views for analytics
CREATE OR REPLACE VIEW daily_costs AS
SELECT
  DATE(timestamp) as date,
  SUM(cost_usd) as total_cost,
  COUNT(*) as request_count,
  chosen_model
FROM router_logs
GROUP BY DATE(timestamp), chosen_model
ORDER BY date DESC;

CREATE OR REPLACE VIEW model_distribution AS
SELECT
  chosen_model,
  COUNT(*) as request_count,
  SUM(cost_usd) as total_cost,
  AVG(response_time_ms) as avg_response_time
FROM router_logs
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY chosen_model;
