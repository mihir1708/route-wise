import { describe, expect, it } from 'vitest';
import { estimateDifficulty, selectModel } from '@/lib/difficulty-estimator';

// Neutral padding keeps exact-length cases free of accidental keyword matches.
const atLength = (prefix: string, length: number) => prefix.padEnd(length, 'x');
const neutral = (length: number) => atLength('zz zz zz ', length);

describe('estimateDifficulty: current first-match behavior', () => {
  it.each([
    ['', 0.2],
    ['hello', 0.2],
    ['explain why and sum', 0.2],
    ['explain?', 0.25],
    ['why?', 0.25],
    ['solve?', 0.25],
    ['define?', 0.25],
    ['a b c?', 0.25],
    ['a b c d?', 0.5],
    [neutral(19), 0.2],
    [neutral(20), 0.5],
    [neutral(21), 0.5],
  ])('scores %j as %s (short exits precede keywords)', async (query, score) => {
    expect(await estimateDifficulty(query)).toBe(score);
  });

  it.each([1, 2, 3, 4])('preserves the %i-word boundary even for long hard prompts', async words => {
    const query = ['explain' + 'x'.repeat(201), ...Array<string>(words - 1).fill('zz')].join(' ');
    expect(await estimateDifficulty(query)).toBe(words <= 3 ? 0.25 : 0.9);
  });

  it('counts literal spaces rather than whitespace-separated words', async () => {
    expect(await estimateDifficulty('explain zz zz?')).toBe(0.25);
    expect(await estimateDifficulty('explain  zz zz?')).toBe(0.8);
    expect(await estimateDifficulty('explain\tzz\tzz\tzz?')).toBe(0.25);
  });

  it.each([
    'explain', 'analyze', 'complex', 'detailed', 'comprehensive',
    'elaborate', 'examine', 'evaluate', 'compare', 'contrast',
    'implications', 'consequences', 'step-by-step', 'thorough',
  ])('recognizes hard keyword %s, ignoring case', async keyword => {
    expect(await estimateDifficulty(`${keyword.toUpperCase()} zz zz zz?`)).toBe(0.8);
    expect(await estimateDifficulty(atLength(`${keyword} zz zz zz `, 101))).toBe(0.9);
  });

  it.each([[99, 0.8], [100, 0.8], [101, 0.9]])('hard length %i → %s', async (length, score) => {
    expect(await estimateDifficulty(atLength('explain zz zz ', length))).toBe(score);
  });

  it.each([
    'why', 'how', 'describe', 'discuss', 'summarize',
    'outline', 'review', 'calculate', 'determine',
  ])('recognizes medium-hard keyword %s before later rules', async keyword => {
    expect(await estimateDifficulty(`${keyword.toUpperCase()} zz zz zz?`)).toBe(0.7);
    expect(await estimateDifficulty(atLength(`${keyword} zz zz `, 151))).toBe(0.75);
    expect(await estimateDifficulty(`${keyword} zz and zz?`)).toBe(0.75);
  });

  it.each([[149, 0.7], [150, 0.7], [151, 0.75]])('medium length %i → %s', async (length, score) => {
    expect(await estimateDifficulty(atLength('why zz zz ', length))).toBe(score);
  });

  it.each([' and ', ' also ', ' additionally ', ' furthermore ', ' moreover ', ' plus ', ' as well as '])(
    'recognizes multipart indicator %j', async indicator => {
      expect(await estimateDifficulty(`zz zz${indicator.toUpperCase()}zz?`)).toBe(0.6);
    },
  );

  it.each(['compute', 'solve', 'equation', 'formula', '+', '-', '*', '/', '=', 'sum', 'total'])(
    'recognizes math marker %s', async marker => {
      expect(await estimateDifficulty(`zz zz ${marker.toUpperCase()} zz?`)).toBe(0.3);
    },
  );

  it.each([[99, 0.3], [100, 0.5], [101, 0.6]])('math length %i → %s', async (length, score) => {
    expect(await estimateDifficulty(atLength('solve zz zz ', length))).toBe(score);
  });

  it.each(['define', 'what is', 'who is', 'when was', 'where is', 'meaning of', 'definition'])(
    'recognizes simple-fact phrase %s regardless of length', async phrase => {
      expect(await estimateDifficulty(`${phrase.toUpperCase()} zz zz zz?`)).toBe(0.3);
      expect(await estimateDifficulty(atLength(`${phrase} zz zz `, 201))).toBe(0.3);
    },
  );

  it.each([
    ['calculate zz zz zz?', 0.7], // Medium-hard wins over math.
    ['explain why zz and solve?', 0.8], // Hard wins over reasoning/multipart/math.
    ['why zz and solve zz?', 0.75], // Reasoning wins over multipart/math.
    ['define zz and solve zz?', 0.6], // Multipart wins over math/facts.
    ['unexplained zz zz zz?', 0.8], // Substrings, not word boundaries.
    ['somehow zz zz zz?', 0.7],
    ['assumption zz zz zz?', 0.3],
    ['zz zz candy zz?', 0.5], // Multipart requires surrounding spaces.
    ['and zz zz zz?', 0.5],
  ])('preserves rule precedence/substrings for %j', async (query, score) => {
    expect(await estimateDifficulty(query)).toBe(score);
  });

  it.each([
    [49, 0.5], [50, 0.5], [51, 0.5],
    [99, 0.5], [100, 0.5], [101, 0.6],
    [199, 0.6], [200, 0.6], [201, 0.7],
  ])('default length %i → %s', async (length, score) => {
    expect(await estimateDifficulty(neutral(length))).toBe(score);
  });

  it('uses original length, even though matching trims whitespace', async () => {
    expect(await estimateDifficulty('explain zz zz zz?')).toBe(0.8);
    expect(await estimateDifficulty('explain zz zz zz?' + ' '.repeat(100))).toBe(0.9);
  });
});

