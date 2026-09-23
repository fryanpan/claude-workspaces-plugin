/**
 * A dictation with a shape, and what its notes owe that shape.
 *
 * WHY IT IS INVENTED, when `notes-eval.ts` refuses invented speech. That
 * refusal is about RATES: a transcript written to be summarised flatters a
 * note-taker's completeness. This fixture measures something a rate cannot:
 * whether a layout the speaker dictated ("page one… start with… then… the
 * last thing") survives as that layout, and whether a claim spoken with a
 * "because" keeps its reason beside it. Both need speech whose shape is known
 * in advance, which only a written transcript gives.
 *
 * One voice, as a dictation has. Place names are the house fixture names.
 * Every line is invented; the repo is public.
 */

/** One tick of speech, as the pause or the cadence clock would cut it. */
export interface DictationTick {
  turns: Array<{ speaker: string; text: string }>;
}

/** A page the speaker laid out, and the items they put on it, in order. */
export interface DictatedPage {
  /** Words the heading must carry: the speaker's own name for the page. */
  heading: readonly string[];
  /** Each item's identifying words, in the order the speaker gave them. */
  items: ReadonlyArray<readonly string[]>;
}

/** A claim the speaker gave a reason for. */
export interface BecauseIdea {
  claim: readonly string[];
  reason: readonly string[];
}

const A = (text: string): { speaker: string; text: string } => ({ speaker: 'A', text });

export const DICTATION_TICKS: readonly DictationTick[] = [
  { turns: [A('Okay, this is the Harborlight council update. It has two pages.')] },
  { turns: [A('Page one is the Riverbend street repairs.')] },
  { turns: [A('Start with the list of streets we repave this summer.')] },
  {
    turns: [
      A(
        'Put the pothole count at the top of that list, because the pothole count is what the city reports monitor.',
      ),
    ],
  },
  { turns: [A('Then the cost per block for each street.')] },
  {
    turns: [
      A(
        'We repave the high street before the harbour road, because the number nine bus runs there.',
      ),
    ],
  },
  { turns: [A('The last thing on page one is the crew schedule for June and July.')] },
  { turns: [A('Page two is the Saltmarsh flooding.')] },
  { turns: [A('Start with the map of the three drains that overflow.')] },
  {
    turns: [
      A('The problem is those drains overflow at every spring tide, and the car park floods.'),
    ],
  },
  { turns: [A('Then the complaints from the harbour office, just the totals by month.')] },
  { turns: [A('Keep the costs in one table, because the council only reads the totals.')] },
  {
    turns: [
      A(
        'The last thing on page two is the ask. We ask the council for forty thousand for new drain gates.',
      ),
    ],
  },
  {
    turns: [
      A(
        'One question I still have. Who can reach the pumping station when the Saltmarsh gate is locked at night?',
      ),
    ],
  },
  { turns: [A('And ask Alice to send the drain survey to Bob by Friday.')] },
  { turns: [A("Okay, that's it for the update.")] },
];

/** The two pages, in the speaker's words and order. */
export const DICTATED_PAGES: readonly DictatedPage[] = [
  {
    heading: ['riverbend', 'street', 'repairs'],
    items: [
      ['list', 'streets', 'repave'],
      ['cost', 'block'],
      ['crew', 'schedule'],
    ],
  },
  {
    heading: ['saltmarsh', 'flooding'],
    items: [
      ['map', 'drains'],
      ['complaints', 'harbour', 'office'],
      ['council', 'drain', 'gates'],
    ],
  },
];

/** Every claim the dictation gave a reason for. */
export const BECAUSE_IDEAS: readonly BecauseIdea[] = [
  { claim: ['pothole', 'count', 'top'], reason: ['city', 'reports', 'monitor'] },
  { claim: ['high', 'harbour', 'road'], reason: ['bus'] },
  { claim: ['costs', 'table'], reason: ['council', 'totals'] },
];
