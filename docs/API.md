# HTTP API

Base URL e.g. `http://admin-host:4870`. Everything under `/api` needs `Authorization: Bearer <ADMIN_TOKEN>` (the web UI uses a login cookie instead). Bodies are JSON unless stated. Errors look like `{"ok":false,"errors":["…"]}`.

| Method & path | Purpose |
|---------------|---------|
| `POST /api/requests` | Request images (add/replace sprites, folders, project info). |
| `DELETE /api/sprites?id=` | Remove a sprite with its image and paths. |
| `POST /api/upload?id=` | Body = raw image bytes. Validates and stores the image. (This is what the UI does.) |
| `GET /api/state` | Everything: project, folders, sprites with status, image info, webhook delivery state. |
| `GET /api/file?id=[&history=n]` | The image bytes of a sprite (or an older version). |
| `GET /api/history?id=` | The last 5 replaced versions of a sprite's image. |
| `GET /api/events?since=&limit=` | Change log for polling. |
| `GET /files/<path>` | The image served under a target path. Token needed unless `PUBLIC_FILES=1`. Supports `ETag`/`If-None-Match`. |
| `GET /healthz` | Liveness probe, no auth. |

## `POST /api/requests`

```json
{
  "project": { "name": "Harbour Shop", "description": "Images for the web shop" },
  "folders": { "shop": { "title": "Shop pages", "icon": "🛒", "description": "…" } },
  "sprites": [
    { "id": "shop/banner",
      "description": "Homepage banner: harbour at sunset, no text.",
      "spec": { "width": 1200, "height": 400, "formats": ["jpg"], "maxBytes": 300000 },
      "targets": ["site/banner.jpg", { "path": "site/banner@mobile.jpg", "label": "mobile" }],
      "required": true, "tags": ["home"], "notes": "Leave the left third empty for the headline." }
  ]
}
```

All three top-level keys are optional, but at least one is needed. The request is **all or nothing**: any error means `422` and nothing changes.

* A sprite with an existing `id` is **replaced** (its stored image stays; if the new spec no longer fits it, the sprite shows as *invalid*). Sprites may swap paths within one request.
* `id`: `folder/sub/name` (letters, digits, `_ . -`). The folder tree in the UI is derived from it. `folders` only adds titles/icons/descriptions.
* `description` is required: it is what the person uploading sees.
* `target` (one) or `targets` (several, strings or `{path, label}`): the paths the image is served under. Relative, no `..`, **globally unique**. The **extension decides the format** (`png`, `jpg`/`jpeg`, `webp`, `gif`, `svg`); all targets of one sprite must have the same format.
* `title` (default: humanized last id segment), `required` (default `true`, only required sprites count for progress), `tags`, `notes`.

Success: `200 {"ok":true,"sprites":["shop/banner"],"warnings":[…]}`. Warnings are for ignored unknown keys.

### `spec`: what the image must be

| Key | Meaning |
|-----|---------|
| `width`, `height` | exact pixels. **Give both when the app needs a fixed frame**: only then the UI's fit editor can scale an image to size. |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | ranges |
| `aspect` | e.g. `"16:9"` |
| `multipleOf` | both sides divisible by n |
| `formats` | allowed formats, default = formats of the targets |
| `alpha` | `"required"` (must have transparency), `"forbidden"`, `"any"` (default) |
| `maxBytes` | file size limit |
| `strict` | `false` turns violations into warnings so the upload is still accepted |

## Uploads

`POST /api/upload?id=<sprite id>` with the raw bytes. Content is detected from the bytes, not from a file name. On success `200 {"ok":true,"warnings":[],"sprite":{…}}`; on failure `422 {"ok":false,"errors":["width is 9px, must be exactly 8px"]}` and nothing is stored (`404` unknown id, `400` empty, `413` too large). A replaced image is kept in the history (last 5).

## Webhook push (admin server → plugin)

If `WEBHOOK_URL` is set, every accepted upload is `POST`ed to it with the **raw image bytes** as the body:

| Header | Meaning |
|--------|---------|
| `Content-Type` | `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml` |
| `X-Sprite-Event` | `image.delivered` |
| `X-Sprite-Id` | the sprite id |
| `X-Sprite-Seq` | event number (same as in `/api/events`) |
| `X-Sprite-Format` | `png`, `jpg`, `webp`, `gif`, `svg` |
| `X-Sprite-Width`, `X-Sprite-Height` | pixel size (absent when unreadable, e.g. SVG without size) |
| `X-Sprite-Sha256` | hex SHA-256 of the body |
| `Authorization` | `Bearer <WEBHOOK_TOKEN>` if configured |

Any `2xx` = delivered. Network errors, timeouts (15 s), `5xx`, `408`, `429` are retried with backoff (1, 2, 4, 8 s; 5 attempts); other `4xx` are not retried. The upload never fails because of the webhook. Delivery state per sprite (`pending`/`delivered`/`failed`) is in `GET /api/state` under `delivery` and on the sprite card. It is held in memory: after a restart or a failed push the plugin catches up with the events below.

## Events (catch-up / polling)

`GET /api/events?since=<seq>&limit=<n≤1000>`:

```json
{ "events": [
  { "seq": 7, "at": "2026-…Z", "type": "image.delivered", "id": "shop/banner", "format": "jpg", "width": 1200, "height": 400,
    "bytes": 81234, "sha256": "…", "targets": ["site/banner.jpg"] },
  { "seq": 8, "at": "…", "type": "sprite.deleted", "id": "old/thing", "targets": ["old/thing.png"] } ] }
```

Stored in the database, ordered by `seq`. Keep the highest `seq` you handled and pass it as `since`. Fetch bytes with `GET /api/file?id=` or `GET /files/<path>`.

## Browser login

`POST /api/login {"token": "…"}` sets an HttpOnly, SameSite=Strict session cookie (never containing the token); `POST /api/logout` clears it. State-changing calls made with the cookie must also send `X-Sprite-Admin: 1`. Calls with the bearer token don't. Ten wrong tokens from one address lock logins for a minute.

## Security notes

* Use a long random `ADMIN_TOKEN` and TLS (reverse proxy) when the server is reachable beyond a trusted network. Behind a proxy, forward `X-Forwarded-Proto: https` so the cookie gets the `Secure` flag.
* The webhook URL is operator configuration, not something requests can set.
* Served images carry a restrictive `Content-Security-Policy` and `nosniff`, so an SVG cannot run scripts.