// Each currently reachable score has a representative input. These fixtures
// connect estimator behavior to selection, including the unreachable high tier.
const reachable = [
  ['hello', 0.2], ['hello?', 0.25], ['solve zz zz zz?', 0.3],
  ['zz zz zz zz?', 0.5], ['zz zz and zz?', 0.6], ['why zz zz zz?', 0.7],
  ['why zz and zz?', 0.75], ['explain zz zz zz?', 0.8],
  [atLength('explain zz zz ', 101), 0.9],
] as const;

describe('selectModel: existing budget thresholds', () => {
  it.each([
    [0, [0.8, 0.9]], [79.999, [0.8, 0.9]],
    [80, [0.9]], [85, [0.9]], [89.999, [0.9]],
    [90, []], [95, []], [100, []], [110, []],
  ] as const)('routes every reachable score at budget=%s', async (budget, expertScores) => {
    for (const [query, score] of reachable) {
      expect(await estimateDifficulty(query)).toBe(score);
      const expected = (expertScores as readonly number[]).includes(score) ? 'gpt-4' : 'gpt-3.5-turbo';
      expect(selectModel(score, budget), `difficulty=${score}, budget=${budget}`).toBe(expected);
    }
  });

  it.each([
    [0.7999, 79.999, 'gpt-3.5-turbo'], [0.8, 79.999, 'gpt-4'],
    [0.8499, 80, 'gpt-3.5-turbo'], [0.85, 80, 'gpt-4'],
    [0.9499, 90, 'gpt-3.5-turbo'], [0.95, 90, 'gpt-4'],
    [0.95, 100, 'gpt-4'], // Budget blocking belongs to the API, not selectModel.
  ] as const)('difficulty %s at budget=%s selects %s', (score, budget, model) => {
    expect(selectModel(score, budget)).toBe(model);
  });

  it('cannot select the high tier at >=90% for any currently reachable score', async () => {
    for (const [query] of reachable) {
      const score = await estimateDifficulty(query);
      expect(score).toBeLessThanOrEqual(0.9);
      for (const budget of [90, 90.001, 99, 100, 150]) {
        expect(selectModel(score, budget)).toBe('gpt-3.5-turbo');
      }
    }
  });
});
