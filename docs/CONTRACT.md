# Sprite Contract Specification, version 1.0

A **Sprite Contract** is a set of YAML or JSON files, living inside (or next to) an application, that declares
**every image the application needs**: what it should show, how big it must be, and **where in the project it must end up**.

Any tool can read a contract. The reference tool, `sprite-admin`, reads it to:

1. show which sprites are **missing**, **available**, **partial** or **invalid**, with a progress bar and the description of each missing one,
2. accept uploads, validate them against the sprite's requirements, and
3. copy the file to **every target path** the contract names.

The contract is the *only* interface between an application and the tool. The application never needs to know the tool exists:
it just loads files from the paths it declared. The file system is the source of truth, so there is no database and no lock file.

> **Writing a contract as an AI?** Read [AI_AUTHORING_GUIDE.md](AI_AUTHORING_GUIDE.md) first, it is a short, task-oriented version of this document.

---

## 1. File layout and discovery

```
my-app/
├── sprites.contract.yml        <- ROOT MANIFEST (exactly one; the tool looks for this name)
├── contracts/                  <- any number of additional contract files
│   ├── characters.yml
│   ├── tiles.json              <- YAML and JSON can be mixed freely
│   └── ui.yml
└── assets/ …                   <- where the images actually go (see project.root + targets)
```

* The tool is pointed at a directory or a file. For a directory it looks for, in this order:
  `sprites.contract.yml`, `sprites.contract.yaml`, `sprites.contract.json`.
* The **root manifest** may contain everything (small apps) or only `project`, `defaults`, `folders` and an `include` list (large apps).
* Files are YAML 1.2 (`.yml`/`.yaml`) or JSON (`.json`). Duplicate mapping keys are a parse error.
* **Why several files?** Split by domain (characters, tiles, UI, VFX…) or by owner. Each included file can add its own
  defaults, so a file of 16x16 tiles can say so once. Included files are *self-contained documents*: anyone (a person, a
  script, an AI agent) can add a new file under `contracts/` without touching any other file, as long as the root's
  `include` glob picks it up.

## 2. Document structure

Every file (root or included) is a mapping with these top-level keys:

| Key         | Root manifest | Included file | Meaning |
|-------------|:-------------:|:-------------:|---------|
| `contract`  | **required**  | **required**  | Spec version string, `"1.0"`. |
| `project`   | **required**  | ignored (warning) | Name, description, target root directory, backup setting. |
| `include`   | optional      | optional      | Other contract files (paths or globs). May nest up to 8 levels. |
| `defaults`  | optional      | optional      | Values inherited by sprites (scope: whole project in root, this file in an included file). |
| `folders`   | optional      | optional      | Display metadata and defaults for folder paths. |
| `sprites`   | optional      | optional      | The list of sprites. |
| `$schema`   | optional      | optional      | Editor hint, ignored by the tool. |

Unknown keys are **ignored with a warning** (the warning suggests the nearest valid key, so typos are caught).

### 2.1 `contract`

Must be `"1.0"` (a string; the number `1.0` is also accepted). A different major version is an error.

### 2.2 `project` (root manifest only)

| Field         | Type    | Default | Meaning |
|---------------|---------|---------|---------|
| `name`        | string  | **required** | Display name of the application. |
| `description` | string  | `""`    | Context for whoever draws the art: what the app is, art style, palette, perspective, mood. Shown in the UI header. |
| `root`        | string  | `"."`   | Directory that every target path is relative to. Itself relative to the manifest file. Example: `root: ../game` when the manifest sits in a `tools/` folder. |
| `backups`     | boolean | `true`  | Before an upload overwrites existing files, copy them to `<root>/.sprite-admin/backups/<timestamp>/<path>`. |

### 2.3 `include`

A path or a list of paths/globs, **relative to the file that contains the `include`**.

* Glob syntax: `*` (within a directory), `**` (any depth), `?` (one character). Hidden files/directories and `node_modules` are skipped.
* Plain paths must exist (`include-missing` error). Globs that match nothing give an `include-empty` warning.
* Files are processed in listed order; glob matches are processed alphabetically. A file is processed **at most once** (a second include is an `include-cycle` error).
* Sprites are listed in processing order: first the root file's own sprites, then those of the includes.

### 2.4 `defaults`

Values a sprite inherits when it does not set them itself.

