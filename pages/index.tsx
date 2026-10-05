import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';
import { protect } from '@/lib/access';
import { DEMO_MAX_INPUT_CHARS, DEMO_TASKS } from '@/lib/demo';
import { DEMO_TENANT, findTenantByName } from '@/lib/tenants';
import type { GatewayAnswer } from '@/types';

interface Props { demo: { budget: number; rpm: number } | null }

const TIER_STYLE = { low: 'bg-green-100 text-green-800', mid: 'bg-amber-100 text-amber-800', high: 'bg-purple-100 text-purple-800' } as const;

/** Plain-language versions of the gateway's rejection codes. */
function explain(status: number, error: string, retryAfter: string | null): string {
  const wait = retryAfter ? ` Try again in ${retryAfter} seconds.` : '';
  if (error === 'rpm_exceeded' || error === 'tpm_exceeded') return `The demo's shared rate limit is used up for this minute.${wait}`;
  if (status === 429) return `You have sent the most requests one visitor can send in a minute.${wait}`;
  if (error === 'tenant_budget_exhausted') return "The demo's budget for this month is spent, so the gateway is refusing new requests.";
  if (error === 'budget_exhausted') return 'The global monthly budget is spent, so the gateway is refusing new requests.';
  if (error === 'all_providers_failed') return 'Every model for the chosen tier failed, including the fallback provider.';
  if (error === 'invalid_model_output') return 'The model returned output that failed the schema, even after escalating a tier.';
  return `Request failed: ${error}`;
}

