import { resolve } from "node:path"

/**
 * Package-relative paths shared by the v1 entry (`src/index.ts`) and the v2
 * entry (`src/server.ts`).
 *
 * Resolution is relative to this module's own directory: sources sit at
 * `src/` depth and both built bundles sit at `dist/` depth, so the package
 * root is always one level up. Resolution uses portable
 * `import.meta.dirname` rather than the Bun-only variant, so the built
 * bundles also run under plain Node.
 */
export const root = resolve(import.meta.dirname, "..")

export const agentDir = resolve(root, "agent")

export const commandDir = resolve(root, "command")

export const skillDir = resolve(root, "skill")
