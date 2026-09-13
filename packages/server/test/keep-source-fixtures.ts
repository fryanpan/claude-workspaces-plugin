/**
 * Hand-formatted files for the write-back tests: shapes the serializer would
 * write differently (soft wraps, `*` bullets, four-space indents, `.mdx`
 * imports and JSX), so a test that asserts the whole file sees any byte the
 * write-back normalized.
 */
export const MDX = `---
title: Reading the tide at Saltmarsh
---

import { Callout } from '../components/Callout'
import Chart from './chart.js'
export const meta = { author: 'Harborlight Press' }

# Reading the tide at Saltmarsh

The harbor opens at dawn and closes at dusk.

Boats with a <Badge tone="info">new</Badge> permit launch first,
and the rest follow on the next slack water.

<Callout type="warning">
  Watch the tide tables before you launch.
</Callout>

- Two-space list
  - nested two
    - deeper two
- sibling two

* Four-space list
    * nested four
        * deeper four

1. Ordered item
   - nested under an ordered item
2. Second ordered item

<Chart data={meta.series} />
`;

export const MD = `# Riverbend field notes

The ferry runs hourly.

A soft-wrapped paragraph that the author
broke across three lines on purpose
to keep diffs small.

- Two-space list
  - nested two
    - deeper two

* Four-space list
    * nested four
        * deeper four

1. Ordered item
   - nested under an ordered item
2. Second ordered item
`;
