import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Contract pins derived from .corvus/tasks/prompt-modernization/specs/frozen-contracts.md
 * (§C1-C7, §C9 and rubric forbidden patterns).
 *
 * Pins are PER-FILE and byte-derived from the baseline: the mirrored orchestrator
 * pair does NOT carry identical marker sets. Never assert a string against a file
 * that lacked it at baseline.
 *
 * Structure note: one describe block per file group. Phase C/D/E/F/G/H tasks
 * (13, 18, 23, 26, 30, 36) append sections below, reusing the shared helpers.
 */

const ROOT = resolve(import.meta.dir, "../..")

const cache = new Map<string, string>()

/** Read a repo-relative file once, cached (read-only, no shared mutable state). */
const read = (relPath: string): string => {
  let content = cache.get(relPath)
  if (content === undefined) {
    content = readFileSync(resolve(ROOT, relPath), "utf-8")
    cache.set(relPath, content)
  }
  return content
}

/** Assert every pinned string appears verbatim (grep -F semantics, §C9). */
const expectContains = (relPath: string, pins: string[]): void => {
  const content = read(relPath)
  const missing = pins.filter((pin) => !content.includes(pin))
  expect(missing).toEqual([])
}

/** Assert no forbidden string/pattern matches (§C9 forbidden strings). */
const expectAbsent = (relPath: string, patterns: (string | RegExp)[]): void => {
  const content = read(relPath)
  const present = patterns.filter((pattern) =>
    typeof pattern === "string" ? content.includes(pattern) : pattern.test(content),
  )
  expect(present.map(String)).toEqual([])
}

/** Raw frontmatter block: text between the opening and closing `---` lines. */
const frontmatterBlock = (relPath: string): string => {
  const match = read(relPath).match(/^---\n([\s\S]*?)\n---/)
  return match?.[1] ?? ""
}

/** One nested map under a top-level frontmatter key (for mechanical policy checks). */
const nestedFrontmatterBlock = (
  relPath: string,
  key: "bash" | "task",
): string => {
  const lines = frontmatterBlock(relPath).split("\n")
  const start = lines.indexOf(`  ${key}:`)
  if (start === -1) return ""

  const end = lines.findIndex(
    (line, index) => index > start && /^  \S/.test(line),
  )
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n")
}

/** Report every line with trailing spaces/tabs across a controlled file set. */
const expectNoTrailingWhitespace = (relPaths: string[]): void => {
  const offenders = relPaths.flatMap((relPath) =>
    read(relPath)
      .split("\n")
      .flatMap((line, index) =>
        /[ \t]+$/.test(line) ? [`${relPath}:${index + 1}`] : [],
      ),
  )
  expect(offenders).toEqual([])
}

// ============================================================================
// Phase B — Orchestrators (Tasks 02-04)
// ============================================================================

const ORCHESTRATORS = [
  "agent/corvus.md",
  "agent/corvus-auto.md",
  "agent/corvus-review.md",
  "agent/corvus-review-auto.md",
]

describe("prompt contracts: orchestrators", () => {
  describe("frontmatter (§C5)", () => {
    test("frontmatter starts files", () => {
      // §C5.1 - first line SHALL be exactly --- (one bad file kills ALL agent loading)
      for (const file of ORCHESTRATORS) {
        expect(read(file).split("\n", 1)[0]).toBe("---")
      }
    })

    test("auto variants deny question", () => {
      // §C5.8 - QUOTED form is the byte contract; permission system enforces mechanically
      expect(frontmatterBlock("agent/corvus-auto.md")).toContain('question: "deny"')
      expect(frontmatterBlock("agent/corvus-review-auto.md")).toContain(
        'question: "deny"',
      )
    })
  })

  describe("agent/corvus.md", () => {
    test("corvus.md workflow pins", () => {
      // §C1 (requirements gate, plan review gate, plan types, test flags, UX/DX flag), §C6 (paths)
      expectContains("agent/corvus.md", [
        "REQUIREMENTS_CLEAR",
        "QUESTIONS_NEEDED",
        "DISCOVERY_NEEDED",
        "PLAN REVIEW GATE STATUS",
        "OKAY",
        "REJECT",
        "PLAN_TYPE: LIGHTWEIGHT",
        "PLAN_TYPE: STANDARD",
        "PLAN_TYPE: SPEC_DRIVEN",
        "tests_enabled",
        "tests_deferred",
        "**TEST PREFERENCE**",
        "requires_ux_dx_review",
        ".corvus/tasks/",
      ])
    })

    test("corvus.md dispatch markers", () => {
      // §C2 - corvus.md's Phase 3.5 dispatch carries these four markers.
      // Do NOT assert **EXPECTED OUTCOME** or **CONTEXT** (zero matches in agent/ at baseline).
      // Do NOT assert ANY §C2 marker against the other 3 orchestrators (zero §C2 bold
      // markers at baseline — their dispatch templates live in the phase/review skills,
      // pinned per-file in Task 13 (phase-0/1/2/4/5/6/7) and Task 18 (r1/r2/r5)).
      expectContains("agent/corvus.md", [
        "**TASK**",
        "**MUST DO**",
        "**MUST NOT DO**",
        "**REPORT BACK**",
      ])
    })

    test("cross-file section names", () => {
      // §C3 - referenced by name from corvus-phase-0/SKILL.md and corvus-auto.md
      expectContains("agent/corvus.md", ["Plan-Type Selection", "Phase 3.5"])
    })
  })

  describe("agent/corvus-auto.md", () => {
    test("corvus-auto.md workflow pins", () => {
      // §C1, §C6 historical pins. `PLAN REVIEW GATE STATUS` remains absent;
      // Phase H owns the corrected tests_deferred semantics in its scoped
      // preselected-input contract rather than duplicating that pin here.
      expectContains("agent/corvus-auto.md", [
        "REQUIREMENTS_CLEAR",
        "QUESTIONS_NEEDED",
        "DISCOVERY_NEEDED",
        "OKAY",
        "REJECT",
        "PLAN_TYPE: LIGHTWEIGHT",
        "PLAN_TYPE: STANDARD",
        "PLAN_TYPE: SPEC_DRIVEN",
        "tests_enabled",
        "**TEST PREFERENCE**",
        "requires_ux_dx_review",
        "ACCEPTANCE-ONLY",
        ".corvus/tasks/",
      ])
    })
  })

  describe("agent/corvus-review.md + agent/corvus-review-auto.md", () => {
    test("review verdicts present", () => {
      // §C1 - PER-FILE: review-auto carries only the downgrade pair; APPROVE had
      // ZERO case-insensitive matches there at baseline (verdicts expressed via
      // downgrade logic) and SHALL NOT be asserted against it
      expectContains("agent/corvus-review.md", [
        "APPROVE",
        "REQUEST_CHANGES",
        "COMMENT_ONLY",
      ])
      expectContains("agent/corvus-review-auto.md", [
        "REQUEST_CHANGES",
        "COMMENT_ONLY",
      ])
    })

    test("review config path intact", () => {
      // §C6 - corvus-review.md ONLY; review-auto's inline config block never
      // names the yaml path at baseline, so no assertion there
      expectContains("agent/corvus-review.md", [".opencode/review-config.yaml"])
    })
  })

  describe("forbidden patterns (rubric)", () => {
    test("no priority attributes", () => {
      // rubric R3 - XML priority attributes removed by modernization
      for (const file of ORCHESTRATORS) {
        expectAbsent(file, ['priority="'])
      }
    })

    test("no anti-speedrun blocks", () => {
      // Task 03 - baseline had anti-speedrun blocks in BOTH workflow orchestrators
      expectAbsent("agent/corvus.md", [/anti-speedrun/i])
      expectAbsent("agent/corvus-auto.md", [/anti-speedrun/i])
    })
  })

  // Documentation row (frozen-contracts §C1) — intentionally NOT tested here:
  // `**MODE**: LEARNING`, `**TRIGGER**: *`, `**DELEGATED MODE**`, gate-status labels,
  // and `**MODE**: ACCEPTANCE-ONLY` are owned by phase skills / receiver agents.
  // They are pinned in Task 13 against their actual owner files, in their actual
  // bold forms — never against the orchestrators.
})

// ============================================================================
// Phase C — Workflow agents + phase skills (Tasks 06-12)
// ============================================================================

/**
 * The 14 Phase C files = 18 modified files minus the 4 with dedicated suites
 * (agent/researcher.md, skill/web-search, skill/deep-research, skill/corvus-phase-1).
 * Those suites' pins are NOT duplicated here; corvus-phase-1 appears below ONLY
 * in the §C2 dispatch-marker test, which its dedicated suite does not cover.
 */
