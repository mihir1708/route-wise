// Main API endpoint - routes queries to the right model

import type { NextApiRequest, NextApiResponse } from 'next';
import { RouteQueryRequest, RouteQueryResponse, RouterLog } from '@/types';
import { estimateDifficulty, selectModel } from '@/lib/difficulty-estimator';
import { getBudgetPercentage, checkBudgetAvailable, addUsage, getRemainingBudget } from '@/lib/budget-tracker';
import { callModel } from '@/lib/model-client';
import { calculateCost } from '@/utils/pricing';
import { logger } from '@/utils/logger';
import { supabaseAdmin } from '@/lib/supabase';
import crypto from 'crypto';
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RouteQueryResponse | { error: string }>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    const { query } = req.body as RouteQueryRequest;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required' });
    }

    logger.info('Received query', { query_length: query.length });

    // Make sure we haven't blown the budget
    const budgetAvailable = await checkBudgetAvailable();
    if (!budgetAvailable) {
      logger.error('Budget exceeded - rejecting request');
      return res.status(503).json({
        error: 'Monthly budget limit has been reached. Please try again next month.'
      });
    }

    // Get current budget usage
    const budgetPercentage = await getBudgetPercentage();
    logger.info('Current budget usage', { percentage: budgetPercentage.toFixed(2) });

    // Estimate how hard the query is
    const difficulty = await estimateDifficulty(query);
    logger.info('Difficulty estimated', { difficulty: difficulty.toFixed(2) });

    // Pick the right model
    const selectedModel = selectModel(difficulty, budgetPercentage);
    logger.info('Model selected', { model: selectedModel });

    // Get the answer
    const modelResponse = await callModel(query, selectedModel);

    // Calculate what it cost
    const cost = calculateCost(
      selectedModel,
      modelResponse.prompt_tokens,
      modelResponse.completion_tokens
    );

    logger.info('Request completed', {
      model: selectedModel,
      cost: cost.toFixed(6),
      tokens: modelResponse.total_tokens
    });

    // Track the spending
    await addUsage(cost, selectedModel);

    const remainingBudget = await getRemainingBudget();

    // Save to database for analytics
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    const queryHash = crypto.createHash('md5').update(query).digest('hex');

    const logEntry: RouterLog = {
      query_text: query,
      query_hash: queryHash,
      chosen_model: selectedModel,
      estimated_difficulty: difficulty,
      prompt_tokens: modelResponse.prompt_tokens,
      completion_tokens: modelResponse.completion_tokens,
      cost_usd: cost,
      response_time_ms: responseTime,
      was_successful: true
    };

    const { error: logError } = await supabaseAdmin
      .from('router_logs')
      .insert(logEntry);

    if (logError) {
      logger.error('Failed to log request', logError);
    }

    // Send back the answer
    const response: RouteQueryResponse = {
      answer: modelResponse.content,
      metadata: {
        model_used: selectedModel,
        difficulty_score: difficulty,
        tokens_used: modelResponse.total_tokens,
        cost: cost,
        remaining_budget: remainingBudget
      }
    };

    return res.status(200).json(response);

  } catch (error: any) {
    logger.error('Error processing query', error);

    // Log the failure too
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    try {
      const { query } = req.body as RouteQueryRequest;
      if (query) {
        const queryHash = crypto.createHash('md5').update(query).digest('hex');
        await supabaseAdmin.from('router_logs').insert({
          query_text: query,
          query_hash: queryHash,
          chosen_model: 'gpt-3.5-turbo',
          estimated_difficulty: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          response_time_ms: responseTime,
          was_successful: false
        });
      }
    } catch (logError) {
      logger.error('Failed to log error', logError);
    }

    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
}
