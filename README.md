# rtech-whisper-hub

A small self-hosted server for a dictation app. The desktop app (rtech-whisper,
a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr)) and a native
iPhone app both talk to it. It does four jobs:

- issues per-device API keys
- relays speech-to-text, voice synthesis, and OpenAI-style chat completions to
  an inference host you run (llama-swap or anything OpenAI-compatible)
- syncs notes, folders, dictionary words, snippets, and transcriptions between
  devices, using the sync protocol of upstream OpenWhispr's personal scope
- serves a remote MCP endpoint so agents (Claude Code, Codex) can read and
  write notes

TypeScript on Node 24 (native type stripping, no build step), Hono, Drizzle,
Postgres.

## Why it exists

OpenWhispr's own sync server is not public. This hub reimplements the subset
the clients need, so one person's devices can share notes and reach a home
inference box through one authenticated URL, at home or away. The wire
contract is `docs/protocol.md`; every place it differs from upstream is listed
in its divergence table.

## Status

This runs in production for one person's devices (a desktop and an iPhone)
behind a reverse proxy with SSO in front of `/admin`. It has not been run by
anyone else. There is no multi-tenant hardening beyond per-owner row
isolation, no web UI, and no account system: an admin mints keys.

## Layout

| Path | What it holds |
| --- | --- |
| `docs/protocol.md` | The contract the apps rely on. |
| `src/` | The service. `drizzle/` holds its forward-only migrations. |
| `test/` | Node test runner suites; Postgres is PGlite, in process. |
| `Dockerfile`, `docker-compose.example.yml`, `env.example` | A generic way to run it. |

## Run it

```sh
cp env.example .env               # fill in POSTGRES_PASSWORD and HUB_ADMIN_TOKEN
cp docker-compose.example.yml docker-compose.yml
docker compose up --build
curl http://localhost:8096/healthz
```

Or without containers, against a Postgres you already have:

```sh
npm ci
DATABASE_URL=postgres://... HUB_ADMIN_TOKEN=$(openssl rand -hex 32) npm start
```

Migrations in `drizzle/` run on startup and are forward-only.

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `HUB_PORT` | no | `8096` | HTTP listen port (1-65535) |
| `DATABASE_URL` | yes | - | Postgres URL (`postgres://` or `postgresql://`) |
| `HUB_ADMIN_TOKEN` | yes | - | Bearer token for the `/admin` routes, at least 32 chars |
| `HUB_OWNER_ID` | no | `rico` | Owner a new device key gets when the mint names none |
| `LOG_LEVEL` | no | `info` | pino log level |
| `VOICE_UPSTREAM_URL` | no | `http://localhost:8080` | Inference host root for speech-to-text and synthesis |
| `VOICE_UPSTREAM_API_KEY` | no | - | Sent upstream as a bearer token |
| `VOICE_STT_MODEL` | no | `whisper-large-v3-turbo` | Speech-to-text model id |
| `VOICE_PROFILE_DIR` | no | - | Directory with `ref.wav` and `ref.txt`, the server voice |
| `LLM_UPSTREAM_URL` | no | `VOICE_UPSTREAM_URL` | Root for the LLM relay |
| `LLM_UPSTREAM_API_KEY` | no | - | Bearer for the LLM relay upstream |
| `LLM_MODEL_ALLOWLIST` | no | all | Comma-separated model ids the relay accepts |

The server voice has the id `skippy` (the name of the author's assistant
persona). No voice clip ships in this repo: bring your own reference recording
and its transcript. Without one, synthesis requests that carry no voice of
their own get a 503.

## Routes

| Route                                       | Auth                                      | Response                                                                                                 |
| ------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                              | none                                      | `200 {"ok":true}` or `503 {"ok":false}`                                                                  |
| `GET /api/whoami`                           | `Authorization: Bearer <device key>`      | `200 {"device":{"id","name"}}` or `401`                                                                  |
| `POST /admin/devices`                       | `Authorization: Bearer <HUB_ADMIN_TOKEN>` | body `{"name":"..."}` (1-100 chars) -> `201 {"device":{"id","name","prefix"},"key":"rtw_..."}`, or `400` |
| `GET /admin/devices`                        | `Authorization: Bearer <HUB_ADMIN_TOKEN>` | `200 {"devices":[{"id","name","prefix","created_at","last_used_at","revoked_at"}]}`                      |
| `POST /admin/devices/<id-or-prefix>/revoke` | `Authorization: Bearer <HUB_ADMIN_TOKEN>` | `200 {"revoked":true}`, or `404` when no active device matched                                           |

Errors are `{"error":{"message":...},"code":...}` with code `unauthorized`
(401), `invalid_request` (400), or `not_found` (404). A device key never
passes admin auth, and the admin token never passes `/api` auth. Admin request
log lines carry `"admin":true` and never the token, the minted key, or bodies.

## Device keys
Keys are `rtw_` plus 43 base64url characters. Only a SHA-256 hash and the
12-character prefix are stored; the plaintext key appears once, in the mint
response.

Manage keys with the CLI, which calls the admin routes:

```sh
export HUB_URL=https://hub.example.internal   # default http://localhost:8096
export HUB_ADMIN_TOKEN=...
npm run keys -- mint --name "My iPhone"
npm run keys -- list
npm run keys -- revoke <id-or-prefix>
```

A non-2xx response prints the status and error message to stderr and exits 1;
wrong usage or a missing `HUB_ADMIN_TOKEN` exits 2. Put `/admin/*` behind your
own SSO or keep it off the public route.

## MCP

`POST /mcp` serves the desktop `rtw` tools over Streamable HTTP (stateless,
JSON responses), behind the same device-key auth as `/api`. Tools:
`notes_list`, `notes_search`, `note_get`, `note_create`, `note_update`,
`folders_list`, `transcriptions_list`. There is no delete tool. `note_update`
takes an optional `base_updated_at`; if the note changed since, the result is
an error `CONFLICT: ...` carrying the current `updated_at`.

Mint one device key per agent host, then:

```sh
claude mcp add --transport http rtech-whisper-hub \
  https://hub.example.internal/mcp \
  --header "Authorization: Bearer <device key>"

export RTW_HUB_KEY=<device key>
codex mcp add rtech-whisper-hub \
  --url https://hub.example.internal/mcp \
  --bearer-token-env-var RTW_HUB_KEY
```

## Tests

```sh
npm ci && npm run check
```

Typecheck plus the full suite. Tests use PGlite (in-process Postgres) and fake
upstreams, so no Postgres server or GPU is needed.

## What it does not do

- No user accounts, sharing, invitations, or the team features of upstream
  OpenWhispr's cloud (see the protocol's out-of-scope list).
- No speech or language models of its own; it relays to a host you run.
- No TLS termination; run it behind a reverse proxy.
- No deploy tooling beyond the example Dockerfile and compose file.

## License

MIT. See `LICENSE`.
