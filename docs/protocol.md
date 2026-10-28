# rTech Whisper hub protocol, v1

This is the contract the desktop and iPhone apps rely on. It is changed only by
a PR carrying the `contract` label. Changes are additive by default: new
fields are optional and new behavior goes on new endpoints; a breaking change
needs a new API version.

State: implemented by the hub in this repo (`src/`) and covered by its tests.

## Origin

The sync part is upstream OpenWhispr's protocol, for the personal-scope subset
only. The decision (2026-09-29) was to use the upstream subset, stay as close to
it as possible, and diverge only where the Swift client or the hub genuinely
needs to. Every divergence goes in section 9.

The sync endpoints were mapped from the desktop app's sync engine
(`src/services/SyncService.ts` and the services it calls) in
[github.com/rodaddy/openwhispr](https://github.com/rodaddy/openwhispr), branch
`rtech-whisper`.

Upstream's own server is not public. Where this doc states server behavior, it
is inferred from what the desktop client sends and how it reacts, so the hub
must satisfy that client.

Upstream's phone app (`openwhispr-mobile/` on upstream `main`) is a second
working client of the same protocol. Use it as a behavioral reference. Never
copy it in.

## 1. Transport and auth

- HTTPS, JSON bodies, UTF-8.
- Every call except `/healthz` needs `Authorization: Bearer <device key>`. The
  device key is minted per device by the hub.
- Each device key belongs to exactly one owner. The admin mint
  (`POST /admin/devices`) takes `{ name, owner? }`; a missing `owner` means
  the hub's `HUB_OWNER_ID`. The mint response and the device list carry
  `owner_id`.
- Every synced row (folders, notes, dictionary, snippets, transcriptions)
  belongs to the owner of the key that created it. Every list, delta, update,
  delete and MCP tool sees only the calling key's owner's rows.
- A row id of another owner is answered exactly like an unknown id (`404`
  `not_found`), never `403`.
- Clients may send `x-openwhispr-version` and `x-openwhispr-policy-version`
  (the desktop always does). The hub accepts and ignores both.
- `DELETE` requests carry a JSON body (`{ "id": ... }`), not a path id.
- Success is any 2xx with a JSON body. The spaces endpoint wraps its body as
  `{ data: ... }`. Every other endpoint returns the body bare.
- Errors:
  - `401` means the key is missing, unknown, or revoked.
  - `503` means the service is temporarily unavailable. Clients retry it.
    A sync write that ran past the stamp budget returns `503` with
    `code: stamp_budget_exceeded` and wrote nothing (section 8, Cursors).
  - Any other non-2xx returns `{ error: { message }, code, data }`. Clients
    branch on `code` and the HTTP status.
- Timestamps are ISO 8601 UTC with milliseconds and `Z`. Ids are server
  UUIDs. Every row also carries the client's own id (`client_*_id`), which is
  how devices match rows. `client_*_id` values, live folder names and live
  snippet triggers are unique per owner, not across the hub.
- The hub sets `updated_at` on every create, update, and delete. It never
  trusts a client's `updated_at` for ordering.

## 2. Spaces

| Method, path | Response |
| --- | --- |
| `GET /api/me/spaces` | `404` |

The `404` is deliberate. It keeps the desktop's sync engine in personal-only
mode, so it sends no `workspace_id`/`space_id` scope. v1 has one implicit
personal space (`space_id` null).

## 3. Folders

| Method, path | Request | Response |
| --- | --- | --- |
| `GET /api/folders/list?since` | `since` = delta cursor | `{ folders: Folder[] }`, unpaginated, tombstones included |
| `POST /api/folders/batch-create` | `{ folders: [{ name, client_folder_id, is_default, sort_order }] }` | `{ created: Folder[] }` in input order |
| `POST /api/folders/create` | same single object | `Folder` |
| `PATCH /api/folders/update` | `{ id, name, sort_order }` | `Folder` |
| `DELETE /api/folders/delete` | `{ id }` | `{}` |

`Folder` fields: `id, client_folder_id, name, is_default, sort_order,
workspace_id (null), space_id (null), deleted_at, created_at, updated_at`.

Folder names are unique per device key's owner among live folders:
- A clashing create or rename returns `409` with `code: folder_name_taken`.
- Exception: creating a default folder (`is_default`) whose name matches an
  existing default returns that existing row instead of `409`. The client then
  adopts its identity.

## 4. Notes

| Method, path | Request | Response |
| --- | --- | --- |
| `GET /api/notes/list` | snapshot: `limit, before, before_id`; delta: `limit, since, since_id` | `{ notes: Note[] }`, tombstones included |
| `POST /api/notes/batch-create` | `{ notes: NoteInput[] }` | `{ created: [{ client_note_id, id, updated_at }] }` |
| `POST /api/notes/create` | `NoteInput` | `Note` |
| `PATCH /api/notes/update` | `{ id, ...fields, base_updated_at? }` | `Note` |
| `DELETE /api/notes/delete` | `{ id }` | `{}` |

Note fields: `title, content, enhanced_content, enhancement_prompt,
enhanced_at_content_hash, note_type, source_file, audio_duration_seconds,
transcript, participants, calendar_event_id, diarization_enabled,
expected_speaker_count, folder_id`. `folder_id` is the folder's hub id.

`NoteInput` for a create adds `client_note_id` and `created_at`. It carries no
`updated_at` and no `base_updated_at`, because the hub stamps the row itself.

`Note` is the fields above plus `id, client_note_id, workspace_id (null),
space_id (null), user_id, updated_by_user_id, deleted_at, created_at,
updated_at`. `user_id` and `updated_by_user_id` are the owner of the key.

List ordering and paging:
- Snapshot pages run by `created_at` descending, tie-broken by `id`.
- Delta pages run by `updated_at` ascending, tie-broken by `id`.
- Clients page with 50 rows. A page shorter than the limit ends the pass.
- To resume inside a run of equal stamps, send the last row's stamp and id:
  `since` + `since_id`, or `before` + `before_id`. The hub returns rows
  strictly after (or before) that (stamp, id) pair, so paging through rows
  already committed skips and repeats none of them. `since_id` needs
  `since`, and `before_id` needs `before`; each must be a UUID, or the hub
  returns `400 invalid_request`. Snapshot and delta params cannot be mixed
  (`400 invalid_request`).
- `since` or `before` alone keeps its original meaning: strictly after (or
  before) the stamp.
- The hub takes a row's stamp before its transaction commits, so two
  concurrent writes can commit out of stamp order, and a delta page can
  move a client's cursor past a stamp whose row commits a moment later.
  Section 8 (Cursors) closes that gap between passes: the hub rolls back any
  write whose earliest stamp is 20 s or more old when it is about to COMMIT,
  which leaves COMMIT 10 s of a 30 s visibility bound; COMMIT time beyond
  that headroom comes out of the skew margin, and nothing bounds COMMIT
  itself. Clients store every delta cursor 60 s back, so the late row
  arrives in the next pass.

## 5. Dictionary

| Method, path | Request | Response |
| --- | --- | --- |
| `GET /api/dictionary/list?since&since_id&limit` | ascending by (`updated_at`, `id`) | `{ entries, hasMore }` |
| `POST /api/dictionary/batch-create` | `{ entries: [{ client_dict_id, word, source, created_at, updated_at }] }` | `{ created: DictionaryEntry[] }` |
| `PATCH /api/dictionary/update` | `{ id, word, source }` | `DictionaryEntry` |
| `DELETE /api/dictionary/delete` | `{ id }` | `{}` |

`source` is `manual` or `learned`.

`since_id` needs `since` and must be a UUID, or the hub returns
`400 invalid_request`.

## 6. Snippets

| Method, path | Request | Response |
| --- | --- | --- |
| `GET /api/snippets/list` | snapshot: `cursor, cursor_id, limit` (by `created_at`); delta: `since, since_id, limit` (by `updated_at`) | `{ entries, hasMore }` |
| `POST /api/snippets/batch-create` | `{ entries: [{ client_snippet_id, trigger, replacement, created_at, updated_at }] }` | `{ created: SnippetEntry[] }` |
| `PATCH /api/snippets/update` | `{ id, trigger, replacement }` | `SnippetEntry` |
| `DELETE /api/snippets/delete` | `{ id }` | `{}` |

A rename onto a trigger another live snippet already uses returns `409`.

`cursor_id` needs `cursor`, `since_id` needs `since`, and each must be a
UUID, or the hub returns `400 invalid_request`.

## 7. Transcriptions (dictation history)

| Method, path | Request | Response |
| --- | --- | --- |
| `GET /api/transcriptions/list` | snapshot: `limit, before, before_id`; delta: `limit, since, since_id` | `{ transcriptions: Transcription[] }`, tombstones included |
| `POST /api/transcriptions/batch-create` | `{ transcriptions: [{ client_transcription_id, text, raw_text, provider, model, audio_duration_ms, status, created_at }] }` | `{ created: Transcription[] }` |
| `POST /api/transcriptions/create` | one of the above | `Transcription` |
| `POST /api/transcriptions/batch-delete` | `{ ids }`, at most 500 | `{ deleted: string[] }` |
| `DELETE /api/transcriptions/delete` | `{ id }` | `{}` |

Transcriptions are append-only: there is no update. Clients page with 100
rows.

List ordering and paging are the same as notes (section 4, List ordering
and paging): the same order, the same (stamp, id) resume and UUID/400
rules, and the same stamp-before-commit rule (section 8, Cursors). Only the
page size differs.

`DELETE /api/transcriptions/delete` is `batch-delete` for one id: it
tombstones the row (section 8, Deletes). An unknown or already-deleted id
returns `404`.

## 8. Sync rules

### Conflicts

- **Notes use optimistic concurrency.** A PATCH carries `base_updated_at`, the
  hub revision the device last saw.
  - If the stored row's `updated_at` is later than `base_updated_at`, the hub
    returns `409` with `code: note_version_conflict` and the current row in
    `data.note`. The client keeps its edit and asks the user whether to Keep
    or Refresh.
  - A PATCH without `base_updated_at` is last-writer-wins.
- **Folders, dictionary, and snippets are last-writer-wins** on `updated_at`.
  A client never lets a pull overwrite a local row that still has unpushed
  changes.
- **Transcriptions** have no conflicts, because they have no updates.

### Deletes

- **Delete is soft on the hub.** `DELETE` (and transcription `batch-delete`)
  sets `deleted_at`, bumps `updated_at`, and keeps the row as a tombstone.
- **Tombstones travel.** Delta lists return tombstones like any other change,
  so every other device sees the delete.
- **Tombstones are kept indefinitely in v1.** A device that has been offline
  for any length of time must still receive the delete. Pruning needs a later
  contract change with a defined retention window.
- **A client that receives a tombstone** hard-deletes its local copy. It keeps
  no local tombstone after that.
- **Never-synced rows stay local.** A row with no hub id was never sent, so
  nothing on the hub references it. Deleting it locally needs no hub call, and
  purging it locally is always safe. The desktop 2.0.5 purge of tombstones
  with `cloud_id` NULL fits this rule.
- **Deletes are idempotent.** `DELETE` of an unknown or already-deleted id
  returns `404`, and clients treat that as done.
- **Tombstoned rows are frozen.** `PATCH` on a tombstoned row returns `404`.
  The client's next pull receives the tombstone and removes its local copy.
- **Deletes do not cascade to notes.** Deleting a folder does not delete its
  notes on the hub. Note rows keep their `folder_id`, and clients file notes
  whose folder is gone into the default folder.

### Cursors

Why: the hub takes a row's stamp (`updated_at`) before its transaction
commits. A delta pass can read the table after a row was stamped but before
it committed, so the pass does not see that row, and the cursor the client
stores can already be past the row's stamp. A delta pull with no `since_id`
is strict (`updated_at > since`), so without a lookback that row never
arrives. Transcriptions are append-only, so the loss would be permanent. The
rules below bound how old a row's stamp can be when its COMMIT is sent, leave
COMMIT time for headroom and the skew margin, and make every cursor reach back
further than that.

- **Lookback L = 60 s (clients).** Every delta cursor a client stores is
  taken minus L:
  - Every kind (notes, folders, transcriptions, dictionary, snippets):
    the next `since` is the client's own clock at the START of the pass,
    minus 60 s, truncated to the millisecond, with no `since_id`. The
    pass start does not move while the pass pages, so a long pass (cellular,
    a suspended app) cannot carry the cursor past a late-committing row.
  - A client upgrading from any pre-lookback stored cursor (client clock or
    largest hub `updated_at`, every kind) moves it back 60 s once.
  - A stored `since_id` is dropped when the lookback is applied: the
    lookback window replaces the (stamp, id) tie-break between passes.
    `since_id` still resumes a page inside one pass (section 4).
- **Stamp budget 20 s, visibility bound 30 s (hub).** Every hub write that
  stamps rows checks its age just before it sends COMMIT: a write whose
  earliest stamp is 20 s or more old rolls back, writes nothing, and returns
  `503` with `code: stamp_budget_exceeded`. The client retries it like any
  other `503`. The check cannot bound COMMIT itself (a WAL fsync stall,
  pool or network latency to Postgres), so it leaves COMMIT 10 s of
  headroom: a row is visible less than 30 s after its stamp whenever COMMIT
  takes under 10 s. A cursor 60 s back then reaches it with 30 s to spare
  for clock skew between client and hub. COMMIT time past the 10 s headroom
  comes out of that skew margin. The hub must keep accurate time (NTP), and
  clients must keep network time too: a client clock ahead of the hub's by
  30 s or more, less any COMMIT time past the headroom, can skip rows. A
  client clock behind the hub only re-pulls more rows.
- **Re-pull is idempotent (clients).** The lookback re-serves rows the
  client already holds, for up to 60 s after it applied them. The test is
  the hub stamp, not the local copy: a re-served row whose hub `updated_at`
  equals the one the client last applied for that id is a no-op, whatever
  the local copy holds now. No local write, no push-back, no duplicate row,
  no conflict, no "changed" event in the UI. A local edit made since that
  pull keeps its pending push and its `base_updated_at`, and is neither
  overwritten nor flagged. A re-served tombstone for a row already deleted
  locally is a no-op too.
- **`since` is truncated to the millisecond (clients).** A client clock
  finer than a millisecond is cut to whole milliseconds, never rounded up,
  so a `since` never lands after the clock reading it came from.

## 9. Divergences from upstream

| # | Where | What differs | Why |
| --- | --- | --- | --- |
| 1 | Voice relay (section 10) | Not an upstream OpenWhispr surface. Shaped on OpenAI's transcription API and the desktop's OmniVoice client | So the desktop only changes its base URL and key |
| 2 | LLM relay (section 11) | Not an upstream OpenWhispr surface. OpenAI chat-completions shape, passed through to llama-swap | One route for phone and Mac, reachable away from home |
| 3 | Cursors (section 8) | Clients store every delta cursor 60 s back and drop the stored `since_id`, each taken from the client's clock at the start of the pass; the hub rolls back a write still uncommitted 20 s after its first stamp (`503 stamp_budget_exceeded`), leaving COMMIT 10 s of a 30 s visibility bound. Wire shapes are unchanged | The hub stamps a row before it commits, so a strict `since` could skip a late-committing row for good |

## 10. Voice relay

The hub forwards speech-to-text and the server voice (named `skippy`) to a llama-swap host (VOICE_UPSTREAM_URL, default http://localhost:8080). Clients use one base URL, `<hub>/api/voice`. The shapes are OpenAI's (transcription) and the desktop's existing OmniVoice shape (synthesis), so a desktop client only changes its base URL and sends its device key.

Auth: `Authorization: Bearer <device key>`, the same as section 1. 401 on a missing, unknown or revoked key. The hub calls upstream with its own optional VOICE_UPSTREAM_API_KEY. A client key is never forwarded. The relay is open to every device key of every owner; it has no owner check.

### 10.1 POST /api/voice/v1/audio/transcriptions
Request: multipart/form-data
- file (required): WAV, PCM16, mono, 16000 Hz. Anything else -> 415.
- model (optional): omitted or `whisper-large-v3-turbo`. Anything else -> 400 model_not_allowed. The hub also accepts clients that send no model field at all.
- language (optional, ISO-639-1), prompt (optional, <= 1000 chars).
- response_format (optional): only `json`. Anything else -> 400.
- Unknown fields are ignored and not forwarded.
- Header `x-rtech-client-trimmed: 1` (optional): the client already ran the silence trim, so the hub skips it (see 10.4).

Response 200: `{ "text": string }`
- Headers: `x-rtech-audio-original-ms`, `x-rtech-audio-kept-ms`.
- No speech after the trim -> 200 `{ "text": "" }` and `x-rtech-no-speech: 1`. Upstream is not called.

Processing: trim, then split into chunks of at most 25 s with 1 s overlap, send the chunks upstream one at a time, merge the overlaps, and collapse repeated sentences (same as the desktop dictation pipeline).

### 10.2 POST /api/voice/upstream/omnivoice/synthesize
Request: application/json
`{ "text": string (1..2000 chars after trim), "audio_base64"?: string, "prompt_text"?: string }`
- Both audio_base64 and prompt_text present: passed through (desktop custom and grill voices).
- Both absent: the hub fills in the server voice profile (ref.wav, ref.txt). This is the iPhone path.
- Only one of the two present -> 400 invalid_request.

Optional render settings, each forwarded to the voice server when sent and left out when not:

| Field | Type | Limits |
| --- | --- | --- |
| `seed` | integer | 1 to 1000 |
| `num_steps` | integer | 10 to 20 |
| `guidance_scale` | number | greater than 0, at most 10 |
| `language` | string | 1 to 32 characters |

- These are the voice server's own limits. A value outside them, or of the wrong type, is a 400 invalid_request from the hub; the voice server is not called. An explicit `null` and a numeric string (`"7"`) are refused like any other wrong type; leave a field out to not send it.
- The fields are additive. A client that sends none of them gets the same behavior as before, and the request reaching the voice server is unchanged.

Response 200: `{ "audio_base64": string, "sample_rate": 24000 }`. The audio is a mono RIFF WAV at 24 kHz with at least one frame. The hub checks this. A malformed reply from upstream becomes 502.

### 10.3 Limits (per device key unless stated)
Every value below is a v1 starting value: v1 limits, tuned from real traffic.

| Limit | Value (v1 starting value) | On breach |
| --- | --- | --- |
| Transcription body | 25 MB (~13 min of 16 kHz PCM16), checked on Content-Length and while streaming (v1 start) | 413 payload_too_large |
| Synthesis body | 4 MB JSON (v1 start) | 413 payload_too_large |
| Transcription rate | token bucket, 120 req/min, burst 20 (v1 start) | 429 rate_limited + Retry-After |
| Synthesis rate | token bucket, 30 req/min, burst 5 (v1 start) | 429 rate_limited + Retry-After |
| In-flight per key | 2 transcription, 2 synthesis (v1 start) | 429 rate_limited + Retry-After: 1 |
| Global upstream concurrency (shared GPU) | 4, queue wait at most 10 s (v1 start) | 503 upstream_busy + Retry-After: 5 |
| Upstream timeout, per transcription chunk | 60 s (v1 start) | 504 upstream_timeout |
| Transcription request total | 180 s (v1 start) | 504 upstream_timeout |
| Upstream timeout, synthesis | 90 s, covers the OmniVoice cold load (v1 start) | 504 upstream_timeout |
| Request body read | 30 s (v1 start) | 408 request_timeout |

Limiter state is in memory. v1 runs a single replica.

### 10.4 Silence trimming
The hub always runs the desktop's adaptive trim before Whisper (30 ms frames, threshold = max(0.004, 2.5 x the 10th-percentile frame RMS), 300 ms pad, inner gaps over 1000 ms cut to 400 ms). The only exception is a request carrying `x-rtech-client-trimmed: 1`.

### 10.5 Errors
Section 1 envelope `{ error: { message }, code, data }`:
- 400 invalid_request | model_not_allowed | text_too_long
- 401 unauthorized
- 408 request_timeout
- 413 payload_too_large
- 415 unsupported_audio_format
- 429 rate_limited
- 502 upstream_error (data.upstream_status)
- 503 upstream_busy | upstream_unavailable
- 504 upstream_timeout

The hub never retries upstream calls. Clients retry 429 and 5xx with backoff.

### 10.6 Storage and logging
Audio and text exist only in memory for the length of the request. Nothing is written to disk, the database, or /tmp. Logs record device_id, route, status, bytes, original_ms, kept_ms, chunk count, upstream status and duration. They never record audio, transcript text, prompts, or synthesis text.

### 10.7 Desktop fallback
The desktop calls the hub first. It falls back to the inference host directly only on a network error, a timeout, or 502/503/504. It never falls back on 400, 401, 413, 415 or 429.

### 10.8 OpenAI-compatible speech
Three routes give the server voice the shape a stock OpenAI SDK expects: a client sets its base URL to `<hub>/api/voice/v1` and its API key to a device key. All three need the device key, as every `/api` route does (section 1).

#### POST /api/voice/v1/audio/speech
Request: application/json
`{ "voice": string, "input": string, "model"?: string, "response_format"?: "wav" | "pcm", "speed"?: number }`
- `voice` (required): `skippy`, in any letter case. It is the only voice, rendered from the server voice profile (the same one 10.2 fills in). Any other value -> 400 invalid_request.
- `input` (required): 1..2000 characters after trim. Empty -> 400 invalid_request. Longer -> 400 text_too_long.
- `response_format` (optional): `wav` (the default) or `pcm`. Anything else -> 400 invalid_request.
- `model` (optional): accepted and ignored. It must be a string when sent.
- `speed` (optional): accepted and ignored. It must be a number when sent. A value other than 1 adds the response header `x-speech-warning: speed is ignored`; the audio is the same.
- Unknown fields are ignored. The render settings of 10.2 (`seed`, `num_steps`, `guidance_scale`, `language`) are not part of this route: they are ignored like any other unknown field and never reach the voice server. `audio_base64` and `prompt_text` are ignored the same way, so this route cannot render a client's own voice.

Response 200: the audio bytes as the body, not JSON.

| `response_format` | Content-Type | Body |
| --- | --- | --- |
| `wav` | `audio/wav` | The voice server's WAV as the hub received it: mono RIFF WAV at 24 kHz with at least one frame, checked as in 10.2 |
| `pcm` | `audio/pcm` | That WAV's samples with no header: signed 16-bit little-endian, mono, 24000 Hz |

Limits: the route shares the synthesis limits of 10.3 with the 10.2 route: the 4 MB body, the 30 s body read, the 90 s upstream timeout, the global upstream concurrency, and one synthesis rate bucket and one in-flight count per device key. A request to either route spends from the same budget.

Errors: the statuses and codes of 10.5 that apply to synthesis.
- 400 invalid_request | text_too_long
- 401 unauthorized
- 408 request_timeout
- 413 payload_too_large
- 429 rate_limited (with Retry-After)
- 502 upstream_error (data.upstream_status)
- 503 upstream_busy (with Retry-After: 5) | upstream_unavailable
- 504 upstream_timeout

An upstream reply that is not a linear-PCM mono 24 kHz WAV is a 502 upstream_error with `data.upstream_status`, as in 10.2. A `pcm` request whose upstream WAV passes that check but is not 16-bit is a 502 upstream_error with no `data`. With no server voice profile configured the route answers 503 upstream_unavailable, as 10.2 does. An unknown voice is refused before the profile is looked at.

Every error this route writes itself carries the section 1 envelope plus two keys inside `error` that OpenAI SDKs read:
`{ "error": { "message": string, "type": string, "code": string }, "code": string, "data"?: object }`
- `error.type`: `server_error` for a 5xx status, `invalid_request_error` for every other status.
- `error.code`: the same value as the top-level `code`.

The 401 comes from the device-key check in front of every `/api` route, so it is the plain section 1 envelope without those two keys.

#### GET /api/voice/v1/audio/voices
Response 200, one of two answers:
- The server voice profile is configured: `{ "voices": [{ "id": "skippy", "name": "Skippy" }] }`
- It is not: `{ "voices": [] }`

#### GET /api/voice/.well-known/speech
Response 200, exactly:

```json
{
  "speech": "v1/audio/speech",
  "voices": "v1/audio/voices",
  "transcriptions": "v1/audio/transcriptions",
  "response_formats": ["wav", "pcm"],
  "sample_rate": 24000
}
```

The three URLs are relative to `<hub>/api/voice/`. `transcriptions` is the route of 10.1. `response_formats` and `sample_rate` describe the speech route.

## 11. LLM relay

The hub forwards OpenAI-style chat completions to llama-swap, so the iPhone and the desktop use one route for AI cleanup, titles, enhancement and chat, at home or away. Decided 2026-09-29. Clients use the base URL `<hub>/api/llm/v1` with any OpenAI-compatible client.

Auth: `Authorization: Bearer <device key>`, the same as section 1. 401 on a missing, unknown or revoked key. The hub calls upstream with its own optional key. A client key is never forwarded. The relay is open to every device key of every owner; it has no owner check.

Upstream (hub config):
- `LLM_UPSTREAM_URL`: llama-swap's root, the host that serves `/v1/*`. The hub calls `<root>/v1/chat/completions` and `<root>/v1/models`; a path on the URL is replaced, the same as the voice relay's transcription URL. Unset: the hub reuses `VOICE_UPSTREAM_URL` (default http://localhost:8080), which is the same llama-swap root.
- `LLM_UPSTREAM_API_KEY` (optional): sent upstream as `Authorization: Bearer`. Unset: when the URL fell back to `VOICE_UPSTREAM_URL`, the hub uses `VOICE_UPSTREAM_API_KEY`; a separate `LLM_UPSTREAM_URL` never inherits the voice key.
- `LLM_MODEL_ALLOWLIST` (optional): comma-separated model ids. Unset or empty allows every model.

### 11.1 POST /api/llm/v1/chat/completions
Request: application/json, an OpenAI chat-completions body. The hub checks only that it is a JSON object with a non-empty string `model` of at most 256 characters (UTF-16 code units) and an array `messages` (400 invalid_request otherwise), and that `model` is on the allowlist when one is set (400 model_not_allowed). The hub forwards the parsed body re-serialised, not the client's bytes: a body that repeats `model` reaches upstream with only the value the hub checked (JSON.parse keeps the last one). Every other field (temperature, max_tokens, tools, response_format, ...) still reaches upstream with the same values, and key order is kept (except that integer-like keys such as `"1"` move ahead of the others in an object), but the bytes are the hub's JSON serialisation, not the client's: whitespace is dropped; a number is re-spelled in its shortest form (`1.0` is sent as `1`, `1e2` as `100`, `-0` as `0`); an integer beyond 2^53 loses precision; a literal too large for a double (`1e999`) is sent as `null`. A duplicate key is sent once, with its last value.

Response, `stream` absent or false: 200 with upstream's JSON body unchanged. A 200 whose body is not a JSON object with a `choices` array becomes 502.

Response, `stream: true`: 200 `text/event-stream`. Upstream's SSE bytes are relayed chunk by chunk, in order and unchanged, ending with upstream's own `data: [DONE]`. The hub sets `cache-control: no-cache` and `x-accel-buffering: no`. If upstream answers a stream request with anything other than `text/event-stream`, the hub returns 502 before any byte is sent. Once the stream has started the status cannot change, so if upstream goes idle past the stream idle limit the hub sends one final event, `data: {"error":{"message":"LLM upstream stream went idle"},"code":"upstream_timeout"}`, and closes. A stream that closes without `[DONE]` was cut short.

### 11.2 GET /api/llm/v1/models
Upstream's `/v1/models` list, passed through. With an allowlist set, `data` holds only the allowed ids. A reply without a `data` array becomes 502.

### 11.3 Limits (per device key)
Every value below is a v1 starting value, tuned from real traffic.

| Limit | Value (v1 starting value) | On breach |
| --- | --- | --- |
| Request body | 1 MB, checked on Content-Length and while reading, after the rate and in-flight checks | 413 payload_too_large |
| Request body read | 30 s | 408 request_timeout |
| Rate | token bucket, 60 req/min, burst 10; chat and models share it; checked before the body is read, so a request refused later (bad body, 413, 408, or the client disconnecting mid-body) still spends its token | 429 rate_limited + Retry-After |
| In flight | 2 chat requests; the slot is taken before the body is read, so a pending body read holds it (up to the 30 s read limit: two stalled uploads refuse a third request for up to 30 s); a stream holds its slot until it ends or the client disconnects | 429 rate_limited + Retry-After: 1 |
| Upstream timeout, non-stream | 90 s for the whole call, under the 100 s origin timeout common on reverse proxies | 504 upstream_timeout |
| Upstream timeout, stream | 90 s to response headers, then 60 s idle between chunks | 504 before the stream starts; the final SSE error event after |
| Upstream timeout, models | 15 s | 504 upstream_timeout |

The LLM relay does not take a slot of the voice relay's global GPU semaphore (10.3); llama-swap queues model swaps itself. Limiter state is in memory. v1 runs a single replica.

### 11.4 Errors
Section 1 envelope `{ error: { message }, code, data }`:
- 400 invalid_request | model_not_allowed | upstream_rejected (upstream answered a chat 400 or 422, or a chat 404 whose body names the requested model as a whole token within its first 64 KiB: a bad body, an unknown model, a context overflow; data.upstream_status; do not retry). A body that parses as JSON is decoded and its string values and object keys are searched (down to 32 levels of nesting, at most 10,000 strings), so JSON escapes such as `\/`, `\n` or `\u00e9` are read as the characters they stand for; any other body, or one cut at 64 KiB, is searched as text. The id counts as a whole token when the character before it is not a letter, digit or one of `_ . - @ +` (a `:`, a `/`, a space or a quote is fine), and when it is not followed by a letter, digit or one of `_ / @ + -`, alone or after a run of `.` or `:` (so `qwen3-8b.` and `qwen3-8b...` count, `qwen3` in `qwen3.5` or `qwen3-8b` does not). In a body cut at 64 KiB, a match that runs into the cut, directly or through a run of `.` or `:`, does not count. At most 64 occurrences of the id are examined.
- 401 unauthorized
- 408 request_timeout
- 413 payload_too_large: the body is over the hub cap, or upstream answered 413 on chat (data.upstream_status)
- 429 rate_limited + Retry-After: a hub limit, or upstream answered 429 on chat or models (data.upstream_status). Retry-After is always whole seconds from 1 to 3600: upstream's value when it is a non-negative integer (0 becomes 1, anything over 3600 becomes 3600), an HTTP date (IMF-fixdate) turned into seconds from now and held the same way, otherwise 1
- 502 upstream_error: upstream answered another non-2xx, including a chat 404 that does not name the model (the upstream URL is wrong), and every models non-2xx except 429, 413 included since a GET sends no body (data.upstream_status), or its output was malformed
- 503 upstream_unavailable: the relay is not configured, or upstream is unreachable
- 504 upstream_timeout

The hub never retries upstream calls. Clients retry 429 and 5xx with backoff.

### 11.5 Logging
Prompts, messages and completions exist only in memory for the length of the request and are never logged. Logs record device_id, route, model, stream, status, code, bytes in and out, upstream status and duration.

## 12. Not in v1

- Upstream endpoints that are safe to leave unimplemented: the sync engine
  catches their errors and continues the pass.
  - `/api/conversations/*` (agent chat)
  - `/api/analytics/events/*` (Insights)
- Upstream account, team, and sharing surfaces that the desktop removed. The
  hub never serves these:
  - `/api/workspaces/*`, `/api/teams/*`, `/api/spaces/:id/*`
  - `/api/invitations/*`, `/api/me/joinable*`
  - `/api/notes/:id/share`, `/api/notes/:id/access`
  - `/api/v1/keys/*`, `/api/auth/*`
  - `/api/notes/search`, `/api/notes/delete-all`
- The MCP endpoint (`src/mcp.ts`) is not specified in this document.
