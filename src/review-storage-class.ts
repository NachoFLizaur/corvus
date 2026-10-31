import { basename, isAbsolute, relative, sep } from "node:path"

export const LIGHT_REVIEW_DIRECTORY = ".light"
const NAMESPACE = /^(?:reviews|tasks\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/reviews)\/(?:pr[1-9][0-9]*|local-[A-Za-z0-9._-]+)(?=\/|$)/

/** Host-relative layout is the class oracle, read by consumers before guarded
 * I/O. Only the direct class child of a new PR/LOCAL namespace is private;
 * workspace ancestors, task names and deeper children never select it. Consumers
 * fail closed on invalid coordinates; containment remains a separate guard. */
export function reviewNamespaceOf(hostRel: string): string | null {
  return NAMESPACE.exec(hostRel)?.[0] ?? null
}

export function isLightClassPath(hostRel: string): boolean {
  const namespace = reviewNamespaceOf(hostRel)
  return namespace !== null && (hostRel === `${namespace}/${LIGHT_REVIEW_DIRECTORY}`
    || hostRel.startsWith(`${namespace}/${LIGHT_REVIEW_DIRECTORY}/`))
}

/** Strict lexical descendants only; no normalization hides traversal. */
export function namespaceRelative(namespaceRoot: string, candidate: string): string[] | null {
  if (candidate.split("/").includes("..") || !candidate.startsWith(`${namespaceRoot}/`)) return null
  const rest = candidate.slice(namespaceRoot.length + 1).split("/")
  return rest.length > 0 && rest.every(part => part.length > 0) ? rest : null
}

/** The configured host root and its caller-read real spelling are the coordinate
 * oracle. Consumers read the real root before mutation and supply it explicitly
 * to keep classification filesystem-free. Outside/non-host roots return null;
 * no consumer may interpret null as light. Two arguments suffice for real roots. */
export function hostRelativePath(hostRoot: string, absolute: string, realRoot = hostRoot): string | null {
  if (!isAbsolute(hostRoot) || basename(hostRoot) !== ".corvus" || !isAbsolute(absolute)) return null
  for (const root of [hostRoot, realRoot]) {
    const suffix = relative(root, absolute)
    if (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) return suffix
  }
  return null
}
