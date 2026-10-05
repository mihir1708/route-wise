// The pre-registration pins what the experiment measures before any live call is made.
// A live run refuses to start if the code or data drifted from it, or if nobody approved it.
import type { ModelConfig, ModelTier } from '@/lib/model-registry';
import { CONFIGS } from './harness';
import { MAX_CLASS_LOSS_RUNS, MAX_SUCCESS_GAP } from './report';
import { JUDGE_PASS_SCORE, JUDGE_VERSION } from './scoring';

export const DEFAULT_RUNS = 2;

export interface PinnedInputs {
  benchmarkVersion: string;
  benchmarkHash: string;
  promptVersions: string[];
  policyVersions: string[];
  models: readonly ModelConfig[];
  runs: number;
}

/** The exact values the pre-registration must list, one "- Key: `value`" line each. */
export function pinnedValues(p: PinnedInputs): Record<string, string> {
  const tiers: ModelTier[] = ['low', 'mid', 'high'];
  const enabled = p.models.filter(m => m.enabled);
  return {
    'Dataset': p.benchmarkVersion,
    'Dataset SHA-256': p.benchmarkHash,
    'Configs': CONFIGS.map(c => `${c.name}=${c.allowedTiers.join('+')}`).join('; '),
    'Prompts': p.promptVersions.join(', '),
    'Routing policy': p.policyVersions.join(', '),
    'Models': tiers.map(t => `${t}: ${enabled.filter(m => m.tier === t).map(m => m.id).join(' > ')}`).join('; '),
    'Pricing': [...new Set(enabled.map(m => m.pricingVersion))].join(', '),
    'Judge': `${JUDGE_VERSION} on the high tier, pass at ${JUDGE_PASS_SCORE}/5`,
    'Bar': `routed success at most ${Math.round(MAX_SUCCESS_GAP * 100)} points below all-premium overall, and at most ${MAX_CLASS_LOSS_RUNS} ticket-run below in each class`,
    'Runs': String(p.runs),
  };
}

export interface PreregistrationCheck { approvedBy: string | null; problems: string[] }

export function checkPreregistration(text: string, pinned: Record<string, string>): PreregistrationCheck {
  const listed = new Map<string, string>();
  for (const match of text.matchAll(/^- ([^:\n]+): `([^`\n]*)`\s*$/gm)) listed.set(match[1].trim(), match[2]);
  const problems: string[] = [];
  for (const [key, value] of Object.entries(pinned)) {
    if (!listed.has(key)) problems.push(`${key} is not listed`);
    else if (listed.get(key) !== value) problems.push(`${key} differs from the code`);
  }
  const approval = /^Approved by:[ \t]*(.*)$/m.exec(text)?.[1].trim() ?? '';
  const approvedBy = approval && !/^pending\b/i.test(approval) ? approval : null;
  if (!approvedBy) problems.push('not approved yet');
  return { approvedBy, problems };
}

/** The pinned block as it should appear in the pre-registration, for pasting after a deliberate change. */
export function renderPinned(pinned: Record<string, string>): string {
  return Object.entries(pinned).map(([key, value]) => `- ${key}: \`${value}\``).join('\n');
}
