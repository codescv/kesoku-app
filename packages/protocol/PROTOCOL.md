# Kesoku Wire Protocol V1.2 — implementation contract

Source of truth: `packages/protocol/src/*.ts` (zod). `pnpm gen:schema` writes
`packages/protocol/dist/protocol.schema.json` (JSON Schema for every payload) for the
Python side (`kesoku/gateway/chatbot/app/protocol.py`).

## 1. Envelope

```jsonc
{ "v": 1, "type": "stream.delta", "id": "evt_01J…", "ts": 1763100000.123,
  "session_id": "3f9a1c2b", "seq": 4182, "reply_to": "req_…", "device_id": "dev_…", "payload": {} }
```

* `id` — ULID with prefix (`evt_` / `req_`), idempotency key. `ts` — Unix seconds (float).
* `device_id` — **routing field, engine leg only.**
  * client → engine: the relay always **overwrites** it with the authenticated device id.
  * engine → client: if present the relay **unicasts** to that device (RPC replies, replays);
    if absent it **broadcasts** to every authenticated client leg (single-user system).
* RPC replies carry `reply_to = <request id>` and `device_id = <requester>`.
* Response type naming: `<request type>.result` unless listed otherwise
  (`session.snapshot` for `session.open` **and** `session.create`, `message.ack`, `avatar.job`, `media.ticket.ok`, `media.refresh.ok`, `pong`,
  `media.ready` for `media.hydrate` / `voice.preview`).
* Errors: `error{code, message, reply_to?}` with `reply_to` also on the envelope.

## 2. Routing & relay behaviour

| Concern | Rule |
|---|---|
| Relay-consumed client types | `auth.hello`, `ping`, `media.ticket`, `media.refresh` (never forwarded) |
| Client → engine | everything else, verbatim + `device_id`; relay additionally injects signed GET `url` into each `message.send.attachments[]` and `source_url` into `avatar.generate` |
| Engine offline | client frames queue in relay (≤ 1,000); overflow → `error{code:"ENGINE_OFFLINE", reply_to}` |
| Ring buffer | every engine→client frame with `session_id` + `seq` (and no `device_id`) is appended to a 2,000-event per-session ring |
| `sync.resume` | per session: ring covers `last_seq+1` → relay replays the ring events (unicast) then forwards `sync.replay{session_id, after_seq: <last replayed seq>, limit:500}` to the engine (engine answers `sync.done` with `active_turn`); ring miss → forward `sync.replay{after_seq: last_seq}`; engine offline → relay answers `sync.done{has_more:false}` from the ring |
| `media.ready` without `url` | relay signs `object` and fills `url` + `expires_at` |
| Engine leg | `Authorization: Bearer <ENGINE_TOKEN>`; first frame `engine.hello{boot_id, conn_seq, last_inbound_id?, revoked_device_ids[]}` → `engine.welcome{primary, server_ts, queued}`; greater `(boot_id, conn_seq)` (lexicographic, then numeric) takes over **instantly**, old leg drains 3 s then closes `4409`; smaller-or-equal is rejected `4409` |
| Rotation | both legs receive `relay.rotate{grace_ms:3000}` at 55 min |
| Shutdown | SIGTERM → `relay.restarting{retry_ms}` on both legs |

## 3. Relay ⇄ engine internal types (agreed with the engine, board #77/#78)

| Direction | type | payload |
|---|---|---|
| E→R | `engine.hello` | `{boot_id:int ms epoch, conn_seq, engine_version?, last_inbound_id?, revoked_device_ids[]}` |
| R→E | `engine.welcome` | `{primary, server_ts, queued}` |
| E→R | `pair.offer` | `{code_hash: hex(sha256(utf8(code + salt))), salt (32 hex), expires_at, name}` (one active offer; new replaces old) |
| R→E | `pair.redeem` | `{device_id, name, platform, model?}` |
| R→E | `pair.burned` | `{code_hash, attempts}` (5 failed attempts across all IPs) |
| R→E | `device.registered` | `{device_id, kind:"google", name, email, platform}` (queued while engine offline) |
| E→R | `device.revoked` | `{device_ids[]}` → relay closes those legs `4410` and rejects their tokens |
| R→E | `sync.replay` | `{session_id, after_seq, limit}` + envelope `device_id` (engine replies with seq'd frames + `sync.done`/`sync.reset`, all unicast) |
| E→R | `media.upload.ticket` | `{purpose:"message"\|"asset"\|"avatar_candidate", session_id?, mime, bytes, filename?, index?}` → R→E `media.ticket.ok{object, put_url, expires_at, max_bytes, get_url, get_expires_at}` |
| E→R | `media.sign` | `{object}` → R→E `media.signed{object, url, expires_at, issued_device_id?, issued_at?}` |
| E→R | binary `media.put` | `uint32 BE header_len \| header JSON {v:1,type:"media.put",id,purpose,session_id?,mime,filename?,index?} \| bytes` (≤ 1 MiB) → R→E `media.put.ok{object,url,expires_at,mime,bytes}` |
| both | `ping` / `pong` | 25 s heartbeat |

Object names: message → `media/<sid>/<uuid>.<ext>`, asset → `media/asset/<uuid>.<ext>`,
avatar source (client) → `media/avatar/<uuid>.<ext>`, avatar candidate → `media/avatar/<uuid>-cand<index>.webp`.

## 4. Auth

* Device token: `kdt1.<b64url("dev_xxx|<issued_at_s>|pair")>.<b64url(HMAC-SHA256)>` for paired devices, and
  `kdt1.<b64url("dev_xxx|<issued_at_s>|google|<email>")>.<b64url(HMAC-SHA256)>` for Google sign-ins (verified,
  lower-cased email; legacy 3-field `google` bodies still decode). Max token length 768.
* `POST /pair {code, device:{platform, model?, name?}}` → `{device_token, device_id}`. When Google Sign-In is
  enabled (`/auth/config` `google_login: true`), `platform: "web"` is refused with 403 `WEB_GOOGLE_REQUIRED`
  (before the code is checked) and no cookie is set (native shells keep the token from the body); otherwise
  (local mode) the response also sets the session cookie.
* `POST /auth/google {id_token}` → allowlist check → `{device_id, device_token, email}` + `Set-Cookie`;
  refused accounts get 403 `{error: "FORBIDDEN_EMAIL", email}` and any session cookie is cleared.
* `/ws` with Google Sign-In enabled: cookie sessions must be `google` tokens whose email is in `ALLOWED_EMAILS`,
  and `google` tokens whose email has left the allowlist are refused (close `4403`).
* `POST /auth/logout` → clears cookie.
* Cookie `__Host-kesoku_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`) holds the device token for Web;
  `auth.hello.device_token` may then be omitted.

## 5. Event catalogue

See `src/events.ts` — `ClientToEngine`, `EngineToClient`, `EngineToRelay`, `RelayToEngine`.
Seq'd (replayable) types: `message.user`, `message.final`, `turn.event`, `media.pending`,
`media.ready`, `media.failed`, `state.sync`, `session.updated`, `memory.proposal`,
`memory.proposal.resolved`. `stream.delta` / `stream.clear` are volatile (no seq).

`stream.delta.offset` = Unicode **code point** length of the round's accumulated text before
`delta` (Python `len(str)` == JS `[...s].length`).