const PHASE_C_FILES = [
  "agent/task-planner.md",
  "skill/corvus-phase-0/SKILL.md",
  "agent/requirements-analyst.md",
  "agent/code-explorer.md",
  "skill/corvus-phase-2/SKILL.md",
  "agent/plan-reviewer.md",
  "skill/corvus-phase-4/SKILL.md",
  "agent/code-implementer.md",
  "agent/code-quality.md",
  "skill/corvus-phase-5/SKILL.md",
  "skill/corvus-phase-6/SKILL.md",
  "skill/corvus-phase-7/SKILL.md",
  "skill/corvus-extras/SKILL.md",
  "skill/frontend-design/SKILL.md",
]

/** Duplication-resolution D6: corvus-extras owns the complete subagent table. */
const ALL_AGENT_NAMES = [
  "corvus",
  "corvus-auto",
  "corvus-review",
  "corvus-review-auto",
  "task-planner",
  "requirements-analyst",
  "researcher",
  "code-explorer",
  "code-implementer",
  "code-quality",
  "plan-reviewer",
  "ux-dx-quality",
  "pr-code-reviewer",
  "security-reviewer",
  "pr-context-gatherer",
  "pr-comment-writer",
]

describe("prompt contracts: workflow agents + phase skills", () => {
  describe("agent/task-planner.md (Task 06)", () => {
    test("task-planner learning contract", () => {
      // §C1 (learning mode — bold forms are the bytes: bare `MODE: LEARNING`
      // matches nothing repo-wide), §C1 UX/DX Meta form, §C4 status symbols
      expectContains("agent/task-planner.md", [
        "**MODE**: LEARNING",
        "**TRIGGER**: FAILURE_ANALYSIS",
        "**TRIGGER**: SUCCESS_EXTRACTION",
        "Requires UX/DX Review",
        "[ ]",
        "[~]",
        "[x]",
        "[-]",
        "[!]",
      ])
    })

    test("task-planner plan types", () => {
      // §C1, §C6 - do NOT assert `PLAN_TYPE: STANDARD`: ABSENT at baseline
      // (only prose "default to STANDARD"). All three colon-forms live in
      // corvus.md / corvus-auto.md (pinned above) and corvus-phase-0/SKILL.md.
      expectContains("agent/task-planner.md", [
        "PLAN_TYPE: LIGHTWEIGHT",
        "PLAN_TYPE: SPEC_DRIVEN",
        "MASTER_PLAN.md",
      ])
    })
  })

  describe("status-code pairs (Tasks 07/09/10)", () => {
    test("phase-0 pair status codes", () => {
      // §C1 - requirements gate codes + plain mode tokens in BOTH files.
      // Bold dispatch forms live in the SKILL only: the agent uses the
      // receiver forms `### Mode:` / `**Mode**: [...]`, so the bold producer
      // forms are NOT asserted against it.
      const shared = [
        "REQUIREMENTS_CLEAR",
        "QUESTIONS_NEEDED",
        "DISCOVERY_NEEDED",
        "INITIAL_ANALYSIS",
        "POST_DISCOVERY",
      ]
      expectContains("skill/corvus-phase-0/SKILL.md", [
        ...shared,
        "**MODE**: INITIAL_ANALYSIS",
        "**MODE**: POST_DISCOVERY",
      ])
      expectContains("agent/requirements-analyst.md", shared)
    })

    test("phase-2 pair gate strings", () => {
      // §C1 - `PLAN REVIEW GATE STATUS` is a valid substring of the bold
      // `**PLAN REVIEW GATE STATUS**` (markers wrap the whole phrase)
      for (const file of ["skill/corvus-phase-2/SKILL.md", "agent/plan-reviewer.md"]) {
        expectContains(file, ["OKAY", "REJECT", "PLAN REVIEW GATE STATUS"])
      }
    })

    test("phase-2 owns flags table", () => {
      // D4 - the canonical test-flags table lives in the phase-2 skill
      expectContains("skill/corvus-phase-2/SKILL.md", [
        "tests_enabled",
        "tests_deferred",
        "TEST PREFERENCE",
      ])
    })

    test("phase-4 trio gate strings", () => {
      // §C1, §C1.1 - consumers harmonized to the producer's label (Task 10):
      // `QUALITY GATE STATUS` in skill + code-quality.md; the superseded
      // `PHASE GATE STATUS` label SHALL NOT reappear in the skill
      expectContains("skill/corvus-phase-4/SKILL.md", [
        "QUALITY GATE STATUS",
        "ACCEPTANCE-ONLY",
      ])
      expectAbsent("skill/corvus-phase-4/SKILL.md", ["PHASE GATE STATUS"])
      expectContains("agent/code-quality.md", ["QUALITY GATE STATUS", "ACCEPTANCE-ONLY"])
      expectContains("agent/code-implementer.md", ["DELEGATED MODE"])
    })
  })

  describe("structure + ownership (Tasks 08/11/12)", () => {
    test("all phase-C files frontmatter", () => {
      // §C5.1 - first line SHALL be exactly ---; §C5.5 - skill name = dir name
      for (const file of PHASE_C_FILES) {
        expect(read(file).split("\n", 1)[0]).toBe("---")
        if (file.startsWith("skill/")) {
          const dir = file.split("/")[1] ?? ""
          expect(frontmatterBlock(file)).toMatch(new RegExp(`^name: ${dir}$`, "m"))
        }
      }
    })

    test("extras owns subagent table", () => {
      // D6 - corvus-extras carries the complete 16-agent reference table
      expectContains("skill/corvus-extras/SKILL.md", ALL_AGENT_NAMES)
    })

    test("no priority attrs phase-C", () => {
      // rubric R3 - XML priority attributes removed by modernization
      for (const file of PHASE_C_FILES) {
        expectAbsent(file, ['priority="'])
      }
    })

    test("cross-file section names", () => {
      // §C3 - referenced by name from corvus.md and corvus-auto.md
      expectContains("agent/requirements-analyst.md", ["Plan-Type Recommendation"])
    })

    test("phase-skill dispatch markers (§C2)", () => {
      // §C2 - PER-FILE byte-derived: the dispatch templates live in the phase
      // skills, NOT the orchestrators (see Phase B note). Assert ONLY the
      // markers each file carried at baseline — nothing more. Explicit
      // negative guards: phase-2 has NO **CONTEXT**; phase-6 and phase-7
      // have NO **MUST NOT DO**. corvus-phase-1's dedicated suite does not
      // pin §C2 markers, so pinning them here is not a duplication.
      const TASK = "**TASK**"
      const OUTCOME = "**EXPECTED OUTCOME**"
      const MUST_DO = "**MUST DO**"
      const MUST_NOT_DO = "**MUST NOT DO**"
      const CONTEXT = "**CONTEXT**"
      const REPORT_BACK = "**REPORT BACK**"

      expectContains("skill/corvus-phase-0/SKILL.md", [
        TASK,
        MUST_DO,
        MUST_NOT_DO,
        REPORT_BACK,
      ])
      expectContains("skill/corvus-phase-1/SKILL.md", [
        TASK,
        OUTCOME,
        MUST_DO,
        MUST_NOT_DO,
        CONTEXT,
        REPORT_BACK,
      ])
      expectContains("skill/corvus-phase-2/SKILL.md", [
        TASK,
        OUTCOME,
        MUST_DO,
        MUST_NOT_DO,
        REPORT_BACK,
      ])
      expectAbsent("skill/corvus-phase-2/SKILL.md", [CONTEXT])
      expectContains("skill/corvus-phase-4/SKILL.md", [
        TASK,
        MUST_DO,
        MUST_NOT_DO,
        REPORT_BACK,
      ])
      expectContains("skill/corvus-phase-5/SKILL.md", [
        TASK,
        MUST_DO,
        MUST_NOT_DO,
        REPORT_BACK,
      ])
      expectContains("skill/corvus-phase-6/SKILL.md", [TASK, MUST_DO, REPORT_BACK])
      expectAbsent("skill/corvus-phase-6/SKILL.md", [MUST_NOT_DO])
      expectContains("skill/corvus-phase-7/SKILL.md", [
        TASK,
        MUST_DO,
        CONTEXT,
        REPORT_BACK,
      ])
      expectAbsent("skill/corvus-phase-7/SKILL.md", [MUST_NOT_DO])
    })
  })
})

// ============================================================================
// Phase D — Review pipeline: review skills + review agents (Tasks 14-17)
// ============================================================================

const REVIEW_SKILLS = [
  "skill/corvus-review-r0/SKILL.md",
  "skill/corvus-review-r1/SKILL.md",
  "skill/corvus-review-r2/SKILL.md",
  "skill/corvus-review-r3/SKILL.md",
  "skill/corvus-review-r4/SKILL.md",
  "skill/corvus-review-r5/SKILL.md",
  "skill/corvus-review-extras/SKILL.md",
]

