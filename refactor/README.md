# refactor

Architecture rules a repository declares, enforced where Claude edits, plus code-smell notes and a refactoring catalog keyed to [refactoring.guru](https://refactoring.guru/refactoring).

Design rule (same as harness): a check that is deterministic and unambiguous **refuses**; a heuristic one only adds a **note**, and is promoted once its false positives have been measured.

## Architecture (refuses)

Opt-in per repository: without `<repo>/.claude/architecture.json` (the `archFile` option) nothing is refused.

```json
{
  "layers": [
    { "name": "domain", "paths": ["src/domain/**"] },
    { "name": "app",    "paths": ["src/app/**"] },
    { "name": "infra",  "paths": ["src/infra/**"] },
    { "name": "api",    "paths": ["src/api/**"] }
  ],
  "allow": { "api": ["app", "domain"], "app": ["domain"], "infra": ["domain", "app"], "domain": [] },
  "packages": { "@/": "src/", "intrect_platform": "src/intrect_platform" },
  "forbidImports": [{ "layer": "domain", "pattern": "^(fastapi|sqlalchemy|requests)" }],
  "smells": { "maxFunctionLines": 60, "maxParams": 5, "maxNesting": 4, "maxFileLines": 600, "minDuplicateLines": 6 }
}
```

- `layers`: globs relative to the repo root (`**` any depth, `*` one segment; `dir/**` also matches `dir`). A file in no layer is not judged.
- `allow`: the other layers a layer may import. Imports inside a layer are always allowed. A layer with no entry is not judged.
- `packages`: import prefixes that point into the repo, so non-relative imports can be judged (TS path aliases, Python top-level packages, other crates of a workspace).
- `forbidImports`: a regex on the import as written, refused in that layer whatever it resolves to (keeps frameworks out of the domain).
- A malformed part is dropped and named (at session start and in `/arch`); it never refuses on a guess.

**When it refuses.** An `Edit` or `Write` whose result *adds* an import that breaks a rule. The hook rebuilds the file as the edit would leave it (current text plus `old_string` → `new_string`, `replace_all` and an `edits` array honored), and compares its violations with the file's current ones, so an old violation never blocks an unrelated edit. The refusal names the layers, what the layer may import, and the refactorings that fix it (Move Method, Extract Interface for dependency inversion).

**What it resolves.** Only imports it can resolve without guessing:
- TS/JS: `./`, `../`, and prefixes under `packages`. `import`, `export … from`, `require()`, `import()`.
- Python: relative `from .x import y` (submodule names included) and packages under `packages`.
- Rust: `crate::`, `super::`, `self::` within the file's crate (the last `src/` of its path), `use` trees expanded; other crates only under `packages`. `mod x;` declarations are not imports.
- Anything else (npm/PyPI packages, external crates, undeclared aliases) gets no verdict. A TS import that looks like an undeclared alias (`@/`, `~/`, `#`, `src/`) gets a note asking to declare it.

**Not covered at edit time.** Writes through Bash (`sed -i`, `cat >`, `git apply`, `mv`) never reach Edit/Write. The stop audit catches them afterwards, as a note. Import cycles need the whole graph, so they are reported by `/arch audit`, never refused.

The layers and allow list are given to the model once at session start, so it knows the rules before its first edit.

## Smell notes (notes only)

After an Edit/Write of a TS/JS, Python or Rust file, the functions the edit touched are measured: Long Method, Long Parameter List (`self`/`cls` not counted), deep nesting, a large file, and runs of identical lines (Duplicate Code). Each note names the smell, its refactoring.guru link and the first refactorings to apply. Function boundaries come from brace matching or indentation, not a parser, so counts can be a few lines off. Magic numbers are not flagged: too noisy without a parser.

## Stop audit and model review

- `stopAudit` (on): when a turn ends, files changed since `HEAD` (and untracked ones) are checked against the architecture file. Each violation is noted once per session.
- `llmReview` (off): when a turn ends with a diff, haiku reviews up to 12k characters of `git diff HEAD` against the smell catalog and adds at most five findings as a note. Once per distinct diff. It never gates anything.

## `/arch`

| command | does |
|---|---|
| `/arch` | toggles and the declared rules |
| `/arch audit` | every layer violation, layer cycles, file import cycles (Tarjan), smell counts |
| `/arch init` | a draft `architecture.json` from directory names (domain/core, app/services, infra/db, api/routes…); prints it, writes nothing |
| `/arch catalog [name]` | the smell → refactoring catalog, or one smell or technique with links |
| `/arch on\|off arch\|smells\|stop-audit\|llm-review` | switch a feature, kept across sessions |

The command is `/arch`, not `/refactor`, so it does not collide with a user command named `refactor`.

## Skill

`refactor-catalog`: the refactoring procedure (safety net first, a worktree, name the smell, pick the smallest technique, one step at a time with the tests after each, no behavior change riding along).

## Catalog and licensing

`hooks/catalog.ts` holds refactoring.guru's taxonomy: 23 smells in 5 groups and 66 techniques in 6 groups, by name and canonical URL. Every one-line description is our own wording; the site's text is not reproduced.

## Develop

```sh
claude plugin validate refactor
claude plugin test refactor
```
