# Mobile issue upload mapping

The frontend is unchanged in this backend task. This file maps the current local model to the future uploader.

| Local field | Upload field or action |
| --- | --- |
| `Issue.id` | `metadata.clientIssueId` and identical `Idempotency-Key` header. It is an arbitrary safe client id, not a server UUID. |
| `Issue.ownerId` | Never transmit. Sign in online and let the bearer token determine the server owner. Do not upload another account's drafts. |
| `Issue.createdAt` | `metadata.clientCreatedAt` as ISO 8601. Keep it unchanged through edits and retries. |
| `Issue.updatedAt` | `metadata.clientUpdatedAt` in the frozen upload snapshot. |
| `Issue.description` | `metadata.description`, including an empty string for media-only issues. |
| `Issue.status` | Device-only state. Do not transmit `draft` or `pending_upload`. |
| `Issue.photos[]` | One `attachments[]` descriptor per photo, `kind:"photo"`, plus one `media:<id>` binary file part. |
| `Issue.audio[]` | One descriptor per voice note, `kind:"audio"`, `durationMs` when available, plus one `media:<id>` binary file part. |
| `Attachment.id` | `clientAttachmentId`, unique within the issue. |
| `Attachment.file` | Read from private phone storage and send its bytes. Never send the relative path or original filename as metadata. |
| `Attachment.createdAt` | Descriptor `createdAt` as ISO 8601. |
| `Attachment.waveform` | Display-only; omit. The server does not store waveform bars. |
| `Issue.firstPhotoId` | Legacy display field; omit. |
| `Issue.locationStatus` | Send final `none`, `unavailable`, or `captured`. Wait for a pending capture to finish before uploading. |
| `Issue.locationSource` | Send `manual` only if actually present; omit for legacy captures. |
| `Issue.location` | Send only when captured: device `latitude`, `longitude`, `accuracy` meters, and `timestamp` Unix milliseconds. Do not use photo EXIF. |

The issue's display name remains a full creation date/time formatted on the phone. There is no upload title or localized name field. Capture location only when the person presses Capture location or Update. GPS failure leaves other evidence uploadable.

Keep the entire local issue and its media until a 201 creation or 200 identical replay is received. A timeout or lost response may mean the server already committed the issue; retry the **same frozen snapshot** with the same client id, metadata, and bytes. Editing a snapshot after a successful upload causes 409 and needs a future update API. On 400/413/415, keep the files and show a corrective message; on 429, respect `Retry-After`; on 500/503 or network failure, retry later. On 401, preserve local drafts and local account access, then request online sign-in before another upload. An expired server token does not remove the remembered local workspace. Guest drafts move locally to an account after login/signup; never send a guest token or guest owner id.

For server playback later, request `attachment.contentPath` with a bearer token. Audio seeking can use `Range`; unauthenticated URLs do not work. The server's `durationMs` is the client-reported value, not a measured duration. Preserve the server issue UUID and attachment UUIDs separately from local ids.
