// Wrapper for calling OpenAI models

import OpenAI from 'openai';
import { ModelName, ModelResponse } from '@/types';
import { logger } from '@/utils/logger';

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

const openai = new OpenAI({
  apiKey: apiKey,
});

// Send a query to the specified model
export async function callModel(
  query: string,
  model: ModelName
): Promise<ModelResponse> {
  const startTime = Date.now();

  try {
    logger.info(`Calling model: ${model}`, { query_length: query.length });

    const response = await openai.chat.completions.create({
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
      temperature: model === 'gpt-4' ? 0.7 : 0.5,
      max_tokens: 1000,
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    const content = response.choices[0]?.message?.content || '';
    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    const totalTokens = response.usage?.total_tokens || 0;

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
      error: error.message
    });

    // Handle common API errors
    if (error.status === 429) {
      throw new Error('Rate limit exceeded. Please try again later.');
    } else if (error.status === 401) {
      throw new Error('Invalid API key. Please check your OpenAI configuration.');
    } else if (error.status === 503) {
      throw new Error('Model is currently overloaded. Please try again.');
    }

    throw new Error(`Failed to get response from ${model}: ${error.message}`);
  }
}

// Test if OpenAI API key works
export async function testConnection(): Promise<boolean> {
  try {
    await openai.models.list();
    return true;
  } catch (error) {
    logger.error('OpenAI connection test failed', error);
    return false;
  }
}
