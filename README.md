# Image Administration

A small server that sits between an application (or a plugin that scrapes one) and the people who make its images.

1. **A plugin requests images over HTTP**: what each image shows, its exact size and format, and the paths it is served under.
2. **People upload them** in the web UI. Wrong size? A built-in editor scales and positions the image to fit the frame.
3. **Everything is stored in one SQLite database**: project data, requests, paths and the image bytes.
4. **Images go back to the plugin**: pushed by webhook the moment they are uploaded, or fetched on demand. Any image can also be served by path (`GET /files/site/banner.jpg`).

There are no contract files: the HTTP API is the only way to describe what is needed. No npm dependencies either, just Node's built-in modules (Node ≥ 22.13).

## Run it with Docker

```bash
export ADMIN_TOKEN=$(openssl rand -hex 24)     # password of the UI and bearer token of the API
export WEBHOOK_URL=http://plugin-host:9000/images   # optional: where uploaded images are pushed
docker compose up -d --build
```

UI and API: <http://localhost:4870> (put a TLS reverse proxy in front for anything beyond a trusted network).
The database lives in the `image-admin-data` volume (`/data/image-admin.db`). **Back it up**; it contains every image.

| Environment variable | Meaning | Default |
|----------------------|---------|---------|
| `ADMIN_TOKEN` | UI password and API bearer token. **Set it**; without one a random token is generated at every start. | generated |
| `WEBHOOK_URL`, `WEBHOOK_TOKEN` | Every uploaded image is POSTed here (with `Authorization: Bearer <WEBHOOK_TOKEN>`). | off |
| `PUBLIC_FILES` | `1` = `GET /files/<path>` needs no token (for apps that load the images directly). The API always needs the token. | `0` |
| `MAX_UPLOAD_MB` | Largest accepted image. | `50` |
| `PORT`, `HOST`, `DATA_DIR` | Listen port/address and the folder that holds the database. | `4870`, `0.0.0.0` (image), `/data` |

With a bind mount instead of the named volume, make the folder writable for the container user (`chown 1000:1000`).

## Run it without Docker

```bash
ADMIN_TOKEN=secret npm start        # http://127.0.0.1:4870, database in ./data
npm test
```

## First request

```bash
curl -X POST http://localhost:4870/api/requests -H "Authorization: Bearer $ADMIN_TOKEN" -d '{
  "project": { "name": "Harbour Shop" },
  "sprites": [{ "id": "shop/banner", "description": "Homepage banner: harbour at sunset.",
                "spec": { "width": 1200, "height": 400, "formats": ["jpg"] }, "target": "site/banner.jpg" }] }'
```

Open the UI, log in with the token, upload an image for "Banner". It is validated, stored, pushed to the webhook, and available at `/files/site/banner.jpg`.

## Documents

| Document | For |
|----------|-----|
| [docs/API.md](docs/API.md) | Complete HTTP API reference: requests, spec fields, webhook, events, files, errors. |
| [docs/PLUGIN_REWRITE.md](docs/PLUGIN_REWRITE.md) | One-page read-up for (re)writing the plugin against this API. |

## Layout

`src/` server (`server.js`), SQLite schema (`db.js`), request validation (`validate.js`), storage (`store.js`), status report (`status.js`), image inspection (`images.js`, `png.js`), webhook + auth (`integration.js`) · `public/` the web UI incl. the fit editor (`fit.js`) · `test/` · `Dockerfile`, `docker-compose.yml`.
