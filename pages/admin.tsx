// Admin dashboard - shows usage stats and analytics

import { useEffect, useState } from 'react';
import Head from 'next/head';
import { UsageStats } from '@/types';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line, Pie, Bar } from 'react-chartjs-2';

// Setup Chart.js
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

export default function Admin() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/stats');
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch stats');
      }
      
      setStats(data);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleResetBudget = async () => {
    if (!confirm('Are you sure you want to reset the budget? This will clear all usage data for the current month.')) {
      return;
    }

    setResetting(true);
    try {
      const res = await fetch('/api/admin/reset-budget', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset budget');
      }

      alert('Budget reset successfully!');
      fetchStats(); // Refresh stats
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  useEffect(() => {
    fetchStats();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  // Prepare chart data
  const modelDistributionData = stats ? {
    labels: Object.keys(stats.model_distribution),
    datasets: [{
      label: 'Requests per Model',
      data: Object.values(stats.model_distribution),
      backgroundColor: [
        'rgba(34, 197, 94, 0.8)',  // green for cheap
        'rgba(168, 85, 247, 0.8)', // purple for expensive
      ],
      borderColor: [
        'rgba(34, 197, 94, 1)',
        'rgba(168, 85, 247, 1)',
      ],
      borderWidth: 2,
    }],
  } : null;

  const dailyCostsData = stats ? {
    labels: stats.daily_costs.map(d => d.date),
    datasets: [{
      label: 'Daily Cost (USD)',
      data: stats.daily_costs.map(d => d.cost),
      borderColor: 'rgb(99, 102, 241)',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      tension: 0.4,
      fill: true,
    }],
  } : null;

  const budgetPercentage = stats ? ((stats.total_cost / (stats.total_cost + stats.budget_remaining)) * 100) : 0;

  return (
    <>
      <Head>
        <title>Admin Dashboard - RouteWise</title>
        <meta name="description" content="Admin dashboard for RouteWise" />
      </Head>

      <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-12 px-4">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex justify-between items-center mb-12">
            <div>
              <h1 className="text-4xl font-bold text-gray-900 mb-2">
                Admin Dashboard
              </h1>
              <p className="text-gray-600">
                Monitor usage, costs, and model distribution
              </p>
            </div>
            <a
              href="/"
              className="bg-indigo-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              ← Back to Demo
            </a>
          </div>

          {loading && !stats && (
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
              <p className="mt-4 text-gray-600">Loading statistics...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border-2 border-red-200 rounded-lg p-6 mb-8">
              <h3 className="text-red-800 font-semibold text-lg mb-2">Error</h3>
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {stats && (
            <>
              {/* Overview Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div className="bg-white rounded-xl shadow-lg p-6">
                  <div className="text-sm text-gray-600 mb-2">Total Requests</div>
                  <div className="text-3xl font-bold text-gray-900">{stats.total_requests}</div>
                </div>

                <div className="bg-white rounded-xl shadow-lg p-6">
                  <div className="text-sm text-gray-600 mb-2">Total Cost</div>
                  <div className="text-3xl font-bold text-indigo-600">${stats.total_cost.toFixed(2)}</div>
                </div>

                <div className="bg-white rounded-xl shadow-lg p-6">
                  <div className="text-sm text-gray-600 mb-2">Budget Remaining</div>
                  <div className="text-3xl font-bold text-green-600">${stats.budget_remaining.toFixed(2)}</div>
                </div>

                <div className="bg-white rounded-xl shadow-lg p-6">
                  <div className="text-sm text-gray-600 mb-2">Budget Used</div>
                  <div className="text-3xl font-bold text-orange-600">{budgetPercentage.toFixed(1)}%</div>
                  <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                    <div
                      className={`h-full rounded-full transition-all ${
                        budgetPercentage >= 90 ? 'bg-red-500' :
                        budgetPercentage >= 80 ? 'bg-yellow-500' :
                        'bg-green-500'
                      }`}
                      style={{ width: `${Math.min(budgetPercentage, 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Charts */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                {/* Model Distribution Pie Chart */}
                <div className="bg-white rounded-xl shadow-lg p-6">
                  <h2 className="text-xl font-bold text-gray-900 mb-4">Model Distribution</h2>
                  {modelDistributionData && (
                    <div className="h-80 flex items-center justify-center">
                      <Pie
                        data={modelDistributionData}
                        options={{
                          responsive: true,
                          maintainAspectRatio: true,
                          plugins: {
                            legend: {
                              position: 'bottom',
                            },
                          },
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Daily Costs Line Chart */}
                <div className="bg-white rounded-xl shadow-lg p-6">
                  <h2 className="text-xl font-bold text-gray-900 mb-4">Cost Trend (Last 30 Days)</h2>
                  {dailyCostsData && dailyCostsData.labels.length > 0 ? (
                    <div className="h-80">
                      <Line
                        data={dailyCostsData}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: {
                            legend: {
                              display: false,
                            },
                          },
                          scales: {
                            y: {
                              beginAtZero: true,
                              ticks: {
                                callback: (value) => `$${value}`,
                              },
                            },
                          },
                        }}
                      />
                    </div>
                  ) : (
                    <div className="h-80 flex items-center justify-center text-gray-500">
                      No data available yet
                    </div>
                  )}
                </div>
              </div>

              {/* Recent Logs Table */}
              <div className="bg-white rounded-xl shadow-lg p-6 mb-8">
                <h2 className="text-xl font-bold text-gray-900 mb-4">Recent Queries</h2>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b-2 border-gray-200">
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Timestamp</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Query</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Model</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Difficulty</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Tokens</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Cost</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recent_logs.map((log: any) => (
                        <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="py-3 px-4 text-sm text-gray-600">
                            {new Date(log.timestamp).toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-800 max-w-xs truncate">
                            {log.query_text}
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                              log.chosen_model === 'gpt-4'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-green-100 text-green-700'
                            }`}>
                              {log.chosen_model}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-800">
                            {parseFloat(log.estimated_difficulty).toFixed(2)}
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-800">
                            {log.prompt_tokens + log.completion_tokens}
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-800">
                            ${parseFloat(log.cost_usd).toFixed(6)}
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-600">
                            {log.response_time_ms}ms
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Admin Actions */}
              <div className="bg-white rounded-xl shadow-lg p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-4">Admin Actions</h2>
                <div className="flex gap-4">
                  <button
                    onClick={fetchStats}
                    disabled={loading}
                    className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:bg-gray-400 transition-colors"
                  >
                    {loading ? 'Refreshing...' : 'Refresh Data'}
                  </button>
                  <button
                    onClick={handleResetBudget}
                    disabled={resetting}
                    className="px-6 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:bg-gray-400 transition-colors"
                  >
                    {resetting ? 'Resetting...' : 'Reset Budget'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