const REVIEW_AGENTS = [
  "agent/pr-code-reviewer.md",
  "agent/security-reviewer.md",
  "agent/pr-context-gatherer.md",
  "agent/pr-comment-writer.md",
]

const PHASE_D_FILES = [...REVIEW_SKILLS, ...REVIEW_AGENTS]

describe("prompt contracts: review pipeline", () => {
  describe("structure (§C5)", () => {
    test("review skills frontmatter + names", () => {
      // §C5.1 - first line SHALL be exactly ---; §C5.5 - skill name = dir name
      for (const file of REVIEW_SKILLS) {
        expect(read(file).split("\n", 1)[0]).toBe("---")
        const dir = file.split("/")[1] ?? ""
        expect(frontmatterBlock(file)).toMatch(new RegExp(`^name: ${dir}$`, "m"))
      }
    })

    test("review agents frontmatter", () => {
      // §C5.1 - first line SHALL be exactly ---
      for (const file of REVIEW_AGENTS) {
        expect(read(file).split("\n", 1)[0]).toBe("---")
      }
    })
  })

  describe("schema ownership + handoff boundaries (§C4, D13)", () => {
    test("extras owns review schemas", () => {
      // §C4, D13 - corvus-review-extras is the single owner of the three
      // review-set schemas and the internal verdict vocabulary
      expectContains("skill/corvus-review-extras/SKILL.md", [
        "PR_CONTEXT",
        "REVIEW_CONTEXT",
        "REVIEW_FINDINGS",
        "APPROVE",
        "REQUEST_CHANGES",
        "COMMENT_ONLY",
      ])
    })

    test("intake contracts", () => {
      // §C6 - R0 loads the review config from its canonical path
      expectContains("skill/corvus-review-r0/SKILL.md", [
        ".opencode/review-config.yaml",
      ])
    })

    test("context schema referenced", () => {
      // D13 - r1 consumes PR_CONTEXT and produces REVIEW_CONTEXT; the gatherer
      // speaks only REVIEW_CONTEXT. Do NOT assert PR_CONTEXT against
      // pr-context-gatherer: ZERO matches at baseline — the r1 dispatch/handoff
      // is the contract boundary.
      expectContains("skill/corvus-review-r1/SKILL.md", [
        "PR_CONTEXT",
        "REVIEW_CONTEXT",
      ])
      expectContains("agent/pr-context-gatherer.md", ["REVIEW_CONTEXT"])
    })

    test("findings schema referenced", () => {
      // D13 - r2 assembles REVIEW_FINDINGS from reviewer `### Findings`
      // sections; r3 consumes it. Do NOT assert REVIEW_FINDINGS against
      // security-reviewer: ZERO matches at baseline — r2's assembly is the
      // boundary. The reviewer's own contract is `### Findings` plus the
      // shared severity-label vocabulary.
      expectContains("skill/corvus-review-r2/SKILL.md", ["REVIEW_FINDINGS"])
      expectContains("skill/corvus-review-r3/SKILL.md", ["REVIEW_FINDINGS"])
      expectContains("agent/security-reviewer.md", [
        "### Findings",
        "blocker",
        "critical",
        "major",
        "minor",
        "nitpick",
        "praise",
      ])
    })

    test("verdict strings in output stage", () => {
      // §C1 - r5 owns the verdict→event mapping (all 3 internal verdicts appear
      // in its mapping rows — the contract boundary); pr-comment-writer speaks
      // GitHub event vocabulary only. Do NOT assert COMMENT_ONLY against
      // pr-comment-writer: ZERO matches at baseline.
      expectContains("skill/corvus-review-r5/SKILL.md", [
        "| `APPROVE` | `APPROVE` |",
        "| `REQUEST_CHANGES` | `REQUEST_CHANGES` |",
        "| `COMMENT_ONLY` | `COMMENT` |",
      ])
      expectContains("agent/pr-comment-writer.md", [
        'event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"',
      ])
    })
  })

  describe("dispatch markers + rubric", () => {
    test("review-skill dispatch markers (§C2)", () => {
      // §C2 - PER-FILE byte-derived: these markers live HERE, not in the review
      // orchestrators (see Phase B note / Tasks 04-05). Assert ONLY the markers
      // each file carried at baseline:
      //   r1 — full template EXCEPT **REPORT BACK** (zero matches; do NOT assert);
      //   r2/r5 — ONLY **TASK** / **MUST DO** / **MUST NOT DO**;
      //   r0/r3/r4 — ZERO §C2 bold markers: assert nothing there;
      //   extras — its single **TASK** is an example prompt, not a dispatch
      //   template: not pinned.
      const TASK = "**TASK**"
      const OUTCOME = "**EXPECTED OUTCOME**"
      const MUST_DO = "**MUST DO**"
      const MUST_NOT_DO = "**MUST NOT DO**"
      const CONTEXT = "**CONTEXT**"

      expectContains("skill/corvus-review-r1/SKILL.md", [
        TASK,
        OUTCOME,
        MUST_DO,
        MUST_NOT_DO,
        CONTEXT,
      ])
      expectContains("skill/corvus-review-r2/SKILL.md", [TASK, MUST_DO, MUST_NOT_DO])
      expectContains("skill/corvus-review-r5/SKILL.md", [TASK, MUST_DO, MUST_NOT_DO])
    })

    test("no priority attrs review set", () => {
      // rubric R3 - XML priority attributes removed by modernization
      for (const file of PHASE_D_FILES) {
        expectAbsent(file, ['priority="'])
      }
    })
  })
})

// ============================================================================
// Phase E — Commands + repo-wide sweeps (Tasks 19-22)
// ============================================================================

