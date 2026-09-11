# Deterministic review batches

When explicitly enabled, large reviews use one conversation per related group, per skill/model lane. Reviews with fewer than 24 prepared blocks keep the existing per-hunk execution. The planner runs after scan limits, ignores, splitting, coalescing, and context expansion. It never calls a model.

```toml
[defaults.chunking.grouping]
enabled = true
minChunks = 24
maxFiles = 8
maxPromptChars = 48000
```

Grouping is disabled by default. The table above opts in. Alternatively, set `WARDEN_GROUPING_ENABLED=true` in the caller's environment. An explicit per-skill/defaults grouping configuration takes precedence over the environment, including `enabled = false`. The threshold and size limits above are defaults. The oh-review-ci workflow sets the environment flag; standalone Warden does not enable it implicitly.

## Planning and context

The planner sorts by path and starting line. It favors resolved definition/reference relationships, then the same file, explicit imports, the same directory, and common directory prefixes. Equal scores preserve sorted input order. It uses a partial dependency graph, not a complete type checker or runtime call graph.

Each original block belongs to exactly one group. Related definitions, including unmodified definitions, may also appear as context in other groups, subject to the same bounds. Context-only definitions do not receive coverage or findings from those groups. Agents retain their existing read-only checkout tools and can inspect omitted definitions and other repository files.

### Syntax and dependency extraction

Lezer's Python and JavaScript/TypeScript grammars ship inside the JavaScript bundle. They require no native parser, Python subprocess, or grammar asset at runtime. `syntax.ts` normalizes their syntax trees into an AST of definitions, lexical bindings, imports, and references. `dependencies.ts` resolves those facts and maps them to prepared blocks. The conversation executor does not depend on either parser.

The analyzer recognizes Python classes, functions and methods, JavaScript/TypeScript classes, functions, named function expressions, arrow functions, enums and type declarations, plus JSX component references. It resolves direct imports and aliases, relative modules, inheritance references, class-qualified methods, `self`/`cls`/`this`, simple constructor assignments, and simple parameter type annotations. Calls elsewhere in the enclosing modified definition can also link its block. Class constants link to the containing class contract, including enum base changes.

Comments and string literals do not create symbol dependencies. Unknown receivers, shadowed or multiply assigned bindings, syntax errors, unsupported languages, wildcard imports, CommonJS, re-exports, project path aliases, and dynamic type resolution do not receive guessed symbol links. Direct module imports and path proximity remain available where recognized. A missing symbol edge does not mean that no dependency exists. This is syntax-guided grouping, not proof that groups are semantically independent.

Sources come from the same working tree, Git index, or recorded Git revision used for diff context. Reads cover at most 512 selected files and 256 additional candidate paths for direct imports, without recursive crawling. Each file is limited to 1 MB and the source inventory to 16 MB. Trees deeper than 128 nodes fall back to path grouping. Working-tree reads reject paths and symlinks outside the checkout. Parsed facts are cached by filename, language and source digest, with at most 128 entries. Changes to the file invalidate reuse.

An unmodified definition contributes up to 120 source lines; longer definitions contribute their first 16 lines as context. Prompt and file limits still apply. Deleted definitions with no matching head syntax retain path-based grouping.

`maxPromptChars` counts the initial system and user prompts, including the rubric, PR context, surrounding lines, target blocks, and shared definitions. It is a character bound, not an exact token limit. It does not include tool schemas or subsequent tool results. An original block that exceeds the bound stays a singleton without additional references; no code is truncated by the planner. Existing splitting and runtime context/turn limits still apply.

## Execution and coverage

The execution boundary is `ReviewUnit`: a single hunk or a group of target blocks. Both the SDK runner and CLI/action task runner use this contract. A unit reserves one slot in the shared queue. There is no shared promise coordinator between files.

`syntax.ts` and `dependencies.ts` own syntax extraction and dependency resolution. `batches.ts` owns deterministic planning. `analyzeReviewUnit` owns a single runtime conversation. `review-files.ts` adapts unit results to the existing file reports and progress callbacks. The legacy `analyzeFile` path remains available for disabled grouping and small reviews; it does not load or parse dependency sources. Progress starts on queue dispatch, including when concurrency is one.

The model returns `findings` followed by `reviewedBlocks`, listing the stable target block IDs it finished. Missing or malformed acknowledgements mark the affected blocks failed. An extraction fallback cannot certify coverage. This declaration detects omissions; it is not proof of analysis quality.

Finding paths must match a target path. Finding ranges must fit an original hunk inside that target, excluding gaps introduced by coalescing. Context-only definitions cannot become finding targets. Completed findings survive another group's failure. Queued grouped blocks cancelled before execution receive explicit failure records.

Chunk JSONL records include `batchId` and `blockId`. Existing per-file counts, findings, and failure reports remain available. Group usage and its conversation trace are attributed once, to the first target block. Other members have zero attributed usage; this does not mean they incurred no analysis cost. Sum usage across the lane rather than interpreting individual file cost as an independent call.

Post-processing, verification, and deduplication retain their existing execution and budgets.

## Provider cache and retries

Pi sessions remain independent. Group prompts put stable instructions and sorted PR context before target-specific text. An existing OpenAI `prompt_cache_key` is replaced with a hash of checkout path, configured model, system prompt, and tools. Provider opt-out payloads and non-OpenAI payloads remain unchanged. Session IDs, previous response IDs, and transcripts are not shared. The provider still requires a matching prefix and compatible routing; the key does not guarantee a hit.

Pi already enables Anthropic ephemeral caching by default. This change does not request longer retention, copy tool results between agents, or cache review conclusions.

For skill calls, Pi's agent retry loop is bounded to one retry in the same conversation, while SDK provider retries remain disabled. After an exhausted HTTP timeout, Warden records `request_timeout` without opening the provider-wide circuit or restarting the Pi conversation. The oh-review-ci preload supplies the actual HTTP idle/absolute deadlines. Other callers still need their own transport deadlines.

## Local replay, 2026-09-10

The planner was replayed over the original scanned surfaces of Ouihelp API PRs, with 20 context lines read from the recorded head commits and the correctness rubric. This was a planning replay, not an LLM quality benchmark. Other rubrics and PR metadata can change the precise group count.

| PR | Head | Files | Original blocks per lane | Groups per lane | Conversations across 4 lanes |
| --- | --- | ---: | ---: | ---: | ---: |
| #13373 | `a0e6bd54ec208a248a23eee8630162db55748718` | 72 | 77 | 13 | 308 → 52 |
| #13392 | `71cd35736a9b8c2d33f28b1d351d0e5e7874ca07` | 85 | 91 | 13 | 364 → 52 |

The syntax-guided replay loaded 168 and 163 source files, respectively. It linked 64 and 71 target blocks to definitions and included 47 and 34 reference contexts. Source reads, parsing, graph construction and planning took about 9.7 and 8.3 seconds against the historical Git objects. No oversized singleton was needed. Maximum initial prompts were 47,875 and 47,904 characters. These timings include local Git subprocesses and are not production latency measurements.

Measure actual cost, cached input, completion rate, findings, and latency after releasing the fork. Conversation reduction alone does not establish equivalent detection quality or proportional cost savings.
