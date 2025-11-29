// Estimates how complex a query is to pick the right model

import { DifficultyScore } from '@/types';

// Keywords that suggest different difficulty levels
const HARD_KEYWORDS = [
  'explain', 'analyze', 'complex', 'detailed', 'comprehensive',
  'elaborate', 'examine', 'evaluate', 'compare', 'contrast',
  'implications', 'consequences', 'step-by-step', 'thorough'
];

const MEDIUM_HARD_KEYWORDS = [
  'why', 'how', 'describe', 'discuss', 'summarize',
  'outline', 'review', 'calculate', 'determine'
];

const MULTI_PART_INDICATORS = [
  ' and ', ' also ', ' additionally ', ' furthermore ',
  ' moreover ', ' plus ', ' as well as '
];

const MATH_KEYWORDS = [
  'calculate', 'compute', 'solve', 'equation', 'formula',
  '+', '-', '*', '/', '=', 'sum', 'total'
];

const SIMPLE_FACTS_KEYWORDS = [
  'define', 'what is', 'who is', 'when was', 'where is',
  'meaning of', 'definition'
];

// Analyze query and return difficulty score (0.0 = easy, 1.0 = hard)
export async function estimateDifficulty(query: string): Promise<DifficultyScore> {
  const lowerQuery = query.toLowerCase().trim();
  const length = query.length;
  
  // Short queries without questions are usually greetings
  if (length < 20 && !lowerQuery.includes('?')) {
    return 0.2;
  }

  // Very short queries are simple lookups
  if (query.split(' ').length <= 3) {
    return 0.25;
  }

  // Check for complex analysis keywords
  const hasHardKeywords = HARD_KEYWORDS.some(keyword => 
    lowerQuery.includes(keyword.toLowerCase())
  );
  if (hasHardKeywords) {
    if (length > 100) {
      return 0.9;
    }
    return 0.8;
  }

  // Check for reasoning keywords
  const hasMediumHardKeywords = MEDIUM_HARD_KEYWORDS.some(keyword =>
    lowerQuery.includes(keyword.toLowerCase())
  );
  if (hasMediumHardKeywords) {
    if (length > 150 || hasMultipleParts(lowerQuery)) {
      return 0.75;
    }
    return 0.7;
  }

  // Multi-part questions need more thought
  if (hasMultipleParts(lowerQuery)) {
    return 0.6;
  }

  // Math queries are usually straightforward
  const isMathQuery = MATH_KEYWORDS.some(keyword =>
    lowerQuery.includes(keyword.toLowerCase())
  );
  if (isMathQuery && length < 100) {
    return 0.3;
  }

  // Simple fact lookups
  const isSimpleFact = SIMPLE_FACTS_KEYWORDS.some(keyword =>
    lowerQuery.includes(keyword.toLowerCase())
  );
  if (isSimpleFact) {
    return 0.3;
  }

  // Use length as a rough estimate
  if (length > 200) {
    return 0.7;
  } else if (length > 100) {
    return 0.6;
  } else if (length > 50) {
    return 0.5;
  }

  return 0.5;
}

// Check if query has multiple parts
function hasMultipleParts(query: string): boolean {
  return MULTI_PART_INDICATORS.some(indicator =>
    query.includes(indicator.toLowerCase())
  );
}

// Pick which model to use based on difficulty and budget
export function selectModel(
  difficulty: DifficultyScore,
  budgetPercentageUsed: number
): 'gpt-3.5-turbo' | 'gpt-4' {
  // Running low on budget? Be more conservative
  if (budgetPercentageUsed >= 90) {
    return difficulty >= 0.95 ? 'gpt-4' : 'gpt-3.5-turbo';
  }

  if (budgetPercentageUsed >= 80) {
    return difficulty >= 0.85 ? 'gpt-4' : 'gpt-3.5-turbo';
  }

  // Normal routing: hard queries get GPT-4, everything else gets 3.5
  if (difficulty >= 0.8) {
    return 'gpt-4';
  } else {
    return 'gpt-3.5-turbo';
  }
}
