# Shared-mic huddle fixtures

Invented meetings, written for this repository. Every place and project name
is fictional, and speakers are single letters. `RIVERBEND01` is three voices
on one microphone covering two subjects in short turns, with a question one
voice asks and another answers. That is the shape of a huddle whose notes
turned into paragraphs, lost their topic headings and carried the wrong turn
on their speaker tags.

`notes-huddle-shape.test.ts` replays it with a scripted note-taker. Run it
against the real model with:

```
bun run notes:eval --corpus packages/server/test/fixtures/shared-mic-notes --judge off
```

`RIVERBEND01.ideas.json` is the idea list, written by hand.
