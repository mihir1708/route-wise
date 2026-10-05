import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  ArcElement, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import { protect } from '@/lib/access';
import { DASHBOARD_DAYS, dashboardRates } from '@/lib/dashboard';
import { PUBLISHED_RUN } from '@/experiment/published';
import type { DashboardStats } from '@/types';

ChartJS.register(ArcElement, BarElement, CategoryScale, Legend, LinearScale, LineElement, PointElement, Tooltip);

const TIER_COLORS = { low: '#16a34a', mid: '#d97706', high: '#7c3aed' } as const;
const CACHE_COLOR = '#64748b';
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null, digits = 4) => (v === null ? '—' : `$${v.toFixed(digits)}`);
const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const percentAxis: ChartOptions<'bar'> = {
  indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => pct(c.parsed.x) } } },
  scales: { x: { min: 0, ticks: { callback: v => `${Math.round(Number(v) * 100)}%` } } },
};

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded border bg-white p-4"><p className="text-sm text-gray-600">{label}</p>
    <p className="text-2xl font-semibold">{value}</p>{note && <p className="text-xs text-gray-500">{note}</p>}</div>;
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className="rounded border bg-white p-4"><h2 className="font-bold">{title}</h2>
    {note && <p className="mb-2 text-xs text-gray-500">{note}</p>}{children}</section>;
}

