// The public demo: one gateway task at a time as the demo tenant, with sample support tickets.
import type { TaskType } from '@/prompts';

/** Shorter than the gateway's own limit, so one visitor request stays cheap. */
export const DEMO_MAX_INPUT_CHARS = 4000;

export const DEMO_TASKS: { task: TaskType; label: string; sample: string }[] = [
  { task: 'classify', label: 'Classify', sample:
    'Our card reader stopped connecting over Bluetooth this morning and we cannot take payments at the counter. '
    + 'We restarted it twice. Please help as soon as possible.' },
  { task: 'extract', label: 'Extract', sample:
    'Hi, this is about order A-55821. The Pro plan annual upgrade was charged twice on my card. '
    + 'Please refund the duplicate charge. Thanks, Dana (dana.r@example.com)' },
  { task: 'summarize', label: 'Summarize', sample:
    'Customer (Mon): Exports to CSV time out for reports over 50k rows.\n'
    + 'Agent (Mon): Asked for the report ID and browser. Suggested filtering by date.\n'
    + 'Customer (Tue): Report 8812, Chrome 128. Filtering works but we need the full export for an audit on Friday.\n'
    + 'Agent (Wed): Engineering confirmed a known limit and is testing a background export. No date yet.' },
  { task: 'draft_reply', label: 'Draft reply', sample:
    'I cancelled my free trial yesterday but I was still charged $49 this morning. Can you refund it?\n'
    + 'Knowledge base: trials cancelled before the renewal time are not charged; charges made in error are refunded in 5-10 business days.' },
  { task: 'troubleshoot', label: 'Troubleshoot', sample:
    'Since we rotated our API keys yesterday, our webhook endpoint has stopped receiving payment.succeeded events. '
    + 'The dashboard shows every delivery failing with HTTP 401. Our server code did not change.' },
  { task: 'chat', label: 'Chat', sample: 'What is the difference between a refund and a chargeback?' },
];
