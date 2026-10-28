# NWASH backend

JavaScript, Node.js 24 LTS, Express, PostgreSQL, Prisma, and Argon2id. Authentication keeps the existing User table and session response. The new issue API accepts immutable, authenticated upload snapshots. See [openapi.yaml](openapi.yaml) for the schema and [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md) for the mobile mapping.

## Start

Copy `.env.example` to `.env`. Replace the example database password in `POSTGRES_PASSWORD`, `DATABASE_URL`, and `TEST_DATABASE_URL` with the same URL-safe local value. Set `JWT_SECRET` to a unique random value of at least 32 bytes, for example from `openssl rand -hex 32`. Never commit `.env`.

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 api postgres
curl http://127.0.0.1:8000/api/v1/health
curl http://127.0.0.1:8000/api/v1/ready
```

Compose applies committed Prisma migrations before starting the API. It bind mounts source for development restarts. PostgreSQL and issue uploads use named persistent volumes; the private issue upload volume is outside the public web root. After a dependency change, use `docker compose up --build --renew-anon-volumes -d`. To apply migrations manually, use `docker compose run --rm api npm run db:migrate`. To run outside Docker, start the two databases with `docker compose up -d postgres postgres_test`, then run `npm ci`, `npm run db:generate`, `npm run db:migrate`, and `npm start`.

The API listens on `0.0.0.0:8000` inside its container. `API_BIND_IP` controls which host interface publishes port 8000. Set it to the computer's Wi-Fi IPv4 address for a physical phone and recreate the API container. The current development phone URL is `http://192.168.1.76:8000/api/v1` only when that is the computer's actual LAN address. USB development can use `adb reverse tcp:8000 tcp:8000` and localhost. Use HTTPS in production. Set `TRUST_PROXY_HOPS` only for a trusted reverse proxy.

## Authentication and errors

`POST /api/v1/auth/signup` accepts `fullName`, `email`, and `password`. `POST /api/v1/auth/login` accepts `email` and `password`. Both return `{accessToken, tokenType:"Bearer", expiresIn:3600, user:{id,email,fullName}}`. `GET /api/v1/auth/me` requires `Authorization: Bearer <token>`. Auth responses are `Cache-Control: no-store`. Existing accounts may log in with their existing passwords even if those passwords do not meet current signup length rules. Unknown emails use dummy Argon2id verification.

Errors use `{"error":{"code":"VALIDATION_ERROR","message":"Invalid request.","details":[]},"requestId":"uuid"}`. Codes are: `VALIDATION_ERROR` (400), `UNAUTHORIZED`/`INVALID_CREDENTIALS` (401), `NOT_FOUND` (404), `EMAIL_EXISTS`/`ISSUE_CONTENT_CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429, with `Retry-After`), `INTERNAL_ERROR` (500), and `SERVICE_UNAVAILABLE` (503). Invalid media ranges use 416 `RANGE_NOT_SATISFIABLE`. Server error logs contain request ids and safe error codes, not credentials or report contents. Rate limits use process memory, so run a shared limit store before scaling to multiple API processes.

## Issue upload contract

`POST /api/v1/issues` requires a bearer token and `Idempotency-Key: <clientIssueId>`. Send one `metadata` JSON field and exactly one binary `media:<clientAttachmentId>` field for each declared attachment. IDs are 1–128 ASCII letters, digits, underscore, or hyphen. No client owner, workflow status, file path, waveform, or display name is accepted. At least one nonblank description, photo, or audio note is required. Location alone is insufficient. Location is optional; `pending` cannot upload. Captured locations have coordinates, nonnegative accuracy, and a Unix **millisecond** timestamp. Missing `locationSource` remains null/legacy.

Defaults: 20 photos, 10 audio notes, 15 MiB per photo, 30 MiB per audio note, 200 MiB total multipart body, and 128 KiB metadata. The environment variables in `.env.example` adjust them. Accepted photos are JPEG, PNG, HEIC, and HEIF; accepted audio is AAC in M4A/MP4 (declared `audio/mp4` or `audio/x-m4a`). The server inspects signatures and container structure, hashes each file, and chooses private storage keys. It does not transcode, transcribe, generate waveforms, or probe duration. `durationMs` is client reported and unverified. Device timestamps are preserved as reported and are not proof of event time.

201 means the complete snapshot is committed and retrievable. An identical retry returns 200 with `replayed:true`; a changed snapshot with the same owner and client id returns 409. Multipart ordering, HTTP filenames, and JSON key order do not change the fingerprint. Keep the queued snapshot and its files until success. An edit after upload requires a separately designed API.

Issue reads are owner only: `GET /api/v1/issues?limit=20&cursor=...`, `GET /api/v1/issues/:id`, and `GET /api/v1/issues/:issueId/attachments/:attachmentId/content`. Lists sort by `clientCreatedAt DESC, id DESC`; receipt and retry time do not change order. Audio requests may use `Range: bytes=0-1023`. The media endpoint requires the bearer token and supports 206/416; content URLs are not public.

## Curl examples

Set `API` to your development server and copy a token from a login response:

```bash
API=http://127.0.0.1:8000/api/v1
curl -i "$API/auth/signup" -H 'Content-Type: application/json' \
  -d '{"fullName":"Sam Example","email":"sam@example.com","password":"password123"}'
