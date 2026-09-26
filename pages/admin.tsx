import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useEffect,useState } from 'react';
import { protect } from '@/lib/access';
import type { UsageStats } from '@/types';
export default function Admin() {
  const [stats,setStats]=useState<UsageStats|null>(null);
  const [error,setError]=useState('');
  async function load() {
    try { const response=await fetch('/api/admin/stats'); const data=await response.json(); if(!response.ok) throw new Error(data.error);setStats(data);setError(''); }
    catch {setError('Unable to load statistics. Check admin access and migrations.');}
  }
  useEffect(()=>{ void load();const timer=setInterval(load,30000);return()=>clearInterval(timer); },[]);
  return <main className="min-h-screen bg-gray-50 p-8 text-gray-900"><div className="max-w-6xl mx-auto space-y-6">
    <h1 className="text-3xl font-bold">RouteWise production usage</h1>
    <p>Production requests only. Evaluation reports are separate local artifacts.</p>
    <Link href="/" className="text-blue-700">Back to query interface</Link>
    <button onClick={load} className="ml-6 rounded border px-4 py-2">Refresh</button>
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {stats&&<>
      <p>UTC window: {stats.window_start.slice(0,10)} to {stats.window_end.slice(0,10)} (exclusive).</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{[
        ['Requests recorded',stats.total_requests],['Captured query cost',`$${stats.total_cost.toFixed(6)}`],
        ['Accounted spend incl. verification',`$${stats.accounted_spend.toFixed(6)}`],['Budget limit',`$${stats.budget_limit.toFixed(2)}`],
        ['Budget remaining',`$${stats.budget_remaining.toFixed(6)}`],['Failures / partial failures',stats.failed_requests],
        ['Settlement failures',stats.unsettled_requests],['Unknown paid usage',stats.unknown_usage_requests],
      ].map(([label,value])=><div key={label} className="rounded bg-white p-4 border"><p className="text-sm text-gray-600">{label}</p><p className="text-xl font-semibold">{value}</p></div>)}</div>
      <p>Captured cost and accounted spend can differ after partial failures, resets, verification calls, or migration. Budget totals are not a provider invoice.</p>
      <div className="grid md:grid-cols-3 gap-4">{[
        ['Models',stats.model_distribution],['Tiers',stats.tier_distribution],['Policies',stats.policy_distribution],
      ].map(([label,distribution])=><section key={String(label)} className="bg-white border rounded p-4"><h2 className="font-bold">{String(label)}</h2>{Object.entries(distribution).map(([key,count])=><p key={key}>{key}: {count}</p>)}</section>)}</div>
      <section className="bg-white p-4 border rounded"><h2 className="font-bold">Daily captured query cost</h2>{stats.daily_costs.map(day=><p key={day.date}>{day.date}: {day.cost===null?'unknown':`$${day.cost.toFixed(6)}`}</p>)}</section>
      <section className="overflow-auto"><h2 className="text-xl font-bold">Recent requests</h2><table className="w-full text-sm"><thead><tr>{['Time','Request','Model / tier','Policy','Outcome','Cost'].map(x=><th key={x} className="text-left p-2">{x}</th>)}</tr></thead>
      <tbody>{stats.recent_logs.map(r=><tr key={r.request_id} className="border-b"><td className="p-2">{new Date(r.timestamp).toLocaleString()}</td><td className="p-2">{r.request_id.slice(0,8)}</td><td className="p-2">{r.selected_model??'not selected'} / {r.selected_tier??'—'}</td><td className="p-2">{r.routing_policy_version}</td><td className="p-2">{r.failure_stage??(r.application_succeeded?'success':'failed')}</td><td className="p-2">{r.cost_usd===null?'unknown':`$${Number(r.cost_usd).toFixed(6)}`}</td></tr>)}</tbody></table></section>
      <p>Budget reset remains an authenticated API operation; it does not erase telemetry or provider charges.</p>
    </>}
  </div></main>;
}
export const getServerSideProps:GetServerSideProps=async({req,res})=>{protect(req,res,'admin',false);return{props:{}};};
