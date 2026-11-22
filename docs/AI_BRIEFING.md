# Sprite Contract + sprite-admin: briefing for an AI (self-contained)

## 1. What this is
**Sprite Contract** is a file-based standard by which an application declares every image ("sprite") it needs:
what each shows, the technical requirements, and the file paths where each must be delivered.
**sprite-admin** (Node.js, `bin/sprite-admin.js`) reads the contract and
- shows each sprite as `missing`, `partial`, `invalid` or `available` with progress bars (overall and per folder),
- shows the description for every missing sprite,
- accepts image uploads (web UI, drag and drop, bulk drop, or HTTP), validates them against the sprite's requirements,
  and copies the file to **every target path** the contract lists.

It is not an image editor. It never resizes, converts or edits; uploaded bytes are delivered unchanged.
The file system is the source of truth (no database): deleting a delivered file makes the sprite `missing` again.
The application never needs to know the tool exists; it just loads images from the paths it declared.

Your possible jobs: (A) **write/maintain a contract** for an app, (B) **produce images** for missing sprites, (C) **consume status** in CI/agents.

## 2. Files
- One **root manifest** named `sprites.contract.yml` (or `.yaml` / `.json`), found in the project dir.
- Any number of **included files** (YAML or JSON, mixed freely), pulled in by `include` globs. Included files are self-contained documents, so several people/AIs can add files in parallel.
- Every file starts with `contract: "1.0"`. Only the root has `project`.

## 3. Document structure (every key)
Top-level keys: `contract` (required everywhere), `project` (root only, required), `include`, `defaults`, `folders`, `sprites`, `$schema` (ignored). Unknown keys only warn (with a "did you mean" hint).

### project (root only)
| key | default | meaning |
|---|---|---|
| `name` | required | app name |
| `description` | "" | art style, palette, perspective, mood; shown in the UI header |
| `root` | "." | directory all targets are relative to (relative to the manifest) |
| `backups` | true | copy overwritten files to `<root>/.sprite-admin/backups/<timestamp>/` |

### include
String or list of paths/globs relative to the containing file (`*`, `**`, `?`). Plain paths must exist; globs matching nothing warn. Order: listed order, glob matches alphabetical. A file is processed once (repeat = `include-cycle`). Max nesting 8.

### defaults (root: whole project; included file: that file only)
Keys: `spec`, `target`/`targets`, `required`, `tags`, `notes`.
**Layering, later wins:** root defaults -> file defaults -> `folders.<path>.defaults` for each ancestor folder (outermost first) -> the sprite. `spec` merges key by key; all other keys are replaced wholesale.

