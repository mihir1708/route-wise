import { getModel } from '@/lib/model-registry';
// Wrapper for calling OpenAI models

import OpenAI from 'openai';
import { ModelName, ModelResponse } from '@/types';
import { logger } from '@/utils/logger';

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI is not configured');
  return new OpenAI({ apiKey, timeout: 60000, maxRetries: 0 });
}

// Send a query to the specified model
export async function callModel(
  query: string,
  model: ModelName
): Promise<ModelResponse> {
  const startTime = Date.now();

  try {
    logger.info(`Calling model: ${model}`, { query_length: query.length });

    const config = getModel(model);
    if (!config.enabled) throw new Error('Model disabled');
    const response = await getOpenAI().chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that provides accurate and concise answers to user questions.'
        },
        {
          role: 'user',
          content: query
        }
      ],
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    const content = response.choices[0]?.message?.content || '';
    const promptTokens = response.usage?.prompt_tokens ?? NaN;
    const completionTokens = response.usage?.completion_tokens ?? NaN;
    const totalTokens = response.usage?.total_tokens ?? NaN;

    logger.info(`Model response received in ${duration}ms`, {
      model,
      tokens: totalTokens,
      duration_ms: duration
    });

    return {
      content,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    };
  } catch (error: any) {
    logger.error('Error calling model', {
      model,
      status: typeof error.status === 'number' ? error.status : null
    });

    // Handle common API errors
    if (error.status === 429) {
      throw new Error('Rate limit exceeded. Please try again later.');
    } else if (error.status === 401) {
      throw new Error('Invalid API key. Please check your OpenAI configuration.');
    } else if (error.status === 503) {
      throw new Error('Model is currently overloaded. Please try again.');
    }

    throw new Error(`Failed to get response from ${model}`);
  }
}

// Test if OpenAI API key works
export async function testConnection(): Promise<boolean> {
  try {
    await getOpenAI().models.list();
    return true;
  } catch (error) {
    logger.error('OpenAI connection test failed', error);
    return false;
  }
}
