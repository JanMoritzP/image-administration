# Plugin rewrite: quick read-up

For whoever (re)writes the document-management plugin against image-administration. Full reference: [PLUGIN_INTEGRATION.md](PLUGIN_INTEGRATION.md) and [CONTRACT.md](CONTRACT.md).

## The idea in four lines

1. The plugin scrapes the application and **requests** images (`POST /api/requests`). It can do this again at any time.
2. A person uploads images in the admin UI. If an image has the wrong size, the UI's **fit editor** scales/crops it to the exact frame first.
3. Every valid upload is **pushed** to the plugin's webhook with the image bytes, format and size.
4. The plugin can always **catch up** with `GET /api/events` and `GET /api/file`.

The plugin never writes files into the admin tool and never needs file-system access to it. HTTP only.

## Setup the plugin author needs

| Item | Value |
|------|-------|
| Admin base URL | e.g. `http://admin-host:4870` |
| Admin token | sent as `Authorization: Bearer <token>` on every plugin call |
| Webhook URL | an endpoint of the plugin that accepts `POST` (configured on the admin server: `--webhook`, optional `--webhook-token`) |
| Empty start | the admin server may start with an empty contract: `contract: "1.0"`, `project: { name: X }`, `sprites: []` |

## 1. Request images

```http
POST /api/requests
Authorization: Bearer <token>

{ "sprites": [
  { "id": "shop/banner",
    "description": "Homepage banner: harbour at sunset, no text.",
    "spec": { "width": 1200, "height": 400, "formats": ["jpg"] },
    "target": "shop/banner.jpg" } ] }
```

* `id`: unique, `folder/sub/name`. This is the plugin's key for the image. Same id again = replace the request.
* `description`: tell the human what to upload. This is the only thing they see besides the size.
* `spec`: give **exact `width` and `height`** whenever the app needs a fixed frame. Only then does the fit editor open and the result match exactly. Ranges (`minWidth`…) are checked but cannot be fitted automatically.
* `target`: path inside the admin project root, **the extension decides the format** (`png`, `jpg`, `webp`, `gif`, `svg`). Use `targets: [...]` for several copies (same format).
* Answers: `200 {ok, sprites[]}`, or `422 {ok:false, errors[]}` and nothing changed. Fix and resend.
* Batches are fine. Send new ids later for "any number of new images".

## 2. Receive images (webhook)

The admin server `POST`s the **raw bytes**. Answer any `2xx` to acknowledge.

| Header | Meaning |
|--------|---------|
| `X-Sprite-Id` | the `id` you requested |
| `X-Sprite-Seq` | event number, increases by one per upload |
| `Content-Type`, `X-Sprite-Format` | `image/png` + `png`, `image/jpeg` + `jpg`, … |
| `X-Sprite-Width`, `X-Sprite-Height` | pixel size (absent if unreadable, e.g. SVG) |
| `X-Sprite-Sha256` | hex hash of the body: verify it |
| `Authorization` | `Bearer <webhook-token>` if configured |

Retries: network errors, timeouts (15 s), 5xx, 408, 429 → retried with backoff (5 attempts). Other 4xx → dropped. **Make the handler idempotent** (same `id` may arrive again, replacing the image).

## 3. Catch up (do this on start-up and on a timer)

```http
GET /api/events?since=<last seq you stored>      → { events: [ {seq, id, format, width, height, bytes, sha256, targets, at} ] }
GET /api/file?id=<id>                            → image bytes (+ X-Sprite-Sha256)
```

Store the highest `seq` you processed. Webhook failures and admin restarts are healed by this loop.

## Minimal sketch (Node 18+)

```js
const ADMIN = 'http://admin-host:4870', H = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

export const requestImages = (sprites) =>
  fetch(`${ADMIN}/api/requests`, { method: 'POST', headers: H, body: JSON.stringify({ sprites }) }).then((r) => r.json());

// webhook handler: (req, res) => …
export async function onPush(req, res, save) {
  const body = Buffer.concat(await req.toArray());
  if (sha256(body) !== req.headers['x-sprite-sha256']) return res.writeHead(400).end();
  await save(req.headers['x-sprite-id'], body, { format: req.headers['x-sprite-format'], seq: +req.headers['x-sprite-seq'] });
  res.writeHead(204).end();
}

export async function catchUp(since, save) {
  const { events } = await (await fetch(`${ADMIN}/api/events?since=${since}`, { headers: H })).json();
  for (const e of events) save(e.id, Buffer.from(await (await fetch(`${ADMIN}/api/file?id=${e.id}`, { headers: H })).arrayBuffer()), e);
  return events.at(-1)?.seq ?? since;
}
```

## Rewrite checklist

- [ ] Scrape the app, build one sprite per needed image (id, description, exact size, target with the right extension), `POST /api/requests`.
- [ ] Keep a map `id → where this image is used` on the plugin side.
- [ ] Webhook endpoint: verify hash, store, answer 2xx, idempotent.
- [ ] Persist `lastSeq`; run `catchUp` on start-up and periodically.
- [ ] Treat `422` from `/api/requests` as "my data is wrong", show `errors` to the user.
- [ ] Never expose the admin token or the admin server to the public internet; the UI itself has no login.