/** Skill directory names (each holds a SKILL.md; §C5.5 freezes name = dir). */
const skillDirs = (): string[] =>
  readdirSync(resolve(ROOT, "skill"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

/**
 * Every prompt file the plugin loads: 16 agents + 4 commands + 18 skills = 38.
 * Enumerated at runtime so new files are swept automatically; counts mirror
 * the loader-level pins (index.test.ts / build.test.ts) so an empty glob can
 * never vacuously pass.
 */
const listPromptFiles = (): string[] => {
  const mdIn = (dir: string): string[] =>
    readdirSync(resolve(ROOT, dir))
      .filter((file) => file.endsWith(".md"))
      .map((file) => `${dir}/${file}`)
      .sort()
  return [
    ...mdIn("agent"),
    ...mdIn("command"),
    ...skillDirs().map((dir) => `skill/${dir}/SKILL.md`),
  ]
}

describe("prompt contracts: commands + repo-wide sweeps", () => {
  describe("commands (§C5.3, §C8)", () => {
    test("command files frontmatter", () => {
      // §C5.3, §C8 - exactly 4 command files with exact names (file-level
      // mirror of load-commands.test.ts name pins; filename = command name);
      // §C5.1 - first line SHALL be exactly ---
      const files = readdirSync(resolve(ROOT, "command"))
        .filter((file) => file.endsWith(".md"))
        .sort()
      expect(files).toEqual([
        "cleanup-subagents.md",
        "git-commit.md",
        "readme.md",
        "summary.md",
      ])
      for (const file of files) {
        expect(read(`command/${file}`).split("\n", 1)[0]).toBe("---")
      }
    })

    // Documentation row (§C5.4) — `summary command unmapped fields` is
    // intentionally NOT tested here: command/summary.md HAS `mode: command` /
    // `temperature: 0.3` in its frontmatter at baseline (lines 3-4, frozen
    // byte-identical by Task 19). The §C5.4 invariant is about loader OUTPUT —
    // the loaded CommandConfig exposes neither property — and is already
    // pinned by load-commands.test.ts ("ignores non-standard frontmatter
    // fields"). A file-content assertion would either contradict baseline
    // bytes or duplicate that loader-level coverage; neither is written.
  })

  describe("repo-wide sweeps (Tasks 20-22)", () => {
    test("repo-wide no priority attrs", () => {
      // rubric R3 - zero `priority="` matches across ALL agent/skill/command
      // files (supersets the per-phase checks above; catches future files too)
      for (const file of listPromptFiles()) {
        expectAbsent(file, ['priority="'])
      }
    })

    test("repo-wide frontmatter sweep", () => {
      // §C5.1 - every prompt file SHALL start with --- as its FIRST line
      // (one malformed file kills ALL agent loading)
      const files = listPromptFiles()
      expect(files).toHaveLength(38)
      expect(files).toContain("agent/pr-code-reviewer.md")
      for (const file of files) {
        expect(read(file).split("\n", 1)[0]).toBe("---")
      }
    })

    test("skill names match directories", () => {
      // §C5.5 - skill frontmatter `name` SHALL equal its directory name
      // (skill invocation names = directory names, §C6)
      const dirs = skillDirs()
      expect(dirs).toHaveLength(18)
      for (const dir of dirs) {
        expect(frontmatterBlock(`skill/${dir}/SKILL.md`)).toMatch(
          new RegExp(`^name: ${dir}$`, "m"),
        )
      }
    })
  })

  describe("MCP tool names (§C6)", () => {
    test("MCP tool names intact", () => {
      // §C6 - both MCP tool names verbatim in every file that invokes them
      // (also pinned per-file by the dedicated researcher/skill suites; this
      // is the cross-file contract sweep)
      for (const file of [
        "agent/researcher.md",
        "skill/corvus-phase-1/SKILL.md",
        "skill/web-search/SKILL.md",
        "skill/deep-research/SKILL.md",
      ]) {
        expectContains(file, [
          "web-research_multi_search",
          "web-research_fetch_pages",
        ])
      }
    })
  })
})

// ============================================================================
// Phase F — Native Agent Metadata (Tasks 24-25)
// ============================================================================

describe("prompt contracts: native agent metadata", () => {
  test("agent frontmatter uses singular permission keys", () => {
    const agentFiles = listPromptFiles().filter((file) =>
      file.startsWith("agent/"),
    )

    for (const file of agentFiles) {
      const frontmatter = frontmatterBlock(file)
      expect(frontmatter).toMatch(/^permission:/m)
      expect(frontmatter).not.toMatch(/^permissions:/m)
    }
  })
})

// ============================================================================
// Phase G — Review trust and deterministic state (Tasks 27-30)
// ============================================================================

const REVIEW_ORCHESTRATORS = [
  "agent/corvus-review.md",
  "agent/corvus-review-auto.md",
]

const DETECTION_REVIEWERS = [
  "agent/pr-code-reviewer.md",
  "agent/security-reviewer.md",
]

const APPROVED_REVIEW_CHILDREN = [
  "pr-code-reviewer",
  "pr-comment-writer",
  "pr-context-gatherer",
  "researcher",
  "security-reviewer",
]

const REVIEWABILITY_VALUES = ["complete", "partial", "skipped", "failed"]

const REVIEW_EXTRAS = "skill/corvus-review-extras/SKILL.md"
const REVIEW_R0 = "skill/corvus-review-r0/SKILL.md"
const REVIEW_R2 = "skill/corvus-review-r2/SKILL.md"
const REVIEW_R3 = "skill/corvus-review-r3/SKILL.md"
const REVIEW_R4 = "skill/corvus-review-r4/SKILL.md"
const REVIEW_R5 = "skill/corvus-review-r5/SKILL.md"
const COMMENT_WRITER = "agent/pr-comment-writer.md"

describe("prompt contracts: review trust + deterministic state", () => {
  test("mechanically limits detection reviewers to read-only tools", () => {
    for (const file of DETECTION_REVIEWERS) {
      const frontmatter = frontmatterBlock(file)
      const allowed = [...frontmatter.matchAll(/^  ([a-z_]+): "allow"$/gm)].map(
        ([, capability]) => capability,
      )

      expect(frontmatter).toContain('  "*": "deny"')
      expect([...allowed].sort()).toEqual(["glob", "grep", "read"])
      for (const denied of ["bash", "edit", "write", "task", "question"]) {
        expect(frontmatter).toContain(`  ${denied}: "deny"`)
      }
    }
  })

  test("uses closed orchestrator and R2 delegation allowlists", () => {
    for (const file of REVIEW_ORCHESTRATORS) {
      const taskPolicy = nestedFrontmatterBlock(file, "task")
      const allowed = [...taskPolicy.matchAll(/^    "([^"]+)": "allow"$/gm)].map(
        ([, target]) => target,
      )

      expect(taskPolicy).toContain('    "*": "deny"')
      expect([...allowed].sort()).toEqual(APPROVED_REVIEW_CHILDREN)
    }

    const passTargets = [
      ...read(REVIEW_R2).matchAll(/^\*\*DELEGATE TO\*\*: @([a-z-]+)$/gm),
    ].map(([, target]) => target)
    expect(passTargets).toEqual([
      "pr-code-reviewer",
      "pr-code-reviewer",
      "security-reviewer",
      "pr-code-reviewer",
    ])
    expectContains(REVIEW_R2, [
      "**DIMENSION**: `architecture`",
      "**DIMENSION**: `correctness`",
      "**DIMENSION**: `conventions`",
    ])
    expectAbsent(REVIEW_R2, ["@code-quality", "@ux-dx-quality"])
  })

  test("loads review config only from a verified immutable base SHA", () => {
    expectContains(REVIEW_R0, [
      "`baseRefOid` matches `^[0-9a-fA-F]{40}$`; normalize it to lowercase as `base_sha`.",
      'gh api --method GET "repos/<owner>/<repo>/contents/.opencode/review-config.yaml?ref=<base_sha>" -H "Accept: application/vnd.github.raw+json"',
      'config_source: "base_sha" | "built_in_defaults" | "trusted_invocation"',
      "Never read `.opencode/review-config.yaml` from the worktree, checked-out base, PR head, `headRefOid`, branch name, relative path",
    ])
    expectAbsent(REVIEW_R0, [
      /review-config\.yaml\?ref=<(?!base_sha>)[^>]+>/,
      /^(?:cat|git show|git checkout|git switch)\b.*review-config\.yaml/im,
    ])
  })

  test("keeps autonomous routing total and non-interactive", () => {
    expectContains(REVIEW_R4, [
      "if PR_CONTEXT.config.autonomous == true:",
      "execute only Autonomous Route",
    ])

    const autonomousRoute =
      read(REVIEW_R4).match(/## Autonomous Route\n([\s\S]*?)\n---/)?.[1] ?? ""
    expect(autonomousRoute).toContain('decision: "local_only"')
    expect(autonomousRoute).toContain('decision: "auto_post"')
    expect(autonomousRoute).toContain(
      "Every autonomous branch is terminal or auto-posting.",
    )
    expect(autonomousRoute).not.toContain("Invoke the `question()` tool")
  })

  test("uses the canonical reviewability enum and deterministic action caps", () => {
    expectContains(REVIEW_EXTRAS, [
      'reviewability: "complete" | "partial" | "skipped" | "failed"',
    ])
    expectContains(REVIEW_R3, [
      'reviewability: "<complete|partial|skipped|failed>"',
      "`failed`: informational `COMMENT_ONLY`, with mandatory downstream `local_only`.",
      "`skipped`: `COMMENT_ONLY` only.",
      "`partial`: `REQUEST_CHANGES` is permitted only when a retained, non-suppressed blocker or critical exists; otherwise use `COMMENT_ONLY`. It never approves.",
      "Coverage text is derived control-plane evidence, not an editable finding. Preserve it through action overrides, interactive edits, and R5 posting.",
    ])

    for (const file of [...REVIEW_ORCHESTRATORS, REVIEW_R4, REVIEW_R5]) {
      expectContains(
        file,
        REVIEWABILITY_VALUES.map((value) => `\`${value}\``),
      )
    }
    expectContains(REVIEW_R5, [
      "For `partial` and `skipped`, the structured `body` must include the exact immutable warning/notice",
    ])
  })

  test("routes failed and local-only reviews without writer dispatch", () => {
    expectContains(REVIEW_R5, [
      "`failed` always converts to `local_only`",
    ])

    const noPostRoute =
      read(REVIEW_R5).match(
        /## Step 1: Route No-Post Decisions First\n([\s\S]*?)\n---/,
      )?.[1] ?? ""
    expect(noPostRoute).toContain('if decision == "local_only":')
    expect(noPostRoute).toContain("never invoke @pr-comment-writer")
    expect(noPostRoute).toContain("never run a GitHub mutation")
    expect(noPostRoute).not.toContain("Delegate exactly once")
  })

  test("retains strongest exact nitpicks without minor pooling", () => {
    expectContains(REVIEW_R3, [
      "whose label is exactly `nitpick`",
      "Every other label bypasses this budget. Never count, drop, or mark `minor`, `major`, `critical`, `blocker`, `praise`, `thought`, or `note` as suppressed because of `max_nits`.",
      "Sort `eligible_nitpicks` by confidence descending.",
      "Break confidence ties by normalized file path ascending, then `line_start` ascending, then finding `id` ascending.",
      "Keep (retain) the first `max_nits` findings. When `max_nits == 0`, retain none.",
    ])
    expectAbsent(REVIEW_R3, [
      /nitpick_count\s*\+\s*minor_count/i,
      /Pool all nitpick and minor/i,
      /minor_count.*max_nits/i,
    ])
  })

  test("keeps posting structured, encoded, and command-safe", () => {
    const bashPolicy = nestedFrontmatterBlock(COMMENT_WRITER, "bash")
    const allowedCommands = [
      ...bashPolicy.matchAll(/^    (.+): "allow"$/gm),
    ].map(([, command]) => command)

    expect(bashPolicy).toContain('    "*": "deny"')
    expect(allowedCommands).toEqual([
      `'gh api --method GET "repos/*/pulls/*" -H "Accept: application/vnd.github.v3.diff"'`,
      `'gh api --method POST "repos/*/pulls/*/reviews" --input -'`,
    ])
    expectContains(COMMENT_WRITER, [
      "Accept only one structured POST_REQUEST delegated by R5",
      "Use a real JSON encoder (`JSON.stringify` or an equivalent typed encoder)",
      "stdin = jsonEncode(api_payload)",
      "Never use `eval`, `sh -c`, `bash -c`, command substitution",
    ])
    expectContains(REVIEW_R5, [
      "Delegate exactly once to `@pr-comment-writer` with only the structured POST_REQUEST.",
    ])
  })
})

// ============================================================================
// Phase H — Workflow, mutation safety, and documentation (Tasks 31-36)
// ============================================================================

const REQUIREMENTS_ANALYST = "agent/requirements-analyst.md"
const CORVUS = "agent/corvus.md"
const CORVUS_AUTO = "agent/corvus-auto.md"
const PHASE_2 = "skill/corvus-phase-2/SKILL.md"
const TASK_PLANNER = "agent/task-planner.md"
const PHASE_4 = "skill/corvus-phase-4/SKILL.md"
const CODE_IMPLEMENTER = "agent/code-implementer.md"
const UX_DX_QUALITY = "agent/ux-dx-quality.md"
const PHASE_5 = "skill/corvus-phase-5/SKILL.md"
const CODE_QUALITY = "agent/code-quality.md"
const CORVUS_EXTRAS = "skill/corvus-extras/SKILL.md"
const GIT_COMMIT = "command/git-commit.md"
const CLEANUP_SUBAGENTS = "command/cleanup-subagents.md"
const STATE_MACHINE_DOC = "docs/CORVUS-STATE-MACHINE.md"
const REVIEW_DOC = "docs/CORVUS-REVIEW-SKILL-SET.md"

const SUBJECTIVE_GATE_VALUES = [
  "PASS",
  "NEEDS_IMPROVEMENT",
  "CRITICAL_ISSUES",
]

const PHASE_H_OWNERSHIP_FILES = [
  TASK_PLANNER,
  PHASE_4,
  CODE_IMPLEMENTER,
  UX_DX_QUALITY,
  PHASE_5,
  CODE_QUALITY,
  CORVUS_EXTRAS,
]

const PHASE_H_SAFETY_TEXT_FILES = [
  CORVUS_AUTO,
  GIT_COMMIT,
  CLEANUP_SUBAGENTS,
  "README.md",
  "AGENTS.md",
  STATE_MACHINE_DOC,
  REVIEW_DOC,
]

const HARDENING_DOCS = [
  "README.md",
  "AGENTS.md",
  STATE_MACHINE_DOC,
  REVIEW_DOC,
]

describe("prompt contracts: Phase H workflow + safety", () => {
  describe("planning and discovery routing", () => {
    test("keeps clarification questions with the orchestrator", () => {
      const analystFrontmatter = frontmatterBlock(REQUIREMENTS_ANALYST)
      expect(analystFrontmatter).toContain('question: "deny"')
      expect(analystFrontmatter).not.toContain('question: "allow"')
      expectContains(REQUIREMENTS_ANALYST, [
        "## CLARIFICATION BATCH CONTRACT",
        "**ID**:",
        "**Priority**:",
        "**Text**:",
        "**Options**:",
        "**Recommended / default answer**:",
        "**Why it blocks**:",
        "**Batch completeness**: Complete",
      ])
      expectAbsent(REQUIREMENTS_ANALYST, [
        "question()",
        /\b(?:call|invoke|use)\s+(?:the\s+)?question tool\b/i,
      ])

      expectContains(CORVUS, [
        "Put every item from that batch into one `question()` tool call",
        "Collect the complete result as `ANSWERS_BY_ID`",
      ])
      expect(frontmatterBlock(CORVUS_AUTO)).toContain('question: "deny"')
      expectContains(CORVUS_AUTO, [
        "select its recommended/default answer.",
        "`ASSUMPTIONS_BY_ID`",
      ])
    })

    test("keeps No Plan outside planned-work Phase 2", () => {
      for (const file of [CORVUS, CORVUS_AUTO]) {
        expectContains(file, [
          '<rule id="planned_work_only">',
          "Phase 2 accepts only PLAN_TYPE LIGHTWEIGHT, STANDARD, or SPEC_DRIVEN.",
          "No Plan → [Direct Specialist] → END (no Phase 2",
          "delegation without Phase 2.",
        ])
      }

      expectContains(PHASE_2, [
        "## Phase 2: PLANNING (PLANNED WORK ONLY)",
        "Phase 2 accepts exactly `PLAN_TYPE: LIGHTWEIGHT | STANDARD | SPEC_DRIVEN`.",
        "`No Plan` is a direct-delegation result, not a Phase 2 input",
      ])
    })

    test("consumes preselected plan and test inputs without repeat questions", () => {
      const interactiveRule =
        read(CORVUS).match(
          /<rule id="preselected_inputs">([\s\S]*?)<\/rule>/,
        )?.[1] ?? ""
      expect(interactiveRule).toContain("PLAN_TYPE")
      expect(interactiveRule).toContain("tests_enabled")
      expect(interactiveRule).toContain("tests_deferred")
      expect(interactiveRule).toContain("Ask only for unresolved values")
      expect(interactiveRule).toContain("never repeat")

      const autonomousRule =
        read(CORVUS_AUTO).match(
          /<rule id="preselected_inputs">([\s\S]*?)<\/rule>/,
        )?.[1] ?? ""
      expect(autonomousRule).toContain("PLAN_TYPE")
      expect(autonomousRule).toContain("tests_enabled")
      expect(autonomousRule).toContain("tests_deferred")
      expect(autonomousRule).toContain("Resolve only missing values")
      expect(autonomousRule).toContain("never with questions")

      expectContains(PHASE_2, [
        "Consume every valid preselected value as supplied.",
        "Never ask again for `PLAN_TYPE`, `tests_enabled`, or `tests_deferred` when that value is already present.",
      ])
    })
  })

  describe("progress, test, and verdict ownership", () => {
    test("confines PROGRESS_UPDATE to authorized planning state", () => {
      expect(frontmatterBlock(TASK_PLANNER)).toContain(
        '    ".corvus/tasks/**": "allow"',
      )
      expectContains(TASK_PLANNER, [
        "### `PROGRESS_UPDATE` Mode",
        "`PROGRESS_UPDATE` is the only Task Planner mode authorized to record execution",
        "**MASTER PLAN**: `.corvus/tasks/<feature>/MASTER_PLAN.md`",
        "The write allowlist contains exactly:",
        "Reject absolute paths, path traversal, a plan not named `MASTER_PLAN.md`",
        "Any `[x]` would change to another status. Completed work never regresses.",
      ])
    })

    test("delegates Phase 4c progress only after a passing gate", () => {
      expectContains(PHASE_4, [
        "After a phase-wide 4b `PASS`, delegate the state transition to @task-planner.",
        "**MODE**: PROGRESS_UPDATE",
        "Verify the returned diff is confined to the supplied MASTER_PLAN.md",
        "block the transition and report the failure.",
      ])
    })

    test("separates deferred authoring from execution and disables tests fully", () => {
      for (const file of [PHASE_4, CODE_IMPLEMENTER]) {
        const rows = read(file).split("\n")
        const deferredRow =
          rows.find((line) =>
            line.includes("phase test task, `tests_deferred: true`"),
          ) ?? ""
        expect(deferredRow).toContain("author tests")
        expect(deferredRow).toContain("no production changes")
        expect(deferredRow).toMatch(/Never (?:execute|run) tests/)
        expect(deferredRow).toContain("Phase 5 performs the first")

        const disabledRow =
          rows.find((line) => line.startsWith("| `tests_enabled: false`")) ??
          ""
        expect(disabledRow).toContain("Product files only")
        expect(disabledRow).toMatch(/no (?:phase )?test task/i)
        expect(disabledRow).toMatch(
          /(?:test-file edit exists|test file, fixture, or snapshot is created or modified)/i,
        )
        expect(disabledRow).toMatch(/Never (?:execute|run) tests/)
      }
    })

    test("keeps the exact three-valued 5b producer and consumer contract", () => {
      const producerContract =
        read(UX_DX_QUALITY).match(
          /### Canonical 5b Verdict Contract\n([\s\S]*?)\n## ASSESSMENT MODES/,
        )?.[1] ?? ""
      const producerValues = [
        ...producerContract.matchAll(/^\| `([A-Z_]+)` \|/gm),
      ].map(([, value]) => value)
      expect(producerValues).toEqual(SUBJECTIVE_GATE_VALUES)

      const consumerContract =
        read(PHASE_5).match(
          /The only accepted 5b values and meanings are:\n([\s\S]*?)\n\*\*Decision Point after 5b\*\*:/,
        )?.[1] ?? ""
      const consumerValues = [
        ...consumerContract.matchAll(/^- `([A-Z_]+)`:/gm),
      ].map(([, value]) => value)
      expect(consumerValues).toEqual(SUBJECTIVE_GATE_VALUES)

      const decisions =
        read(PHASE_5).match(
          /\*\*Decision Point after 5b\*\*:\n([\s\S]*?)\n\nPhase 5 records/,
        )?.[1] ?? ""
      const decisionValues = [
        ...decisions.matchAll(/^- `([A-Z_]+)` →/gm),
      ].map(([, value]) => value)
      expect(decisionValues).toEqual(SUBJECTIVE_GATE_VALUES)
      expect(decisions).toContain("`PASS` → Proceed to Phase 6.")
      expect(decisions).toContain("`NEEDS_IMPROVEMENT` → Record")
      expect(decisions).toContain("`CRITICAL_ISSUES` → Create tasks")
      expect(decisions).toContain("rerun both 5a and 5b.")
      expect(decisions).toContain("Missing or unknown status → Fail closed")
    })

    test("keeps objective quality binary and routes PASS to progress", () => {
      expectContains(CODE_QUALITY, [
        '<rule id="binary_pass_fail">',
        "Validation results are binary PASS or FAIL",
        "**IF PASS**: Corvus proceeds to the Phase 4c progress update",
      ])
      expectAbsent(CODE_QUALITY, ["NEEDS_IMPROVEMENT", "CRITICAL_ISSUES"])
    })

    test("removes obsolete progress and success-learning states", () => {
      const obsoletePatterns = [
        /4c\s*(?:\([^)]*(?:ux[-/]?dx|subjective|success learning)[^)]*\)|(?:ux[-/]?dx|subjective|success learning))/i,
        /\b(?:step\s+)?4d(?:\s+(?:plan|update|success)|[.:])/i,
        /(?:SUCCESS_EXTRACTION|success (?:learning|extraction))[^\n]*(?:(?:after|for)\s+(?:each|every)\s+(?:task|phase)|per[- ](?:task|phase)|\b4[cd]\b)/i,
        /(?:(?:after|for)\s+(?:each|every)\s+(?:task|phase)|per[- ](?:task|phase))[^\n]*(?:SUCCESS_EXTRACTION|success (?:learning|extraction))/i,
      ]
      for (const file of PHASE_H_OWNERSHIP_FILES) {
        expectAbsent(file, obsoletePatterns)
      }

      expectContains(PHASE_4, ["Phase 6 alone owns feature-wide learning."])
      expectContains(PHASE_5, ["6 alone owns `SUCCESS_EXTRACTION`."])
      expectContains(CORVUS_EXTRAS, [
        "Phase 6 alone owns `SUCCESS_EXTRACTION`.",
      ])
    })
  })

  describe("mutation and documentation safety", () => {
    test("never pre-executes a state-changing substitution", () => {
      const mutatingSubstitution =
        /!`(?:git\s+(?:add|commit|push|checkout|switch|branch|reset|clean)\b|gh\s+pr\s+create\b|(?:rm|mv|cp)\s)/i
      for (const file of [GIT_COMMIT, CLEANUP_SUBAGENTS]) {
        expectAbsent(file, [mutatingSubstitution])
      }

      expectContains(GIT_COMMIT, [
        "Only after confirmation, make one normal tool call",
        'argv  = ["git", "commit", "--file=-"]',
        "Commit only the user's already staged set.",
      ])
    })

    test("requires confined cleanup preview and confirmation", () => {
      expectContains(CLEANUP_SUBAGENTS, [
        "non-empty `parentID` field",
        "strict descendant of the canonical storage root",
        "## Step 3: Show the Exact Preview",
        "If `--list` is present, terminate immediately after this preview.",
        "ask for an explicit confirmation only after the complete preview.",
        "Reject any symlink, symlink escape",
      ])
    })

    test("forbids broad staging, hardcoded bases, and per-phase delivery", () => {
      expectAbsent(CORVUS_AUTO, [
        /git add\s+(?:-A|\.(?=[\s`]|$))/,
        /--base\s+(?:main|master)\b/i,
        /(?:commit_mode|commit_granularity|commit mode|commit granularity)[^\n]*per[- ]phase/i,
        /["'`]per-phase["'`]/i,
      ])
    })

    test("keeps autonomous delivery local-first and manifest-scoped", () => {
      expectContains(CORVUS_AUTO, [
        'delivery_mode: "local_only"',
        'commit_mode: "single"',
        "Only a direct, trusted top-level invocation",
        "symbolic `HEAD` metadata",
        "### Delivery Branch Gate Before Phase 4",
        "before Phase 4 begins",
        "### 6c: Task-Owned Manifest and Exact Staging",
        "fixed prefix `git add --`",
        "stored discovered default branch",
      ])
    })

    test("has no trailing whitespace in hardened prompts, commands, or docs", () => {
      expectNoTrailingWhitespace(PHASE_H_SAFETY_TEXT_FILES)
    })

    test("keeps documentation rosters and workflow truth tables synchronized", () => {
      expectContains("README.md", [
        "native singular `permission`",
        "Corvus contains **38 prompt files**: 16 agents, 4 commands, and 18 skills.",
      ])
      expectContains("AGENTS.md", [
        "native singular `permission`",
        "**16 agents, 4 commands, 18 skills, and 38 prompt files**",
      ])

      const agentsSection =
        read("AGENTS.md").match(
          /## Available Agents\n([\s\S]*?)\n\*\*Routing notes\*\*:/,
        )?.[1] ?? ""
      const agentsRoster = [
        ...agentsSection.matchAll(/^\| ([a-z][a-z-]+) \|/gm),
      ].map(([, name]) => name)
      const readmeSection =
        read("README.md").match(
          /### Agents \(16\)\n([\s\S]*?)\n### Commands \(4\)/,
        )?.[1] ?? ""
      const readmeRoster = [
        ...readmeSection.matchAll(/^\| `@([a-z-]+)` \|/gm),
      ].map(([, name]) => name)
      expect(agentsRoster).toHaveLength(16)
      expect(agentsRoster).toContain("pr-code-reviewer")
      expect([...readmeRoster].sort()).toEqual([...agentsRoster].sort())

      expectContains(STATE_MACHINE_DOC, [
        "`No Plan` is not a Phase 2 mode",
        "`DISCOVERY_ORIGIN: PHASE_0A`, `RETURN_TARGET: PHASE_0B`",
        "Origin is `DIRECT_CALLER`; return findings and stop with no implicit planning",
        "Task Planner `PROGRESS_UPDATE` succeeds",
        "exactly one `5b SUBJECTIVE GATE STATUS`",
        "Phase 6 is its sole owner.",
      ])

      expectContains(REVIEW_DOC, [
        "only from the PR's validated immutable base SHA",
        "only `read`, `glob`, and `grep` are allowed",
        "## Reviewability and Posting Truth Table",
      ])
      const truthTable =
        read(REVIEW_DOC).match(
          /## Reviewability and Posting Truth Table\n([\s\S]*?)\n### Action and Safety-Rail Precedence/,
        )?.[1] ?? ""
      const reviewabilityValues = [
        ...truthTable.matchAll(/^\| `([a-z]+)` \|/gm),
      ].map(([, value]) => value)
      expect(reviewabilityValues).toEqual([
        "complete",
        "partial",
        "skipped",
        "failed",
      ])
      expect(truthTable).toContain("Forced `local_only`; no post")

      for (const file of HARDENING_DOCS) {
        expectAbsent(file, [
          /\b15 agents\b/i,
          /\b37 prompt files\b/i,
          /git add\s+(?:-A|\.(?=[\s`]|$))/,
          /--base\s+(?:main|master)\b/i,
          /(?:commit_mode|commit_granularity)[^\n]*per[- ]phase/i,
          /plugin[^\n]*overwrit[^\n]*user/i,
        ])
      }
      expectAbsent("AGENTS.md", [
        /Agent fields use (?:the )?plural `permissions`/i,
      ])
    })
  })
})

// ============================================================================
// Test cadence redesign — Phase 1 (Tasks 01-04)
// ============================================================================

describe("test cadence redesign — phase 1 pins", () => {
  describe("test_scope semantics (Task 01)", () => {
    test("defines the canonical test_scope semantics once", () => {
      // Phase-2 owns the single canonical definition; consumers point here.
      const definitionLine =
        "Every dispatch that may execute tests carries exactly one `test_scope: targeted | full | none` field:"
      expect(read(PHASE_2).split(definitionLine).length - 1).toBe(1)

      expectContains(PHASE_2, [
        "Precedence (flag semantics dominate): `tests_enabled: false` forces `test_scope: none` on every dispatch — `test_scope: full` can never override it.",
        "| Deferred (`tests_deferred: true`) | 1 full (Phase 5a — first execution) |",
      ])
    })
  })

  describe("dispatch cadence (Task 02)", () => {
    test("phase-4 dispatch templates carry an explicit test_scope", () => {
      // 4a (per-task) and 4b (phase-union) templates each declare the field.
      expectContains(PHASE_4, [
        "**TEST SCOPE**: `test_scope: [targeted|none]` — targeted = only tests scoped to this task (its own new/modified test files); none when `tests_deferred: true` or `tests_enabled: false`. Full semantics: corvus-phase-2 skill, Test Scope section.",
        "**TEST SCOPE**: `test_scope: [targeted|none]` — targeted = union of test files created/modified by this phase's tasks (from their Tests sections); none when the phase has no test tasks (deferred and disabled dispatches use the acceptance-only template below). Exception: a Lightweight non-deferred plan's final 4b gate doubles as final validation and carries the plan's single full-suite run (semantics: corvus-phase-2 skill, Test Scope section).",
      ])
    })

    test("removes the 4b double-run clause", () => {
      expectAbsent(PHASE_4, ["4b also runs its required gate tests"])

      // Line-wise row matching (same style as the deferred/disabled rows above):
      // the non-deferred phase-test row assigns the single gate run to 4b.
      const phaseTestRow = (relPath: string): string =>
        read(relPath)
          .split("\n")
          .find((line) =>
            line.includes("phase test task, `tests_deferred: false`"),
          ) ?? ""

      const phase4Row = phaseTestRow(PHASE_4)
      expect(phase4Row).toMatch(/test_scope: targeted/)
      expect(phase4Row).toContain(
        "4b owns the single phase-targeted gate run.",
      )

      const implementerRow = phaseTestRow(CODE_IMPLEMENTER)
      expect(implementerRow).toMatch(/test_scope: targeted/)
      expect(implementerRow).toContain("never the full suite.")
    })

    test("defines 4b targeted as the union of phase test files", () => {
      expectContains(PHASE_4, [
        "1. Run the phase-targeted test scope (union of this phase's task test files) — once",
        "3. Check for regressions within the dispatched test_scope plus acceptance-criteria evidence — the full suite belongs to Phase 5a only",
      ])
    })
  })

  describe("conditional fix loop (Task 03)", () => {
    test("fix loop is iteration-conditional in the canonical owner", () => {
      expectContains(PHASE_4, [
        // Operating Rules: iteration-1 direct fix, iteration-≥2 analysis-first.
        "on a phase's first 4b FAIL (Iteration 1), dispatch",
        "`test_scope: targeted` — no task-planner round-trip. The 4b report already",
        "From iteration ≥2, invoke task-planner LEARNING (FAILURE_ANALYSIS) first, then",
        // F-steps restate the same conditional rule.
        "The canonical rule from Operating Rules applies: iteration 1 dispatches a direct fix from the gate's failure report (F1); iteration ≥2 runs FAILURE_ANALYSIS first, then the fix (F2); every iteration ends with revalidation at the original 4b dispatch scope (F3).",
        // Cap sentence survives the redesign.
        "- **Max 3 fix iterations per phase**: at the cap, stop and escalate to the user with",
      ])
    })

    test("orchestrator Gate 3 rows stay in parity", () => {
      const gate3Row = (relPath: string): string =>
        read(relPath).match(/^\| 3 \| 4b FAIL \|.*$/m)?.[0] ?? ""

      const interactiveRow = gate3Row(CORVUS)
      expect(interactiveRow).toContain(
        "Iteration 1: code-implementer fixes only the failing tasks (targeted, with the 4b failure report) → 4b.",
      )
      expect(interactiveRow).toContain(
        "Iteration ≥2: task-planner FAILURE_ANALYSIS first → fix → 4b",
      )
      expect(interactiveRow).toContain(
        "Skipping FAILURE_ANALYSIS from iteration 2 onward; full-suite reruns at 4b (sole exception: the Lightweight non-deferred final gate revalidating at its dispatched full scope); proceeding to 4c; fixing all tasks",
      )
      expect(gate3Row(CORVUS_AUTO)).toBe(interactiveRow)
    })

    test("task-planner FAILURE_ANALYSIS triggers from iteration two", () => {
      expectContains(TASK_PLANNER, [
        "**MODE**: LEARNING",
        "**TRIGGER**: FAILURE_ANALYSIS",
        "| FAILURE_ANALYSIS | A phase's 4b gate fails for the second or later iteration (iteration ≥2; iteration 1 is a direct fix — rule: corvus-phase-4 skill) | Diagnose the repeated phase failure before the next fix |",
      ])
    })

    test("extras fix loop matches the conditional rule", () => {
      expectContains(CORVUS_EXTRAS, [
        "2. **Dispatch the fix** — iteration 1: send a targeted fix request (`test_scope: targeted`) to code-implementer with the failure report; iteration ≥2: task-planner FAILURE_ANALYSIS first (rule: corvus-phase-4 skill)",
      ])
      expectAbsent(CORVUS_EXTRAS, ["before any fix"])
    })
  })

  describe("per-task cadence (Task 04)", () => {
    test("implementer validates per task, never per step", () => {
      expectAbsent(CODE_IMPLEMENTER, ["After each coherent file change"])
      expectContains(CODE_IMPLEMENTER, [
        "Validate once per task, after completing the task's implementation steps, using",
        "5. **Validate the completed task** with only the effective allowlist and capture output.",
        "Fix attempts re-run the same targeted scope and never widen to the full suite.",
      ])
    })
  })
})

// ============================================================================
// Test cadence redesign — Phase 2 (Tasks 06-08)
// ============================================================================

describe("test cadence redesign — phase 2 pins", () => {
  describe("single full run and audit routing (Task 06)", () => {
    test("code-quality owns the dispatched scope and forbids per-task suite runs", () => {
      expectContains(CODE_QUALITY, [
        // Validation-sequence rule: one run of the dispatched scope, never per-task.
        "3. **Run the dispatched `test_scope` once**: at 4b, `targeted` = the union of test files created/modified by this phase's tasks (never the full suite, never per-task runs)",
        // Execution-standards row restating the same ownership boundary.
        "| **Single test run** | Run the dispatched test_scope once, not per-task; the full suite belongs to Phase 5a only — except a Lightweight non-deferred plan's final 4b gate, which doubles as final validation and carries `test_scope: full` (semantics: corvus-phase-2 skill, Test Scope section) |",
      ])
      expectAbsent(CODE_QUALITY, ["unified test suite"])
    })

    test("audit dispatches never route to code-quality", () => {
      // Requirement 6 / edge case 9: the one-line audit-routing sentence.
      expectContains(CODE_QUALITY, [
        "Audit and review-only dispatches are out of scope: they route to the mechanically read-only pr-code-reviewer or security-reviewer, never to code-quality.",
      ])
    })

    test("phase 5a is the single full run for all enabled modes", () => {
      // Phase-5 flag table: both enabled rows declare the single full-suite run
      // owned by code-quality, pointing at the canonical phase-2 flag table.
      expectContains(PHASE_5, [
        "Phase 5a's own rows from the flag-combination semantics (full table: corvus-phase-2 skill, Entry Contract (canonical flag table) and Test Scope section):",
        "Run the full test suite (`test_scope: full`) — the feature's single full-suite run, owned by code-quality (not just affected tests)",
        "owned by code-quality, and the first test execution in deferred mode (tests were deferred during Phase 4); report it clearly as the deferred test run",
        // ONE-full-re-run rule on the 5a FAIL path.
        "FAIL → Create fix tasks, return to Phase 4 (fix dispatches carry `test_scope: targeted`); re-verification is ONE full 5a re-run, within the iteration cap",
      ])
      expectContains(CODE_QUALITY, [
        "this dispatch carries `test_scope: full` and is THE single full-suite run of the feature, for ALL `tests_enabled: true` modes (in deferred mode it is also the first test execution)",
        "On FAIL at the gate that carries final validation (5a — or, for a Lightweight non-deferred plan, its final 4b gate), fix tasks return to Phase 4 and fix dispatches carry `test_scope: targeted`; re-verification is ONE full re-run at that same gate — the only sanctioned second full run — within the 3-iteration cap.",
      ])

      // The existing 5b structural anchors (three-valued contract test above)
      // still parse after the Task 06 edits.
      const consumerContract =
        read(PHASE_5).match(
          /The only accepted 5b values and meanings are:\n([\s\S]*?)\n\*\*Decision Point after 5b\*\*:/,
        )?.[1] ?? ""
      expect(consumerContract).not.toBe("")
      const decisions =
        read(PHASE_5).match(
          /\*\*Decision Point after 5b\*\*:\n([\s\S]*?)\n\nPhase 5 records/,
        )?.[1] ?? ""
      expect(decisions).not.toBe("")
    })
  })

  describe("orchestrator parity (Task 07)", () => {
    test("validation responsibility division stays in mirror parity", () => {
      // Section extraction from heading to the next `##` heading. No marked
      // divergences exist inside this section at pin time, so no strip step
      // is needed before comparing.
      const divisionSection = (relPath: string): string =>
        read(relPath).match(
          /## VALIDATION RESPONSIBILITY DIVISION\n([\s\S]*?)\n## /,
        )?.[1] ?? ""

      const interactiveSection = divisionSection(CORVUS)
      expect(interactiveSection).not.toBe("")
      expect(interactiveSection).toContain(
        "| Test execution (targeted) | End of each phase (4b) | code-quality | `tests_enabled: true` AND `tests_deferred: false`; scope = union of the phase's task test files (`test_scope: targeted`), once. |",
      )
      expect(interactiveSection).toContain(
        "| Test execution (full) | Phase 5a | code-quality | `tests_enabled: true` (all modes) — THE single full-suite run; in deferred mode also the first execution (`test_scope: full`); a Lightweight non-deferred plan carries this run at its final 4b gate. |",
      )
      expect(divisionSection(CORVUS_AUTO)).toBe(interactiveSection)
    })

    test("5a full run is unconditional for enabled modes in both orchestrators", () => {
      for (const file of [CORVUS, CORVUS_AUTO]) {
        expectContains(file, [
          // The 5a resolution row: one full-suite run for every enabled mode.
          "- **5a**: code-quality — always. THE single full-suite run (`test_scope: full`) when `tests_enabled: true` — every enabled mode, deferred mode's first execution; acceptance-only (`test_scope: none`) when `tests_enabled: false`",
          // Gate 1 carries the matching test_scope resolution clause.
          "with the matching `test_scope` (targeted when enabled non-deferred; none when deferred or disabled)",
        ])
        // The old deferred-only 5a conditional row is gone.
        expectAbsent(file, ["AND `tests_deferred: true`"])
      }
    })

    // Task 07 criterion 5 (`tests_enabled`, `tests_deferred`, `**TEST PREFERENCE**`
    // in agent/corvus.md) is already pinned by "corvus.md workflow pins" above —
    // per the task spec, no duplicate test is added.
  })

  describe("planner cadence (Task 08)", () => {
    test("planner generates targeted-only phase test tasks", () => {
      const plannerRows = read(TASK_PLANNER).split("\n")

      const nonDeferredRow =
        plannerRows.find((line) =>
          line.includes("phase test task, `tests_deferred: false`"),
        ) ?? ""
      expect(nonDeferredRow).toMatch(/test_scope: targeted/)
      expect(nonDeferredRow).toContain(
        "never the full suite. 4b owns the phase-targeted gate run.",
      )

      const deferredRow =
        plannerRows.find((line) =>
          line.includes("phase test task, `tests_deferred: true`"),
        ) ?? ""
      expect(deferredRow).toContain(
        "Own-file targeted verification immediately before the 5a dispatch does not consume the single-full-run budget.",
      )

      expectContains(TASK_PLANNER, [
        "never plan a full-suite run outside Phase 5a",
        // MASTER_PLAN-mandatory rule survives the cadence redesign.
        "Create a MASTER_PLAN.md for every plan — it is the primary execution tracking document.",
      ])
    })
  })
})

// ============================================================================
// Test cadence redesign — Phase 3 (Tasks 10-11)
// ============================================================================

describe("test cadence redesign — phase 3 pins", () => {
  describe("docs sync (Task 10)", () => {
    test("state machine reflects targeted 4b and the single 5a full run", () => {
      expectContains(STATE_MACHINE_DOC, [
        // 5a scope rows: both enabled modes declare THE single full-suite run.
        "**Scope** (when `tests_enabled: true, tests_deferred: false`): THE single full-suite run (`test_scope: full`), production build, ALL acceptance criteria",
        "**Scope** (when `tests_enabled: true, tests_deferred: true`): THE single full-suite run (`test_scope: full`; FIRST execution — deferred from Phase 4), production build, ALL acceptance criteria",
        // 4b-to-4c transition row: the phase gate is targeted, never full.
        "| All phase-targeted tests pass (`test_scope: targeted`) | Continue | `tests_enabled: true` AND `tests_deferred: false` only |",
        // Validation Responsibility table: targeted 4b row + the merged
        // single-full-run row (the old deferred-only :731 row folded in).
        "| **Tests (targeted)** | End of phase (4b) | **code-quality** | `tests_enabled: true` AND `tests_deferred: false`; scope = union of the phase's task test files (`test_scope: targeted`), once |",
        "| **Full suite** | Phase 5a | **code-quality** | `tests_enabled: true` (all modes) — THE single full-suite run (`test_scope: full`); in deferred mode also the first execution; a Lightweight non-deferred plan carries this run at its final 4b gate |",
      ])
      // The superseded 5a-deferred-only row string never returns.
      expectAbsent(STATE_MACHINE_DOC, [
        "Only when `tests_enabled: true` AND `tests_deferred: true`",
      ])
    })

    test("AGENTS.md names code-quality run ownership", () => {
      // Task 10 criterion 3: the exact ownership note — 4b targeted + the
      // single Phase 5 full run stay with code-quality; audits route to the
      // read-only reviewers instead.
      expectContains("AGENTS.md", [
        "it owns the 4b phase-targeted test runs (`test_scope: targeted`, the union of the phase's task test files, once) and the single Phase 5 full-suite run (`test_scope: full`; a Lightweight non-deferred plan has no Phase 5 and carries this single full run at its final 4b gate).",
        "audit and review-only dispatches go to `@pr-code-reviewer`/`@security-reviewer` instead",
      ])
    })
  })

  describe("sweep absence guarantees (Task 11)", () => {
    test("old cadence phrases never reappear", () => {
      // Task 11 step-3 zero-hit greps promoted to pins. Combos already pinned
      // in the phase 1/2 blocks are skipped — no duplicate pins:
      //   phase-4 + "4b also runs..." ("removes the 4b double-run clause"),
      //   code-implementer + "After each coherent file change" ("implementer
      //   validates per task, never per step"),
      //   code-quality + "unified test suite" ("code-quality owns the
      //   dispatched scope and forbids per-task suite runs").
      const DOUBLE_RUN = "4b also runs its required gate tests"
      const PER_CHANGE = "After each coherent file change"
      const UNIFIED_SUITE = "unified test suite"

      expectAbsent(PHASE_4, [PER_CHANGE, UNIFIED_SUITE])
      expectAbsent(CODE_IMPLEMENTER, [DOUBLE_RUN, UNIFIED_SUITE])
      expectAbsent(CODE_QUALITY, [DOUBLE_RUN, PER_CHANGE, "task-planner LEARNING before fixing"])
      for (const file of [CORVUS, CORVUS_AUTO]) {
        expectAbsent(file, [DOUBLE_RUN, PER_CHANGE, UNIFIED_SUITE])
      }
    })

    test("test_scope full stays exclusive to Phase 5a contexts", () => {
      // The 4a and 4b delegation templates never carry `test_scope: full`;
      // Phase 5a alone owns that value (pinned in the phase 2 block). Each
      // template block must extract non-empty so the check cannot pass
      // vacuously on a moved anchor.
      const source = read(PHASE_4)
      const templates = [
        /#### Single-Task Delegation Template\n([\s\S]*?)\n#### Worked Example/,
        /#### 4b Delegation: Standard Mode([\s\S]*?)\n#### 4b Delegation: Acceptance-Only Mode/,
        /#### 4b Delegation: Acceptance-Only Mode([\s\S]*?)\n\*\*GATE DECISION\*\*/,
      ].map((anchor) => source.match(anchor)?.[1] ?? "")

      expect(templates).toHaveLength(3)
      for (const template of templates) {
        expect(template).not.toBe("")
        expect(template).not.toMatch(/test_scope:\s*full/)
      }
    })
  })
})
