import { createHash } from 'node:crypto';
import { supabaseAdmin } from './supabase';
import type { RequestRun } from './request-run';
export function shouldVerify(requestId: string, consent: boolean): boolean {
  if (!consent || process.env.ROUTEWISE_VERIFICATION_ENABLED !== '1') return false;
  const rate = Number(process.env.ROUTEWISE_VERIFICATION_SAMPLE_RATE ?? '0.15');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return false;
  const bucket = createHash('sha256').update(requestId).digest().readUInt32BE(0) / 0x100000000;
  return bucket < rate;
}
export async function enqueueVerification(query: string, answer: string, run: RequestRun, consent: boolean) {
  if (!run.application_succeeded || run.failure_stage || !shouldVerify(run.request_id,consent)) return;
  const { error } = await supabaseAdmin.from('verification_jobs').insert({
    request_id: run.request_id, routed_model: run.selected_model, routed_tier: run.selected_tier,
    payload: { query, answer },
  });
  if (error) throw new Error('Verification enqueue failed');
}