export default function Admin({ benchmark }: { benchmark: typeof PUBLISHED_RUN }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState<number>(7);
  const [tenant, setTenant] = useState('');
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/stats?${new URLSearchParams({ days: String(days), tenant })}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setStats(data); setError('');
    } catch { setError('Unable to load statistics. Check admin access and that migrations 001–012 are applied.'); }
  }, [days, tenant]);
  useEffect(() => { void load(); const timer = setInterval(load, 30000); return () => clearInterval(timer); }, [load]);

  const s = stats?.summary;
  const r = s ? dashboardRates(s) : null;
  const tiers = stats?.tiers ?? [];
  return <main className="min-h-screen bg-gray-50 p-4 text-gray-900 md:p-8"><Head><title>RouteWise dashboard</title></Head>
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end gap-4">
        <div className="mr-auto"><h1 className="text-3xl font-bold">RouteWise gateway</h1>
          <Link href="/" className="text-sm text-blue-700">Back to the demo</Link></div>
        <label className="text-sm">Tenant<br /><select value={tenant} onChange={e => setTenant(e.target.value)} className="rounded border bg-white px-2 py-1">
          <option value="">All tenants</option>{stats?.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="text-sm">Window<br /><select value={days} onChange={e => setDays(Number(e.target.value))} className="rounded border bg-white px-2 py-1">
          {DASHBOARD_DAYS.map(d => <option key={d} value={d}>Last {d} days</option>)}</select></label>
        <button onClick={load} className="rounded border bg-white px-4 py-1.5">Refresh</button>
      </header>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {stats && s && r && <>
        <p className="text-sm text-gray-600">Production requests from {stats.window_start.slice(0, 10)} to {stats.window_end.slice(0, 10)} (UTC, end exclusive).
          Benchmark runs are not included.</p>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <Card label="Requests" value={s.requests.toLocaleString()} />
          <Card label="Succeeded" value={pct(r.success)} note={`${s.succeeded.toLocaleString()} answered`} />
          <Card label="Cost per successful request" value={usd(r.costPerSuccess, 5)} note="All spend, failed calls included" />
          <Card label="Spend in window" value={usd(Number(s.cost_usd))} />
          <Card label="p50 / p95 latency" value={`${ms(s.p50_ms)} / ${ms(s.p95_ms)}`} note="Answered by a model, not cached" />
          <Card label={`${stats.budget.scope === 'tenant' ? 'Tenant' : 'Global'} budget, ${stats.budget.month}`}
            value={`${usd(stats.budget.spent, 2)} of ${usd(stats.budget.limit, 2)}`} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Gateway rates" note="Fallback and escalation rates are per request that called a model; the others are per request.">
            <Bar options={percentAxis} data={{
              labels: ['Cache hits', 'Fallback to second provider', 'Escalated after invalid output', 'Rejected by rate limit', 'Failed'],
              datasets: [{ data: [r.cacheHit, r.fallback, r.escalation, r.rateLimited, r.success === null ? null : 1 - r.success],
                backgroundColor: ['#64748b', '#2563eb', '#d97706', '#dc2626', '#991b1b'] }],
            }} />
          </Panel>
          <Panel title="Traffic by tier" note="Requests routed to each tier (the tier escalated to, if any), and cache hits.">
            <div className="mx-auto max-w-xs"><Doughnut data={{
              labels: [...tiers.map(t => t.tier), 'cache'],
              datasets: [{ data: [...tiers.map(t => t.requests), s.cache_hits], backgroundColor: [...tiers.map(t => TIER_COLORS[t.tier]), CACHE_COLOR] }],
            }} /></div>
          </Panel>
          <Panel title="Latency by tier" note="Successful requests a model answered.">
            <Bar options={{ scales: { y: { title: { display: true, text: 'ms' } } } }} data={{
              labels: tiers.map(t => t.tier),
              datasets: [{ label: 'p50', data: tiers.map(t => t.p50_ms), backgroundColor: '#93c5fd' },
                { label: 'p95', data: tiers.map(t => t.p95_ms), backgroundColor: '#1d4ed8' }],
            }} />
          </Panel>
          <Panel title="Cost per successful request by tier">
            <Bar options={{ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => usd(c.parsed.y, 5) } } } }} data={{
              labels: tiers.map(t => t.tier),
              datasets: [{ data: tiers.map(t => (t.succeeded ? Number(t.cost_usd) / t.succeeded : null)), backgroundColor: tiers.map(t => TIER_COLORS[t.tier]) }],
            }} />
          </Panel>
        </div>

        <Panel title="Requests per day" note="Stacked by the tier that answered. Spend for each day is in the tooltip.">
          <Bar options={{
            scales: { x: { stacked: true }, y: { stacked: true } },
            plugins: { tooltip: { callbacks: { footer: items => `Spend: ${usd(Number(stats.daily[items[0].dataIndex].cost_usd))}` } } },
          }} data={{
            labels: stats.daily.map(d => d.date.slice(5)),
            datasets: [
              ...(['low', 'mid', 'high'] as const).map(t => ({ label: t, data: stats.daily.map(d => d[t]), backgroundColor: TIER_COLORS[t] })),
              { label: 'cache', data: stats.daily.map(d => d.cache), backgroundColor: CACHE_COLOR },
              { label: 'no model', data: stats.daily.map(d => d.requests - d.low - d.mid - d.high - d.cache), backgroundColor: '#fca5a5' },
            ],
          }} />
        </Panel>

        <div className="grid gap-4 md:grid-cols-2">
          <Panel title={`Quality baseline: benchmark run, ${benchmark.date}`}
            note={`${benchmark.items} support tickets × ${benchmark.runs} runs, judged against a pre-registered bar. Routing ${benchmark.barPassed ? 'met' : 'did not meet'} the bar, so no savings claim is made. Offline run, not production traffic.`}>
            <table className="w-full text-sm"><thead><tr><th className="text-left">Config</th><th className="text-right">Success</th><th className="text-right">Cost per success</th></tr></thead>
              <tbody>{benchmark.configs.map(c => <tr key={c.config} className="border-t"><td className="py-1">{c.config}</td>
                <td className="text-right">{pct(c.successRate)}</td><td className="text-right">{usd(c.costPerSuccessUsd, 5)}</td></tr>)}</tbody></table>
          </Panel>
          <Panel title="Models and accounting">
            <ul className="text-sm">{Object.entries(stats.models).sort((a, b) => b[1] - a[1]).map(([m, n]) => <li key={m}>{m}: {n}</li>)}</ul>
            <p className="mt-3 text-sm">Budget rejections: {s.budget_rejected}. Settlement failures: {s.unsettled}. Answers with unknown usage: {s.unknown_usage}.</p>
            <p className="text-xs text-gray-500">Spend here is the gateway&apos;s own accounting, not a provider invoice.</p>
          </Panel>
        </div>

        <section className="overflow-auto rounded border bg-white p-4"><h2 className="font-bold">Recent requests</h2>
          <table className="w-full text-sm"><thead><tr>{['Time', 'Tenant', 'Task', 'Model / tier', 'Path', 'Outcome', 'Latency', 'Cost'].map(x =>
            <th key={x} className="p-2 text-left">{x}</th>)}</tr></thead>
          <tbody>{stats.recent.map(q => <tr key={q.request_id} className="border-t">
            <td className="p-2">{new Date(q.timestamp).toLocaleString()}</td><td className="p-2">{q.tenant_name ?? '—'}</td>
            <td className="p-2">{q.task_type ?? '—'}</td><td className="p-2">{q.selected_model ?? 'not routed'} / {q.selected_tier ?? '—'}</td>
            <td className="p-2">{[q.cache_hit && 'cache', q.fallback_used && 'fallback', q.escalated && 'escalated'].filter(Boolean).join(', ') || q.routing_policy_version}</td>
            <td className="p-2">{q.application_succeeded ? 'success' : `${q.failure_stage ?? 'failed'}${q.error_category ? `: ${q.error_category}` : ''}`}</td>
            <td className="p-2">{ms(q.latency_ms)}</td><td className="p-2">{q.cost_usd === null ? 'unknown' : usd(Number(q.cost_usd), 6)}</td>
          </tr>)}</tbody></table>
        </section>
      </>}
    </div></main>;
}

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  // protect() has already sent the 401/403 when it returns false; Next.js then renders nothing.
  if (!protect(req, res, 'admin', false)) return { props: {} };
  return { props: { benchmark: PUBLISHED_RUN } };
};
