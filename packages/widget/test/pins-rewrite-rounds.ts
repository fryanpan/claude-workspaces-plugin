/**
 * The commented elements of the rewritten mock in `pins-rewrite-driver.ts`,
 * and what each says in each round. A module of its own so the test can read
 * them without loading the driver, which launches a browser when imported.
 *
 * Each round keeps over half of the previous round's words, and by the third
 * none keeps over half of the first round's: matched against the words its
 * comment was made on, every element is lost by then.
 */

export const THREADS = ['t-heading', 't-para', 't-cell'] as const;

/** What each commented element says in each round. */
export const ROUNDS = [
  {
    't-heading': 'Riverbend high water by month',
    't-para': 'The June peak is the highest since the gauge opened.',
    't-cell': '4.1 m at noon',
  },
  {
    't-heading': 'Riverbend high water by calendar month',
    't-para': 'The June peak is the highest since the gauge first opened.',
    't-cell': '4.1 m at midday',
  },
  {
    't-heading': 'Riverbend peak water by calendar month 2026',
    't-para': 'The June peak was the highest since the gauge first opened.',
    't-cell': '4.2 m at midday',
  },
  {
    't-heading': 'Riverbend peak levels by calendar month 2026',
    't-para': 'The July peak was the highest since our gauges first opened.',
    't-cell': '4.2 m by midday',
  },
] as const;
