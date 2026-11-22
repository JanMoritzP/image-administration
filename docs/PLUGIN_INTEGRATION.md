# Plugin integration (HTTP)

How another program (e.g. a document-management plugin) uses image-administration:

1. The plugin **requests** images by adding sprites to the contract.
2. A person uploads the images in the admin UI (validated against the spec).
3. The admin server **pushes** each image to the plugin's webhook. The plugin can always **catch up** by polling.

## Start the server

```bash
sprite-admin serve ./my-app --token <secret> --webhook http://plugin-host:9000/images --webhook-token <plugin-secret>
```

| Flag / env | Meaning |
|------------|---------|
| `--token` / `SPRITE_ADMIN_TOKEN` | Bearer token the plugin must send. **Without it the plugin endpoints answer 503.** |
| `--webhook` / `SPRITE_ADMIN_WEBHOOK` | URL that receives every successfully uploaded image. Optional. |
| `--webhook-token` / `SPRITE_ADMIN_WEBHOOK_TOKEN` | Sent to the webhook as `Authorization: Bearer …`. Optional. |

The server needs a root manifest, but it may be empty: `contract: "1.0"` + `project: { name: X }` + `sprites: []`.
Use `--host 0.0.0.0` only behind TLS/a trusted network: the admin UI endpoints themselves have no login.

## Endpoints (all need `Authorization: Bearer <token>`)

### `POST /api/requests`: ask for images

```json
{
  "folders": { "shop": { "title": "Shop" } },
  "sprites": [
    { "id": "shop/banner", "description": "Homepage banner, sunset over a harbour.",
      "spec": { "width": 1200, "height": 400, "formats": ["png", "webp"] }, "target": "shop/banner.png" }
  ]
}
```

* `sprites` use the normal contract fields (see [CONTRACT.md](CONTRACT.md)); `folders` is optional.
* They are stored in `plugin.requests.json` next to the root manifest, which is always part of the contract.
  Hand-written files are never touched.
* A sprite with an `id` that this endpoint added earlier is **replaced**; an id already used by another contract file is an error.
* The whole contract is re-validated. On any error in the plugin's data nothing is changed:
  `422 {"ok":false,"errors":["/sprites/0/description: …"]}`. Success: `200 {"ok":true,"sprites":[…all plugin ids…],"warnings":[]}`.
* `400` for a malformed body, `409` if `plugin.requests.json` was edited into something unreadable.

### Webhook push (admin server → plugin)

After every valid upload the server sends `POST <webhook>` with the **raw image bytes** as the body:

| Header | Value |
|--------|-------|
| `Content-Type` | `image/png`, `image/webp`, … |
| `X-Sprite-Event` | `image.delivered` |
| `X-Sprite-Id` | sprite id, e.g. `shop/banner` |
| `X-Sprite-Seq` | event number (see events below) |
| `X-Sprite-Sha256` | hex SHA-256 of the body |
| `X-Sprite-Format` | `png`, `jpeg`, … |

Any `2xx` counts as delivered. Network errors, timeouts (15 s), `5xx`, `408` and `429` are retried with backoff
(1 s, 2 s, 4 s, 8 s, 5 attempts). Other `4xx` mean "rejected": no retry. The upload itself never fails because of the webhook.
The latest state per sprite (`pending` / `delivered` / `failed`, attempts, error) is in `GET /api/state` under `delivery`
and is shown on the sprite card.

Delivery state and retries live in memory: after a restart or a `failed` push, use the endpoints below to catch up.

### `GET /api/events?since=<seq>&limit=<n>`: catch up / poll

```json
{ "events": [ { "seq": 7, "at": "2026-…Z", "type": "image.delivered", "id": "shop/banner",
                "format": "png", "bytes": 12345, "sha256": "…", "targets": ["shop/banner.png"] } ] }
```

Events are persisted in `<project root>/.sprite-admin/events.jsonl`. Remember the highest `seq` you processed and pass it as `since`.
Works as the only mechanism too, if the plugin cannot receive webhooks.

### `GET /api/file?id=<sprite id>`: fetch an image

Returns the image bytes (`Content-Type`, `X-Sprite-Sha256`), `404` if nothing was uploaded yet.

## Suggested plugin loop

1. Scrape the app, `POST /api/requests` with the batch. Later, `POST` again for new images.
2. Handle webhook pushes: verify `X-Sprite-Sha256`, store the file, answer `200`.
3. On start-up and periodically: `GET /api/events?since=<last seq>` and `GET /api/file` for anything missed.
