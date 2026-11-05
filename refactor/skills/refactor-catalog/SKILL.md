---
name: refactor-catalog
description: Behavior-preserving refactoring by the refactoring.guru catalog. Use when asked to refactor, clean up, restructure or reduce the complexity of code, when a refactor mod note names a smell (Long Method, Long Parameter List, Duplicate Code...), or when an architecture rule refused an import and the code must move or its dependency be inverted.
---

# Refactoring by the catalog

Refactoring changes structure, never behavior. Each step is small, named, and
followed by the tests. The taxonomy is refactoring.guru's
(https://refactoring.guru/refactoring); `/arch catalog` prints every smell with
its refactorings, and `/arch catalog <name>` one smell or technique with links.

## 0. Before touching code

1. Find the safety net: the repo's test command (CLAUDE.md, README, CI config).
   Run it and record the result. With no tests covering the code, write
   characterization tests for its current behavior first, or stop and say so.
2. Work in a worktree under `<repo>/worktrees/<name>` on its own branch (never a
   `git stash` + branch switch in the main checkout).
3. Read `.claude/architecture.json` if it exists (`/arch` shows it). The
   refactor mod refuses edits that add imports breaking it.

## 1. Name the smell

Use `/arch audit` for the repo-wide picture (layer violations, import cycles,
the largest smells), or the notes the mod adds after an edit. Name each problem
by its catalog smell; a problem without a name is not ready to be refactored.

| group | smells |
|---|---|
| Bloaters | Long Method, Large Class, Primitive Obsession, Long Parameter List, Data Clumps |
| Object-Orientation Abusers | Switch Statements, Temporary Field, Refused Bequest, Alternative Classes with Different Interfaces |
| Change Preventers | Divergent Change, Shotgun Surgery, Parallel Inheritance Hierarchies |
| Dispensables | Comments, Duplicate Code, Lazy Class, Data Class, Dead Code, Speculative Generality |
| Couplers | Feature Envy, Inappropriate Intimacy, Message Chains, Middle Man, Incomplete Library Class |

## 2. Pick the technique

`/arch catalog <smell>` lists the refactorings that cure it. Choose the
smallest that removes the smell. Common pairs:

- Long Method → Extract Method; Decompose Conditional; Replace Method with Method Object when locals are tangled.
- Long Parameter List / Data Clumps → Introduce Parameter Object; Preserve Whole Object.
- Deep nesting → Replace Nested Conditional with Guard Clauses.
- Switch Statements on a type → Replace Conditional with Polymorphism; Replace Type Code with State/Strategy.
- Feature Envy / Shotgun Surgery → Move Method, Move Field.
- Duplicate Code → Extract Method, then Pull Up Method or Form Template Method across classes.
- A layer importing an outer layer (an architecture refusal) → Move Method to the layer that owns the code, or Extract Interface in the inner layer and implement it in the outer one (dependency inversion).

## 3. Apply in steps

One technique per step. After each step:

1. Run the tests. Green → go on. Red → undo that step, do not fix forward.
2. No behavior change rides along: a bug found during refactoring is noted and
   fixed in its own commit, after the refactoring.
3. Public names and signatures change only with every caller updated in the
   same step (search for callers first).

## 4. Report

List the smells removed with the technique used for each, the test command and
its result before and after, and anything left as is with the reason.
