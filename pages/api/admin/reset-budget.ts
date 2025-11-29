// Reset budget (for testing or new month)

import type { NextApiRequest, NextApiResponse } from 'next';
import { resetBudget } from '@/lib/budget-tracker';
import { logger } from '@/utils/logger';
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ message: string; month: string } | { error: string }>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { month } = req.body;

    await resetBudget(month);

    const targetMonth = month || new Date().toISOString().slice(0, 7);

    logger.info(`Budget reset successfully for month: ${targetMonth}`);

    return res.status(200).json({
      message: 'Budget reset successfully',
      month: targetMonth
    });

  } catch (error: any) {
    logger.error('Error resetting budget', error);
    return res.status(500).json({
      error: error.message || 'Failed to reset budget'
    });
  }
}
