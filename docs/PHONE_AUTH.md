# Phone and device login

The app uses phone + Android ID / iOS IDFV for signup and login, as requested. OTP and device credentials are not required; OTP routes are removed. This is device recognition used as authentication, not proof of phone ownership: a person who knows the phone and spoofs the device identifier can impersonate the user. New records leave phone_verified_at null.

## Mobile contracts

All paths are relative to /api/v1. Send JSON and use HTTPS in deployment.

POST /auth/signup:
```json
{"fullName":"Sam Example","phoneNumber":"+9779812345678","address":"Kathmandu","device":{"platform":"android","identifierType":"android_id","identifier":"1234567890abcdef"}}
```
Returns 201 with a session. Normalized duplicate phones return 409, including concurrent signup. Full names and addresses are trimmed and limited to 100 and 500 characters respectively. Country codes are required; no country is inferred.

POST /auth/login:
```json
{"phoneNumber":"+9779812345678","device":{"platform":"ios","identifierType":"idfv","identifier":"12345678-1234-1234-1234-123456789abc"}}
```
Returns 200 only when that account has the supplied active device binding. An unknown/disabled account returns generic 401; an unrecognized/reset/revoked device returns 403. Login never overwrites a binding. Missing or malformed identifiers return 400. Throttling returns 429 with Retry-After.

Successful session:
```json
{"accessToken":"signed-token","tokenType":"Bearer","expiresIn":3600,"refreshToken":"opaque-token","user":{"id":"stable-user-uuid","fullName":"Sam Example","phoneNumber":"+9779812345678","address":"Kathmandu"}}
```
No identifiers or device credentials are returned. Current mobile can use accessToken directly and log in again after expiry. Android identifiers are 16 nonzero hex digits; iOS identifiers are nonzero UUIDs; hex case is normalized. Do not invent an identifier if native lookup fails.

POST /auth/refresh accepts {"refreshToken":"opaque-token"}; rotation consumes the old refresh token and revokes its access session, with one winner under concurrent requests. Refresh lifetime is 30 days and access lifetime is one hour. Serialize refresh requests; after a lost response log in again with phone/device. POST /auth/logout with bearer token returns 204 and revokes that session. Ordinary logout retains the device binding. POST /auth/forget-device with bearer token returns 204, revokes the current device and all its sessions; subsequent device login returns 403. Forget-device requires support or an already authenticated session to restore the binding.

Existing email accounts use authenticated POST /auth/phone/link with {phoneNumber,address,device}. It links only to the authenticated user ID, returns a session and can bind a replacement device. It does not verify the phone. Another user's phone returns 409; changing an already linked phone returns 401. Never automatically merge accounts from profile data. Lost/reset devices without an active session require manual support review; no automatic phone-only recovery/reassignment exists. Recycled phone numbers are not reassigned automatically.

## Storage and deployment

Device identifiers are stored only as keyed HMACs, unique per user + key version + HMAC. Shared household devices may have separate bindings for different accounts. Prefer a persistent independent DEVICE_HMAC_SECRET of at least 32 bytes with DEVICE_HMAC_VERSION=v1. When absent, the server derives a domain-separated HMAC key from JWT_SECRET and labels it jwt-v1; no extra secret configuration is necessary for local setup. Changing JWT_SECRET with the fallback changes recognition hashes and requires authenticated relinking/support. Keep keys consistent across instances. Existing explicit v1 hashes remain usable with the same secret/version.

Apply both committed phone migrations using npm run db:migrate, regenerate Prisma, and rebuild dependencies when needed. Docker Compose passes the HMAC and legacy compatibility settings to the API. Existing OTP challenges and credential columns remain in the database to avoid deleting data; runtime login no longer reads credentials or their expiry. New bindings have null credentials. No users, IDs, issues, reports, attachments or upload files are deleted or reassigned.

Email/password routes remain available while LEGACY_AUTH_ENABLED=true (default). Existing signed tokens without a persisted session ID must log in again. Set LEGACY_AUTH_ENABLED=false only after the existing users have linked phones. All authenticated issue and media calls still require live bearer sessions; offline saved sessions do not authorize server requests. Rate limits are process-local; use a shared limiter when scaling. Request logs contain safe route/status metadata, not bodies, identifiers or tokens; disable sensitive capture in proxies and APM as well.

Rollback: prefer retaining the additive schema. The second migration's rollback aborts if credential-free bindings exist, rather than inventing credentials. The first migration's guarded rollback refuses removal when phone-only users exist. Do not deploy old OTP-dependent code against these accounts without a migration plan.

## Mobile coordination

- Existing signup/login payloads work directly; no OTP UI or credential storage is needed.
- Obtain actual ANDROID_ID/IDFV per request; display support/recovery guidance on 403.
- Preserve account UUID associations for drafts and pending uploads across logout.
- Optionally add refresh, server logout and explicit forget-device actions. Until refresh support exists, log in again after access expiry.
- For legacy users, use their existing authenticated session to call /auth/phone/link; do not create a replacement account.