| Field            | Meaning |
|------------------|---------|
| `spec`           | Default requirements (see 2.7). |
| `target`/`targets` | Default targets, usually a **template** such as `assets/{id}.png` (see 3). |
| `required`       | Default for `required`. |
| `tags`           | Default tags. |
| `notes`          | Default notes. |

**Layering order** (later wins): root `defaults` → this file's `defaults` (included files only) → `folders.<path>.defaults`
for every ancestor folder of the sprite, outermost first → the sprite's own fields.
`spec` is merged **key by key**; every other field is **replaced as a whole** (a sprite's `targets` replace the defaults' `targets`, they do not append).

### 2.5 `folders`

A mapping `folder path -> metadata`. Folders exist implicitly: the part of a sprite `id` before its last `/` is its folder, and
every prefix of that path is a folder too (`characters/hero/idle` lives in `characters/hero`, which lives in `characters`).
You only declare a folder to give it a nicer look or defaults.

| Field         | Meaning |
|---------------|---------|
| `title`       | Display name (default: humanized last path segment). |
| `description` | Explains the folder in the UI; use it for rules shared by all its sprites. |
| `icon`        | One emoji / symbol. |
| `defaults`    | Same shape as 2.4. Applies to every sprite in this folder **and below**. |

A folder may be declared only once across all files (`duplicate-folder`). Declared folders appear in the UI in declaration order, before undeclared ones, always followed by their children.

### 2.6 `sprites[]`

| Field         | Type            | Default | Meaning |
|---------------|-----------------|---------|---------|
| `id`          | string          | **required** | Unique identifier and UI location. Slash-separated segments of `A-Z a-z 0-9 _ . -`, each starting with a letter or digit. Example: `characters/hero/idle`. May contain `{vars}` when `matrix` is used. |
| `description` | string          | **required** | **What the image must show.** Write it so that someone who has never seen the app can create the image (subject, pose, colours, perspective, mood, what must *not* be in it). Shown on the card of a missing sprite. |
| `title`       | string          | humanized last id segment | Card headline. |
| `required`    | boolean         | `true`  | `false` = optional: listed and uploadable but not part of the 100 % progress goal. |
| `spec`        | mapping         | `{}`    | Requirements (2.7). Merged over defaults. |
| `target`      | string/mapping  | -       | One destination (shorthand for a one-item `targets`). |
| `targets`     | list            | inherited | Destinations (3). At least one must exist after inheritance (`no-targets` error). |
| `matrix`      | mapping         | -       | Expands this entry into many sprites (4). |
| `tags`        | list of strings | `[]`    | Free-form labels, searchable in the UI. |
| `notes`       | string          | `""`    | Extra hints (animation timing, where it is used, things to avoid). |
| `reference`   | string          | `""`    | A URL or text pointing at a style reference. |

Use `target` **or** `targets`, never both.
Strings are trimmed, so YAML folded scalars (`>`) are fine for long descriptions.

### 2.7 `spec`: requirements for the image

All keys optional. Constraints are checked on upload **and** continuously against files already on disk.

| Key         | Type    | Meaning |
|-------------|---------|---------|
| `width`, `height` | int ≥ 1 | Exact size in pixels. |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | int ≥ 1 | Size ranges. |
| `aspect`    | `"W:H"` | Required aspect ratio, e.g. `"1:1"`, `"16:9"`. Exact integer comparison. |
| `multipleOf`| int ≥ 1 | Both dimensions must be multiples of this (tile grids: `8`, `16`). |
| `formats`   | list    | Allowed formats from `png`, `jpg` (`jpeg` accepted), `webp`, `gif`, `svg`. **Default: the formats of the target file extensions.** |
| `alpha`     | `required` \| `forbidden` \| `any` | `required` = the file must contain a transparency channel (PNG with alpha/tRNS, WebP with alpha, SVG); `forbidden` = it must be opaque. Default `any`. For GIF the alpha state cannot be determined cheaply and only produces a warning. |
| `maxBytes`  | int ≥ 1 | Maximum file size in bytes. |
| `strict`    | boolean | Default `true`. `false` turns **all** violations of this spec into warnings: the upload is accepted, the sprite counts as available, and the UI shows the warning. |

Always-on checks (not configurable): the content must be a real image whose detected format matches the **file extension of every target**
(`target … needs a PNG file but you uploaded WEBP`), and SVGs containing `<script>`, event-handler attributes or `<foreignObject>` are rejected.
The tool never resizes, converts or edits images: **what you upload is what is delivered, byte for byte.**

## 3. Targets: where an image is delivered

