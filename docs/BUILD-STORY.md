# How rtech-whisper-hub was built

Sources for this page: the private development repository's history (99
commits, 56 non-merge commits up to the 2026-10-13 export), its issues and pull
requests, `docs/protocol.md` and the test suite. This public repository holds
the export only, so its own `git log` starts at that export.

## The problem and the first version (2026-09-29)

rTech Whisper is a self-hosted dictation setup: a fork of the OpenWhispr
desktop app plus a new native iPhone app. OpenWhispr's sync server is not
public, so the two clients had nothing to sync through. The hub was started on
2026-09-29 with one rule: speak the protocol the desktop app already uses,
and write down every place it has to differ.

The order of work on that first day:

1. The contract first: `docs/protocol.md`, mapped from the desktop app's
   sync code, and the voice relay contract (section 10).
2. A skeleton with a health route, per-device keys, request logging and a key
   CLI, then admin routes for keys so no one manages them by hand on the
   server.
3. The sync store and rules for five kinds (folders, notes, dictionary,
   snippets, transcriptions), then one route module per kind, mounted behind
   device auth with one error helper.
4. The voice relay: WAV helpers and the desktop's adaptive silence trim,
   chunking with overlap merge and repeated-sentence collapse, rate limits,
   in-flight caps and a shared GPU semaphore, then the transcription and
   synthesis routes.
5. A remote MCP server over Streamable HTTP, first with read tools, then
   search, create and update.
6. An LLM relay to the home inference host.

62 of the 99 commits landed on 2026-09-29 and 26 on 2026-09-30.

## Timeline

| Date | Phase |
|---|---|
| 2026-09-29 | Protocol, keys, sync for five kinds, voice relay, MCP, LLM relay |
| 2026-09-30 | Review follow-ups; stamp budget and cursor lookback; one cursor rule for all kinds |
| 2026-10-01 to 02 | Owner-isolation contract test; multi-owner hub |
| 2026-10-11 | OpenAI-shaped speech route, voices list and discovery document; synthesis parameters forwarded |
| 2026-10-13 | Public export |
| 2026-10-14 | Test suite pruned to functional table tests (after the export) |

## Key design decisions

- **Reimplement, do not invent.** The hub follows upstream's personal-scope
  sync model so the desktop client only changes its base URL. Section 9 of
  the protocol lists every divergence.
- **No lost rows under concurrency.** Review found that the hub stamps a row
  before its transaction commits, so a client cursor could move past a row
  that committed late and never pull it; for append-only transcriptions that
  loss was permanent. The fix (PR 94) routes every stamping write through one
  helper that aborts a transaction whose earliest stamp is too old, and adds
  a cursor lookback on the client side of the protocol.
- **One cursor rule.** Decision D12 replaced per-kind cursor rules with one:
  the client's clock at the start of the pass minus 60 s, truncated to the
  millisecond. A counted-pages rule and its proof were dropped as
  unnecessary.
- **One hub, owner-scoped.** On 2026-10-01 the choice between a hub per person
  and one hub with owner-scoped data went to one hub for a household-sized
  group. Migration 0002 added `owner_id` to keys and every synced table;
  every query and MCP tool filters by the key's owner, and another owner's id
  answers 404, the same as an unknown id.
- **Secrets never stored in plain text.** Device keys are stored only as a
  SHA-256 hash and a 12-character prefix; admin log lines never carry the
  token, the minted key or bodies.

## How AI agents built, reviewed and tested it

The hub was built by AI coding agents (Claude Code) under a controller session
that split the work into parallel lanes, each on its own branch and pull
request. Every PR went through a review loop before merge: slices of the diff
were reviewed by an adversarial Claude reviewer and by a reviewer from a
second model family, and the findings were fixed in follow-up PRs (18 commits
in the history are named "review findings for ..."). Review findings drove
the stamp budget, the cursor rule and a rewrite of how the LLM relay detects
a model id in a response body (decode the JSON and search string values,
rather than searching for escaped forms).

The suite uses Node's built-in test runner with PGlite (Postgres in process)
and fake upstreams, so it needs no database server or GPU. On this export
`npm run check` (typecheck plus tests) runs 275 tests, all passing, and CI
runs the same command on every push. An owner-isolation test was written
first as a pending acceptance test and then made to pass by the multi-owner
change.

## What did not work

- Stamping rows before commit could lose late-committing rows; fixed with the
  stamp budget and cursor lookback.
- Per-kind cursor rules, including a counted-pages rule with its own proof,
  were more than the problem needed and were replaced by one rule.
- Matching a model id against JSON-escaped text forms was fragile and was
  replaced by decoding the JSON and searching its strings.
- The `keys` npm script does not pass the `keys` group name to the CLI, so the
  working form is `node src/cli.ts keys ...` (the README uses that form).

## Current state

Version 0.1.0, experimental. It runs on the author's own desktop and iPhone.
Development continues in the private repository (for example, snippet kinds
in the sync protocol after the export).