export default function Home({ demo }: Props) {
  const [task, setTask] = useState(DEMO_TASKS[0].task);
  const [input, setInput] = useState(DEMO_TASKS[0].sample);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<GatewayAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionCost, setSessionCost] = useState(0);

  const choose = (next: typeof task) => {
    setTask(next); setInput(DEMO_TASKS.find(t => t.task === next)!.sample); setAnswer(null); setError(null);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setLoading(true); setError(null); setAnswer(null);
    try {
      const res = await fetch('/api/route-query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_type: task, input }),
      });
      const data = await res.json();
      if (!res.ok) { setError(explain(res.status, data.error ?? 'unknown_error', res.headers.get('Retry-After'))); return; }
      setAnswer(data);
      setSessionCost(c => c + data.metadata.cost_usd);
    } catch {
      setError('Could not reach the gateway.');
    } finally { setLoading(false); }
  };

  const m = answer?.metadata;
  return <>
    <Head>
      <title>RouteWise: cost-aware LLM gateway</title>
      <meta name="description" content="Routes each request to the cheapest model tier likely to handle it, with fallback, caching and per-tenant budgets." />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
    </Head>
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 md:text-5xl">RouteWise</h1>
          <p className="mt-3 text-lg text-gray-700">An LLM gateway that sends each support task to the cheapest model tier likely to handle it,
            falls back to a second provider when one fails, and enforces per-tenant budgets and rate limits.</p>
          <Link href="/admin" className="mt-3 inline-block font-medium text-indigo-700 hover:text-indigo-900">Gateway dashboard (admin) →</Link>
        </header>

        <p className="rounded-lg bg-white/70 p-3 text-center text-sm text-gray-700">
          {demo
            ? `This demo runs as a tenant with a $${demo.budget.toFixed(2)} monthly budget and ${demo.rpm} requests a minute, shared by every visitor. When either runs out, the gateway refuses requests; that is part of the demo.`
            : 'This demo runs as a tenant with a small monthly budget and a shared rate limit.'}
        </p>

        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Task">
            {DEMO_TASKS.map(t => <button key={t.task} type="button" role="tab" aria-selected={t.task === task} onClick={() => choose(t.task)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${t.task === task ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{t.label}</button>)}
          </div>
          <label htmlFor="input" className="block text-sm font-semibold text-gray-700">{task === 'chat' ? 'Question' : 'Support ticket'}</label>
          <textarea id="input" value={input} onChange={e => setInput(e.target.value)} rows={6} maxLength={DEMO_MAX_INPUT_CHARS} disabled={loading}
            className="w-full resize-y rounded-lg border-2 border-gray-300 bg-white px-4 py-3 text-gray-900 focus:border-indigo-500 focus:outline-none" />
          <p className="text-xs text-gray-500">{input.length} / {DEMO_MAX_INPUT_CHARS} characters. Inputs are not stored; telemetry keeps only a hash.</p>
          <button type="submit" disabled={loading || !input.trim()}
            className="w-full rounded-lg bg-indigo-600 px-6 py-3 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-400">
            {loading ? 'Routing…' : 'Run through the gateway'}</button>
        </form>

        {error && <div role="alert" className="rounded-lg border-2 border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}

        {answer && m && <section className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
          <h2 className="text-xl font-bold text-gray-900">Answer</h2>
          <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-4 font-sans text-gray-800">
            {answer.output !== undefined ? JSON.stringify(answer.output, null, 2) : answer.answer}</pre>
          {m.truncated && <p className="text-sm text-amber-700">The model hit the output limit, so this answer is cut short.</p>}
          {m.accounting_status === 'failed' && <p className="text-sm text-amber-700">Answered, but the charge needs reconciliation (request {m.request_id}).</p>}

          <h2 className="pt-2 text-xl font-bold text-gray-900">How it was routed</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${TIER_STYLE[m.tier]}`}>{m.tier} tier</span>
            <span className="font-mono text-sm">{m.model}</span>
            {m.cache_hit && <span className="rounded-full bg-slate-200 px-3 py-1 text-xs">served from cache</span>}
            {m.fallback_used && <span className="rounded-full bg-blue-100 px-3 py-1 text-xs">fell back to second provider</span>}
            {m.escalated && <span className="rounded-full bg-amber-100 px-3 py-1 text-xs">escalated after invalid output</span>}
          </div>
          {m.route_reasons && m.route_reasons.length > 0 && <ul className="list-disc pl-6 text-sm text-gray-700">
            {m.route_reasons.map(r => <li key={r}>{r}</li>)}</ul>}
          {m.cache_hit && <p className="text-sm text-gray-700">Someone already ran this exact input, so the gateway returned the stored answer without calling a model.</p>}
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
            {([['Cost', `$${m.cost_usd.toFixed(6)}`], ['Latency', `${m.latency_ms} ms`], ['Tokens in / out', `${m.tokens.input} / ${m.tokens.output}`],
              ['Model calls', String(m.attempts)], ['Prompt', m.prompt_version]] as const).map(([k, v]) =>
              <div key={k} className="rounded-lg bg-blue-50 p-3"><dt className="text-gray-600">{k}</dt><dd className="font-semibold text-gray-900">{v}</dd></div>)}
          </dl>
          {m.tenant_budget !== undefined && m.tenant_budget_remaining !== undefined && <div>
            <div className="mb-1 flex justify-between text-sm text-gray-600"><span>Demo budget left this month</span>
              <span className="font-semibold text-gray-900">${m.tenant_budget_remaining.toFixed(4)} of ${m.tenant_budget.toFixed(2)}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-200"><div className="h-full bg-green-500"
              style={{ width: `${Math.min(100, (m.tenant_budget_remaining / m.tenant_budget) * 100)}%` }} /></div>
          </div>}
        </section>}

        {sessionCost > 0 && <p className="text-center text-sm text-gray-700">This session has cost ${sessionCost.toFixed(6)}.</p>}
      </div>
    </main>
  </>;
}

export const getServerSideProps: GetServerSideProps<Props> = async ({ req, res }) => {
  // protect() has already sent the 401 when it returns false; Next.js then renders nothing.
  if (!protect(req, res, 'demo', false)) return { props: { demo: null } };
  try {
    const tenant = await findTenantByName(DEMO_TENANT);
    return { props: { demo: tenant?.active ? { budget: tenant.monthly_budget, rpm: tenant.rpm_limit } : null } };
  } catch { return { props: { demo: null } }; }
};
