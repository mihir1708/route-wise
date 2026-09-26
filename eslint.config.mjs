import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  {
    files: ['pages/index.tsx', 'pages/admin.tsx'],
    // Preserve existing full-page navigation in this characterization ticket.
    // Keep the two existing findings visible without refactoring application code.
    rules: { '@next/next/no-html-link-for-pages': 'warn' },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts']),
]);