curl -i "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"sam@example.com","password":"password123"}'
TOKEN='paste-access-token-here'
```

Text-only issue and identical retry (run the same request twice; first returns 201, second 200):

```bash
META='{"clientIssueId":"1793193119352-190i1858","clientCreatedAt":"2026-10-28T12:00:00.000Z","clientUpdatedAt":"2026-10-28T12:10:00.000Z","description":"Water leaking beside the road","locationStatus":"none","attachments":[]}'
curl -i "$API/issues" -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: 1793193119352-190i1858' \
  -F "metadata=$META;type=application/json"
```

Photo, audio, and manually captured location (the fixture paths work from this repository):

```bash
META='{"clientIssueId":"1793193119353-190i1858","clientCreatedAt":"2026-10-28T12:00:00.000Z","clientUpdatedAt":"2026-10-28T12:10:00.000Z","description":"","locationStatus":"captured","locationSource":"manual","location":{"latitude":27.67272,"longitude":85.34395,"accuracy":100,"timestamp":1793188800000},"attachments":[{"clientAttachmentId":"photo-1","kind":"photo","createdAt":"2026-10-28T12:01:00.000Z"},{"clientAttachmentId":"audio-1","kind":"audio","createdAt":"2026-10-28T12:02:00.000Z","durationMs":9500}]}'
curl -i "$API/issues" -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: 1793193119353-190i1858' \
  -F "metadata=$META;type=application/json" \
  -F 'media:photo-1=@test/fixtures/photo.jpg;type=image/jpeg' \
  -F 'media:audio-1=@test/fixtures/voice.m4a;type=audio/mp4'
```

Use server ids and the cursor returned by the API:

```bash
curl -i "$API/issues?limit=20" -H "Authorization: Bearer $TOKEN"
curl -i "$API/issues?limit=20&cursor=PASTE_NEXT_CURSOR" -H "Authorization: Bearer $TOKEN"
curl -i "$API/issues/SERVER_ISSUE_UUID" -H "Authorization: Bearer $TOKEN"
curl -i "$API/issues/SERVER_ISSUE_UUID/attachments/SERVER_ATTACHMENT_UUID/content" \
  -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-1023' -o sample.m4a
```

## Recovery and tests

Files stream to generated names in staging. The server promotes and syncs them before committing issue rows. A normal failure rolls back the database transaction and removes promoted files. A process crash before commit can leave unreferenced files; a crash after commit leaves a complete issue that an identical retry can acknowledge. The cleanup command excludes all storage keys referenced by committed attachments and only considers files older than 24 hours. Stop API writers before running it:

```bash
docker compose stop api
docker compose run --rm --no-deps api npm run uploads:cleanup
docker compose run --rm --no-deps api npm run uploads:cleanup -- --delete
docker compose up -d api
```

The first cleanup command is a dry run. Back up the database and upload volume together. If committed media is missing, reads and retries return 503 until storage is restored.

Run real PostgreSQL integration tests (the test database is separate and uses temporary storage):

```bash
docker compose up -d postgres_test
docker compose exec api npm test
```

`npm test` applies migrations to `TEST_DATABASE_URL` before running tests. Parser, metadata, and media checks can also run without PostgreSQL via `npm run test:unit`. The optional development seed is `npm run seed:dev` with `SEED_FULL_NAME`, `SEED_EMAIL`, and `SEED_PASSWORD` set in the environment. In Compose, pass them with `docker compose exec -e SEED_FULL_NAME='Name' -e SEED_EMAIL='email@example.com' -e SEED_PASSWORD='your-local-password' api npm run seed:dev`. It never overwrites existing accounts and refuses `NODE_ENV=production`. Older `reports` and `media` tables remain for data preservation, but their public routes are retired.
# NWASH_Backend
