# Authoring a Sprite Contract (guide for AI agents and scripts)

Goal: make an application declare **every image it needs** so a human can upload them with `sprite-admin` and
they land exactly where the app loads them. You are writing *requirements*, not art.
Full reference: [CONTRACT.md](CONTRACT.md). Schema: [`schema/sprite-contract.schema.json`](../schema/sprite-contract.schema.json).

## The 8-step procedure

1. **Find every image the app references.** Search code, scenes, styles, configs, HTML and manifests for image paths, atlas keys, `<img src>`, `url(...)`, `load.image`, `Texture`, `Sprite`, `require('*.png')`, asset lists. Include images the app *will* need (TODO comments, placeholder rectangles, emoji used as stand-ins).
2. **Create `sprites.contract.yml` in the project (or tools) directory** with `contract: "1.0"` and `project.name`. Set `project.root` so that `target` paths are exactly what the app loads (relative to that root). Put the art direction (style, palette, resolution, perspective) in `project.description`.
3. **Split into files when there are more than ~15 sprites**: add `include: ["contracts/*.yml"]` and one file per domain (characters, tiles, ui, vfx, audio-visuals…). Each file starts with `contract: "1.0"`.
4. **Put shared rules in `defaults`** (root, file or `folders.<path>.defaults`), not in every sprite: `spec.formats`, `spec.alpha`, common sizes, and a `targets` template like `["assets/{id}.png"]`.
5. **Use `matrix` for families**: animation frames, directions, states, skins, sizes. Never copy-paste 16 near-identical entries.
6. **Write a real `description` for every sprite** (see below). This is the most valuable field.
7. **Validate**: `sprite-admin validate .` until it prints `0 error(s)`. Fix warnings too (typos show up as `unknown-key`).
8. **Check the result**: `sprite-admin status . --missing` lists what a human still has to supply, with your descriptions.

## Writing good descriptions

A description answers: *what is it, what does it look like, how is it used, what must not be in it?*

| Bad | Good |
|-----|------|
| `Player sprite` | `The player character, a short wizard with a blue pointed hat and brown cloak, standing idle and facing the camera. Feet touch the bottom edge. No weapon.` |
| `Button` | `Rounded rectangular "Play" button in its normal (not hovered) state: gold fill, dark outline, the word PLAY in white pixel font. Used on the title screen.` |
| `Background` | `Full-screen dark dungeon corridor lit by two torches, perspective vanishing point at centre. Must contain no text, because the logo is drawn on top of it.` |

Rules of thumb: concrete nouns and colours, perspective/pose/state, transparency expectations, animation position ("frame 2 of 4"), what is drawn *on top* of it. Do not describe file formats or sizes here, that belongs in `spec`.

## Choosing the `spec`

* Say the **exact** size when the app hard-codes it (`width`/`height`); use `minWidth`/`aspect` when it scales.
* `alpha: required` for anything drawn over other things (characters, icons, UI), `alpha: forbidden` for opaque backgrounds/tiles, otherwise omit.
* `formats` defaults to the extensions of the targets, so only set it if a sprite accepts several (`formats: [png, webp]` requires the targets to be in that list).
* Add `maxBytes` for web assets. Add `multipleOf: 8/16` for tile-grid art.
* `strict: false` for "should be about this big" guidance that must not block an upload.

## Choosing `targets`

* Targets are what the **application** loads. Copy the real paths, relative to `project.root`, forward slashes, with extension.
* One sprite can have several targets (the same image needed in two places): list them all, the tool delivers the one upload to each.
* Different images must have different targets (`target-conflict`).
* Prefer a `defaults.targets` template (`"public/img/{id}.png"`) so a sprite needs only `id` + `description` + `spec`.

## Copy-paste skeletons

Minimal root manifest:

```yaml
# yaml-language-server: $schema=./schema/sprite-contract.schema.json
contract: "1.0"
project:
  name: <app name>
  description: <art style, palette, resolution, perspective, mood in 1-3 sentences>
  root: .                              # target paths are relative to this
include: ["contracts/*.yml"]
defaults:
  spec: { formats: [png], alpha: required }
  targets: ["assets/{id}.png"]         # sprites may omit target(s)
```

A domain file (`contracts/tiles.yml`):

```yaml
contract: "1.0"
defaults:
  spec: { width: 16, height: 16, alpha: forbidden }
folders:
  tiles: { title: Tiles, icon: "🧱", description: "Seamless 16x16 environment tiles." }
sprites:
  - id: tiles/floor/stone
    description: Plain grey cobblestone floor, must tile seamlessly in all four directions.
  - id: tiles/props/door-{state}
    description: Wooden dungeon door, {state}.
    matrix: { state: [closed, open] }
    spec: { alpha: any }
```

JSON works identically (`.json` files can be included from YAML manifests and vice versa).

## Pitfalls checklist

- [ ] Every file has `contract: "1.0"`; only the root has `project`.
- [ ] `description` present and meaningful on every sprite (a missing one makes the sprite **not load**).
- [ ] `target` **xor** `targets`.
- [ ] Target extensions are one of png/jpg/jpeg/webp/gif/svg and match `spec.formats` if you set it.
- [ ] No `..`, no leading `/`, no backslashes in targets.
- [ ] Ids are unique across *all* files (use folder-like prefixes: `ui/hud/heart-full`).
- [ ] Matrix variables are lowercase and are all used where uniqueness needs them (a matrix of `frame` with an `id` that omits `{frame}` creates duplicates).
- [ ] Zero-pad with `{frame:02}` when the app's file names are padded.
- [ ] `{` and `}` literals in text are written `{{` and `}}`.
- [ ] Re-run `sprite-admin validate` after every change.

## Keeping the app in sync

Add this to the app's `AGENTS.md` / `CLAUDE.md` so every future agent keeps the contract current:

```markdown
## Sprites
This project declares every image it needs in `sprites.contract.yml` (spec: docs/CONTRACT.md in the
image-administration tool). When code starts using a new image, add it to the contract in the same change
(id, description, spec, target(s)) and run `sprite-admin validate`. Never hand-place binary art for a sprite
without a contract entry. `sprite-admin status --missing` shows what art is still outstanding.
```

## Consuming the contract from a script or agent

```bash
sprite-admin status . --json            # full machine-readable report (CONTRACT.md section 6)
sprite-admin status . --missing         # human/LLM-friendly list of what is outstanding
sprite-admin status . --check           # exit code 2 if required sprites are missing (CI gate)
```

An image-generating agent can iterate `report.sprites.filter(s => s.status !== 'available')`, read `description` and `spec`, generate an
image that satisfies them, and `POST` the bytes to `/api/upload?id=<id>` (header `X-Sprite-Admin: 1`) of a running `sprite-admin serve`.
A rejected upload returns the exact reasons in `errors`.
