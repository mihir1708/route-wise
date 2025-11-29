// Main page - chat interface for testing the router

import { useState } from 'react';
import Head from 'next/head';
import { RouteQueryResponse } from '@/types';

export default function Home() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<RouteQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalCost, setTotalCost] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!query.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch('/api/route-query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }

      setResponse(data);
      setTotalCost(prev => prev + data.metadata.cost);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const getModelColor = (model: string) => {
    if (model === 'gpt-4') return 'text-purple-600 bg-purple-100';
    return 'text-green-600 bg-green-100';
  };

  const getDifficultyColor = (score: number) => {
    if (score >= 0.8) return 'text-red-600';
    if (score >= 0.5) return 'text-yellow-600';
    return 'text-green-600';
  };

  return (
    <>
      <Head>
        <title>RouteWise - AI Model Router</title>
        <meta name="description" content="Intelligent AI model routing with budget management" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="text-center mb-12">
            <h1 className="text-5xl font-bold text-gray-900 mb-4">
              RouteWise 🎯
            </h1>
            <p className="text-xl text-gray-600">
              Intelligent AI Model Router with Budget Management
            </p>
            <div className="mt-4">
              <a
                href="/admin"
                className="text-indigo-600 hover:text-indigo-800 font-medium"
              >
                View Admin Dashboard →
              </a>
            </div>
          </div>

          {/* Query Input */}
          <div className="bg-white rounded-2xl shadow-xl p-8 mb-8">
            <form onSubmit={handleSubmit}>
              <label htmlFor="query" className="block text-lg font-semibold text-gray-700 mb-3">
                Enter your question:
              </label>
              <textarea
                id="query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g., What is quantum computing?"
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors resize-none"
                rows={4}
                disabled={loading}
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="mt-4 w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Processing...' : 'Submit Query'}
              </button>
            </form>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-50 border-2 border-red-200 rounded-lg p-6 mb-8">
              <h3 className="text-red-800 font-semibold text-lg mb-2">Error</h3>
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {/* Response Display */}
          {response && (
            <div className="bg-white rounded-2xl shadow-xl p-8 mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Response</h2>
              
              {/* AI Answer */}
              <div className="bg-gray-50 rounded-lg p-6 mb-6">
                <p className="text-gray-800 leading-relaxed whitespace-pre-wrap">
                  {response.answer}
                </p>
              </div>

              {/* Metadata */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-blue-50 rounded-lg p-4">
                  <div className="text-sm text-gray-600 mb-1">Model Used</div>
                  <div className={`inline-block px-3 py-1 rounded-full font-semibold ${getModelColor(response.metadata.model_used)}`}>
                    {response.metadata.model_used}
                  </div>
                </div>

                <div className="bg-blue-50 rounded-lg p-4">
                  <div className="text-sm text-gray-600 mb-1">Difficulty Score</div>
                  <div className={`text-2xl font-bold ${getDifficultyColor(response.metadata.difficulty_score)}`}>
                    {response.metadata.difficulty_score.toFixed(2)}
                  </div>
                </div>

                <div className="bg-blue-50 rounded-lg p-4">
                  <div className="text-sm text-gray-600 mb-1">Tokens Used</div>
                  <div className="text-2xl font-bold text-gray-800">
                    {response.metadata.tokens_used}
                  </div>
                </div>

                <div className="bg-blue-50 rounded-lg p-4">
                  <div className="text-sm text-gray-600 mb-1">Request Cost</div>
                  <div className="text-2xl font-bold text-gray-800">
                    ${response.metadata.cost.toFixed(6)}
                  </div>
                </div>
              </div>

              {/* Budget Info */}
              <div className="mt-6 bg-gradient-to-r from-green-50 to-blue-50 rounded-lg p-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-600">Budget Remaining</span>
                  <span className="text-lg font-bold text-gray-900">
                    ${response.metadata.remaining_budget.toFixed(2)}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-green-500 h-full transition-all duration-300"
                    style={{
                      width: `${(response.metadata.remaining_budget / 100) * 100}%`
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Running Total */}
          {totalCost > 0 && (
            <div className="bg-white rounded-2xl shadow-xl p-6 text-center">
              <div className="text-sm text-gray-600 mb-2">Session Total Cost</div>
              <div className="text-3xl font-bold text-indigo-600">
                ${totalCost.toFixed(6)}
              </div>
            </div>
          )}

          {/* Example Queries */}
          <div className="mt-12 bg-white rounded-2xl shadow-xl p-8">
            <h3 className="text-xl font-bold text-gray-900 mb-4">Try These Examples:</h3>
            <div className="space-y-3">
              <button
                onClick={() => setQuery("What is 2+2?")}
                className="block w-full text-left px-4 py-3 bg-green-50 hover:bg-green-100 rounded-lg transition-colors"
              >
                <span className="text-green-600 font-medium">Easy:</span> What is 2+2?
              </button>
              <button
                onClick={() => setQuery("How does photosynthesis work?")}
                className="block w-full text-left px-4 py-3 bg-yellow-50 hover:bg-yellow-100 rounded-lg transition-colors"
              >
                <span className="text-yellow-600 font-medium">Medium:</span> How does photosynthesis work?
              </button>
              <button
                onClick={() => setQuery("Explain quantum entanglement and its implications for computing in detail")}
                className="block w-full text-left px-4 py-3 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors"
              >
                <span className="text-purple-600 font-medium">Hard:</span> Explain quantum entanglement and its implications for computing
              </button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
