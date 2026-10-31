import { describe, expect, test } from "bun:test"
import { hostRelativePath, isLightClassPath, LIGHT_REVIEW_DIRECTORY, namespaceRelative, reviewNamespaceOf } from "../review-storage-class"

describe("host-relative review storage class", () => {
  test.each(["reviews/pr42", "reviews/local-feature", "tasks/feature/reviews/pr42",
    "tasks/.light/reviews/pr42", "tasks/.staging/reviews/local-a"])("classifies only the direct class of %s", namespace => {
    expect(reviewNamespaceOf(namespace)).toBe(namespace)
    for (const suffix of ["", "/", "/candidate.json", "/.staging/candidate/manifest.json"]) {
      expect(reviewNamespaceOf(`${namespace}/${LIGHT_REVIEW_DIRECTORY}${suffix}`)).toBe(namespace)
      expect(isLightClassPath(`${namespace}/${LIGHT_REVIEW_DIRECTORY}${suffix}`)).toBe(true)
    }
    for (const suffix of ["", "/candidate.json", "/head/.light/x", "/.lightish/x", "/.lightish/.light/x"])
      expect(isLightClassPath(`${namespace}${suffix}`)).toBe(false)
  })

  test.each(["reviews/pr0/.light", "reviews/pr01/.light/x", "reviews/o__r__pr1/.light/x",
    "tasks/./reviews/pr1/.light/x", "tasks/../reviews/pr1/.light/x", "x/reviews/pr1/.light/x",
    "/fixture/reviews/pr1/.light/x", ".corvus/reviews/pr1/.light/x", "reviews/pr1x/.light/x",
    "reviews/local-/.light/x", ".light/candidate.json"])("rejects non-host or invalid namespace %s", path => {
    expect(reviewNamespaceOf(path)).toBeNull()
    expect(isLightClassPath(path)).toBe(false)
  })

  test("namespace children are lexical, strict and traversal-free", () => {
    const root = ".corvus/tasks/.light/reviews/pr42"
    expect(namespaceRelative(root, `${root}/.light/x`)).toEqual([".light", "x"])
    expect(namespaceRelative(root, `${root}/head/.light/x`)).toEqual(["head", ".light", "x"])
    for (const path of [root, `${root}/`, `${root}ish/x`, `${root}/../x`, `${root}/x/../../x`, "outside/x"])
      expect(namespaceRelative(root, path)).toBeNull()
  })

  test("host coordinates ignore ancestors and admit configured/real spellings only inside a host root", () => {
    const host = "/fixture/reviews/pr7/.light/ws/.corvus", real = "/real/ws/.corvus"
    expect(hostRelativePath(host, `${host}/tasks/.light/reviews/pr42`)).toBe("tasks/.light/reviews/pr42")
    expect(hostRelativePath(host, `${real}/reviews/pr1/.light/x`)).toBeNull()
    expect(hostRelativePath(host, `${real}/reviews/pr1/.light/x`, real)).toBe("reviews/pr1/.light/x")
    expect(hostRelativePath(host, "/outside/reviews/pr1/.light/x", real)).toBeNull()
    expect(hostRelativePath(host, `${host}ish/reviews/pr1/.light/x`)).toBeNull()
    expect(hostRelativePath("/fixture/reviews", "/fixture/reviews/pr1/.light/x")).toBeNull()
    expect(hostRelativePath(".corvus", ".corvus/reviews/pr1/.light/x")).toBeNull()
  })
})