### folders
Map of folder path -> `{title, description, icon, defaults}`. Folders exist implicitly from sprite ids (every prefix of `a/b/c`'s directory part: `a`, `a/b`). Declare one only for a nicer title/icon/description or for folder-wide defaults (applies to the folder and below). Declare each folder once overall. Declared folders are listed first in declaration order; children always follow their parent.

### sprites[]
| key | default | meaning |
|---|---|---|
| `id` | required | unique across ALL files; `/`-separated segments of `[A-Za-z0-9_.-]`, each starting alphanumeric; text before the last `/` is the folder. May contain `{vars}` with `matrix`. |
| `description` | required | what the image must show; a missing/empty one makes the sprite not load |
| `title` | humanized last id segment | card headline |
| `required` | true | false = optional, listed but not needed for 100% |
| `spec` | {} | requirements (below) |
| `target` / `targets` | inherited | where to deliver; use one or the other; at least one needed after inheritance |
| `matrix` | none | expand into many sprites |
| `tags` | [] | labels, searchable |
| `notes` | "" | extra hints |
| `reference` | "" | URL or text of a style reference |
Strings are trimmed (YAML `>` folded text is fine).

### spec (all optional)
`width`, `height` (exact px); `minWidth`, `maxWidth`, `minHeight`, `maxHeight`; `aspect` ("W:H", e.g. "1:1"); `multipleOf` (both dimensions); `formats` (list of `png jpg webp gif svg`; default = formats of the target extensions; every target extension must be in it); `alpha` (`required` | `forbidden` | `any`, default any; GIF alpha only warns); `maxBytes`; `strict` (default true; false = all violations of this spec become warnings and the upload is accepted).
Always enforced: content must be a real image whose format matches the extension of every target; SVGs with `<script>`, `on*=` handlers or `<foreignObject>` are rejected. An invalid spec value is an error and the sprite does not load.

### targets
`target: path.png`, or `targets: [path.png, {path: other.png, label: "Copy"}]`. Relative, forward slashes, must end in `.png .jpg .jpeg .webp .gif .svg`, resolved against `project.root`, must not leave it (no `..`, no absolute paths, no backslashes). Directories are created on upload. No path may be claimed by two sprites or listed twice. One upload is written to all targets (all targets of one sprite must therefore share a format).

### placeholders (in target paths, label, title, description, notes, tags, reference)
`{id}`, `{name}` (last segment), `{folder}`, `{var}` / `{var:02}` (matrix var, zero-padded), `{{` / `}}` literal braces. Undefined placeholder = `unknown-placeholder` error. Template defaults like `defaults: {targets: ["assets/{id}.png"]}` let sprites omit targets.

### matrix
`matrix: {dir: [down, up, left, right], frame: "0..3"}`: Cartesian product, one sprite per combination. Var names `[a-z][a-z0-9_]*` (not `id`, `name`, `folder`); values are non-empty strings/numbers without duplicates, or an inclusive integer range string; max 5000 combinations. Each expanded id/target must stay valid and unique, so every var that matters must appear in the `id` and targets. Each expanded sprite takes defaults from its own folder.

## 4. Status semantics (computed from disk each time)
`missing` no target file; `partial` some exist; `invalid` a file exists but breaks spec/format/not an image; `available` all targets exist and pass strict checks. Only `available` counts as done. Progress = done required / total required (if none are required, all sprites). Computed per folder including subfolders.

## 5. Diagnostics (`validate`, UI banner)
Each: `{level, code, file, pointer (JSON Pointer), message}`. Errors drop the offending sprite/file; warnings never block.
Errors: `manifest-missing file-unreadable parse-error invalid-type invalid-value missing-version unsupported-version missing-project invalid-id duplicate-id duplicate-folder missing-description no-targets target-escape target-extension duplicate-target target-conflict target-format-mismatch unknown-placeholder invalid-matrix include-missing include-cycle include-depth invalid-include`.
Warnings: `unknown-key ignored-project include-empty empty-folder`.

## 6. CLI
```
sprite-admin [serve] [contract] [--port 4870] [--host 127.0.0.1]   web UI
sprite-admin validate [contract]          exit 1 on errors
sprite-admin status [contract] [--json] [--missing] [--check]   --check: exit 2 if required sprites missing or contract errors
sprite-admin init [dir]                    scaffold a starter contract
```
`[contract]` = file or directory (default `.`). Run from the repo: `node bin/sprite-admin.js ...`.

## 7. Machine interfaces
`status --json` and `GET /api/state` return:
`{report:"1.0", project, generatedAt, ok, summary:{total,done,missing,partial,invalid,requiredTotal,requiredDone,percent}, folders:[{id,title,depth,total,done,percent,...}], sprites:[{id,folder,title,description,required,tags,notes,spec,status,targets:[{path,exists,format,width,height,issues[]}],issues[]}], diagnostics[]}`.
HTTP (server binds 127.0.0.1; every POST needs header `X-Sprite-Admin: 1`):
- `GET /api/state`: full report, contract re-read each call.
- `GET /api/image?id=<id>`: first existing target.
- `POST /api/upload?id=<id>`: body = raw image bytes (max 50 MB). `200 {ok:true,warnings,sprite}` or `4xx {ok:false,errors:[...]}`; nothing is written on failure.
- `POST /api/sync?id=<id>`: copy the first valid target file to missing/invalid targets.

## 8. Procedure A: write a contract for an app
1. Search the code for every image reference (paths, atlas keys, `<img>`, `url()`, loaders), including planned ones.
2. Create the root manifest: `contract: "1.0"`, `project.name`, art direction in `project.description`, `project.root` so that targets equal the paths the app really loads.
3. More than ~15 sprites: `include: ["contracts/*.yml"]`, one file per domain.
4. Put shared rules in `defaults`/`folders.*.defaults` (formats, alpha, sizes, a `targets` template).
5. Use `matrix` for frames, directions, states, skins.
6. Write concrete descriptions: subject, colours, pose/state, perspective, what is drawn on top, what must not appear. Not file formats or sizes (those go in `spec`).
7. Run `sprite-admin validate` until 0 errors and no warnings. 8. `status --missing` lists the outstanding work.
Keep the contract current: whenever code starts using a new image, add an entry in the same change.

## 9. Procedure B: produce images
`sprite-admin status . --json`; for each sprite with `status != "available"`: read `description` and `spec`, make an image meeting every constraint and the target extension's format, then `POST` the bytes to `/api/upload?id=<id>` on a running `sprite-admin serve`. If rejected, read `errors`, fix, retry.

## 10. Example (multi-file)
`sprites.contract.yml`
```yaml
contract: "1.0"
project: {name: Dungeon Dash, description: "16-bit pixel art, top-down.", root: game}
include: [contracts/*.yml, contracts/*.json]
defaults: {spec: {alpha: required, formats: [png]}}
folders:
  characters: {title: Characters, icon: "🧙", defaults: {spec: {width: 32, height: 32}}}
```
`contracts/characters.yml`
```yaml
contract: "1.0"
sprites:
  - id: characters/hero/walk-{dir}-{frame:02}
    description: The hero (short wizard, blue hat, brown cloak) walking {dir}, frame {frame} of 4 of a looping cycle; feet touch the bottom edge.
    matrix: {dir: [down, up, left, right], frame: "0..3"}
    target: characters/hero/walk_{dir}_{frame:02}.png
  - id: characters/hero/portrait
    description: Close-up face of the hero for dialogue boxes, looking slightly right.
    spec: {width: 64, height: 64}
    targets:
      - characters/hero/portrait.png
      - {path: ui/dialogue/hero_portrait.png, label: Dialogue box copy}
  - id: characters/skeleton/idle
    description: Skeleton warrior with a rusty sword, facing the camera.
    target: characters/skeleton/idle.png
    required: false
```
`contracts/tiles.json`
```json
{"contract":"1.0","defaults":{"spec":{"width":16,"height":16,"alpha":"forbidden"}},
 "sprites":[{"id":"tiles/floor/stone","description":"Grey cobblestone floor, tiles seamlessly.","target":"tiles/floor_stone.png"}]}
```
Full spec: `docs/CONTRACT.md`; JSON Schema: `schema/sprite-contract.schema.json`; working demo: `examples/dungeon-dash`.