```yaml
target: assets/sprites/hero.png                 # shorthand
targets:                                        # one upload, several destinations
  - assets/sprites/hero.png
  - path: web/public/img/hero.png               # long form, with an optional label
    label: Website copy
```

* A target is a **relative path with forward slashes** and **must end in** `.png .jpg .jpeg .webp .gif .svg`.
* It is resolved against `project.root` and **may not leave it**: no absolute paths, no `..` (`target-escape`).
* Missing directories are created on upload.
* No two sprites may claim the same path (`target-conflict`), and a sprite may not list a path twice (`duplicate-target`).
* **Templates:** target paths (and `label`, `title`, `description`, `notes`, `tags`, `reference`) may contain placeholders:

| Placeholder | Value |
|-------------|-------|
| `{id}`      | Full sprite id, e.g. `characters/hero/idle` |
| `{name}`    | Last id segment, `idle` |
| `{folder}`  | Id without the last segment, `characters/hero` |
| `{var}` / `{var:02}` | Value of a `matrix` variable; `:0N` zero-pads numbers to N digits |
| `{{` / `}}` | Literal `{` / `}` |

  So `defaults: { targets: ["assets/{id}.png"] }` makes every sprite deliver to `assets/<its id>.png` without repeating itself.
  An undefined placeholder is an `unknown-placeholder` error.

### Sprite status (computed, never stored)

For each sprite, every target is checked on disk:

| Status      | Meaning | Counts as done |
|-------------|---------|:--------------:|
| `missing`   | No target file exists. | no |
| `partial`   | Some target files exist, others do not (e.g. a copy was deleted). The UI offers **Sync targets**. | no |
| `invalid`   | A file exists but violates the spec / is not an image / has the wrong format for its extension. | no |
| `available` | All target files exist and pass every `strict` check. | **yes** |

**Progress** = `available required sprites / required sprites` (if a scope has no required sprites, all sprites are counted). The same figure is computed per folder, including sub-folders.

## 4. `matrix`: one entry, many sprites

```yaml
sprites:
  - id: characters/hero/walk-{dir}-{frame:02}
    description: The hero walking {dir}, frame {frame} of 4 of a looping cycle.
    matrix:
      dir: [down, up, left, right]      # explicit list
      frame: "0..3"                     # inclusive integer range -> 0,1,2,3
    target: characters/hero/walk_{dir}_{frame:02}.png
```

produces the Cartesian product (4 × 4 = 16 sprites), e.g. id `characters/hero/walk-left-03`, target `characters/hero/walk_left_03.png`.

* Variable names: `[a-z][a-z0-9_]*`, not `id`, `name` or `folder`.
* Values: non-empty strings or numbers, no duplicates; or a range string `"a..b"` with `a ≤ b`.
* Maximum 5000 sprites per entry.
* Every expanded id must still be valid and unique, and every target unique.
* Each expanded sprite receives defaults according to **its own** folder.

## 5. Validation rules and diagnostics

`sprite-admin validate` (and the UI banner) report diagnostics `{level, code, file, pointer, message}`.
`pointer` is a JSON Pointer into the file (`/sprites/3/spec/width`). **Errors** make the offending sprite (or file) *not load*; a contract with errors
is shown but `validate` exits with 1. **Warnings** never block.

| Code | Level | Meaning |
|------|-------|---------|
| `manifest-missing`, `file-unreadable`, `parse-error` | error | Cannot find/read/parse a file. |
| `invalid-type`, `invalid-value` | error | Field has the wrong type or an out-of-range value. |
| `missing-version`, `unsupported-version` | error | `contract` absent or major version ≠ 1. |
| `missing-project` | error | Root manifest without `project.name`. |
| `invalid-id`, `duplicate-id`, `duplicate-folder` | error | Bad or repeated identifiers. |
| `missing-description` | error | Sprite without a non-empty `description`. |
| `no-targets`, `target-escape`, `target-extension`, `duplicate-target`, `target-conflict`, `target-format-mismatch` | error | Problems with destinations (e.g. `spec.formats` excludes a target's extension). |
| `unknown-placeholder`, `invalid-matrix` | error | Template/matrix problems. |
| `include-missing`, `include-cycle`, `include-depth`, `invalid-include` | error | Include problems. |
| `unknown-key`, `ignored-project`, `include-empty`, `empty-folder` | warning | Probably a mistake, but harmless. |

## 6. Status report (machine-readable output)

`sprite-admin status --json` prints a report that other programs and AIs can consume (CI, dashboards, "what is left to draw?" agents).
`--check` additionally exits with code **2** if any required sprite is not `available` or the contract has errors.

```jsonc
{
  "report": "1.0",
  "project": { "name": "Dungeon Dash", "description": "…", "backups": true },
  "generatedAt": "2026-11-21T10:00:00.000Z",
  "ok": true,                         // false when there are contract errors
  "summary": { "total": 30, "done": 13, "missing": 16, "partial": 0, "invalid": 1,
               "requiredTotal": 29, "requiredDone": 13, "percent": 45 },
  "folders": [ { "id": "characters", "title": "Characters", "depth": 1, "total": 20, "done": 10, "percent": 50, "…": "…" } ],
  "sprites": [{
    "id": "tiles/wall/brick", "folder": "tiles/wall", "title": "Brick", "description": "Dark brick wall …",
    "required": true, "tags": ["pixel-art"], "spec": { "width": 16, "height": 16, "formats": ["png"], "alpha": "forbidden", "strict": true },
    "status": "invalid",              // missing | partial | invalid | available
    "targets": [{ "path": "tiles/wall_brick.png", "exists": true, "format": "png", "width": 20, "height": 16,
                  "issues": [{ "level": "error", "code": "width", "message": "width is 20px, must be exactly 16px" }] }],
    "issues": [ /* flattened list incl. "target" */ ]
  }],
  "diagnostics": []
}
```

## 7. HTTP API of the reference tool (for integrations)

All `POST` requests must send the header `X-Sprite-Admin: 1` (CSRF protection). The server binds to `127.0.0.1` by default.

| Method & path | Purpose |
|---------------|---------|
| `GET /api/state` | The full status report (6). The contract is re-read on every call, so edits show up immediately. |
| `GET /api/image?id=<sprite id>` | The first existing target file of the sprite. |
| `POST /api/upload?id=<sprite id>` | Body = raw image bytes. Validates, backs up, writes all targets. `200 {ok:true, warnings, sprite}` or `4xx {ok:false, errors:[…]}`. Nothing is written on failure. |
| `POST /api/sync?id=<sprite id>` | Copies the first valid target file to every missing/invalid target. |

## 8. Complete example

Root `sprites.contract.yml`:

```yaml
contract: "1.0"
project: { name: Dungeon Dash, description: "16-bit pixel art, top-down.", root: game }
include: [contracts/*.yml, contracts/*.json]
defaults:
  spec: { alpha: required, formats: [png] }
folders:
  characters: { title: Characters, icon: "🧙", defaults: { spec: { width: 32, height: 32 } } }
```

`contracts/characters.yml`:

```yaml
contract: "1.0"
sprites:
  - id: characters/hero/portrait
    description: Close-up face of the hero, looking slightly right, for dialogue boxes.
    spec: { width: 64, height: 64 }
    targets:
      - characters/hero/portrait.png
      - { path: ui/dialogue/hero_portrait.png, label: Dialogue box copy }
```

The same sprite as JSON (`contracts/characters.json`):

```json
{ "contract": "1.0",
  "sprites": [{ "id": "characters/hero/portrait",
    "description": "Close-up face of the hero, looking slightly right, for dialogue boxes.",
    "spec": { "width": 64, "height": 64 },
    "targets": ["characters/hero/portrait.png", { "path": "ui/dialogue/hero_portrait.png", "label": "Dialogue box copy" }] }] }
```

A complete, working multi-file example lives in [`examples/dungeon-dash`](../examples/dungeon-dash).

## 9. Design rules and compatibility

* **Versioning:** `contract: "1.x"` files are forward compatible within the major version. New optional keys may be added in minor versions; old tools warn about unknown keys instead of failing.
* **Stable ids:** an `id` is the sprite's identity. Renaming it is "delete + add" as far as tooling is concerned; the delivered files are tied to `targets`, not to ids.
* **Moving a target** leaves the old file in place; delete it yourself.
* **Source of truth is the file system.** Deleting a delivered file makes the sprite `missing` again.
* **Safety:** targets cannot escape `project.root`; uploads are limited to 50 MB; SVGs are screened for active content.
* **JSON Schema:** [`schema/sprite-contract.schema.json`](../schema/sprite-contract.schema.json) describes the structure of any contract file (use it for editor completion: `# yaml-language-server: $schema=…`). It cannot express cross-file rules; `sprite-admin validate` is authoritative.
