/** Test-owned contract, independent of packaged permissions and prompt prose. */
export const LIGHT_BASH_DENIES = ["git add*", "git commit*", "git push*", "git switch*", "git checkout*",
  "git restore --staged*", "git reset*", "git stash*", "gh pr checkout*", "gh api*", "gh pr review*",
  "gh pr comment*", "gh pr merge*", "gh pr edit*", "git -C*", "git -c*", "git update-ref*", "git rm*", "git branch*",
  "git worktree*", "git read-tree*", "git --*", "git merge*", "git pull*", "git rebase*", "git cherry-pick*",
  "git revert*", "git am*", "git apply*", "git restore*", "git clean*", "git mv*", "git tag*", "git config*",
  "git notes*", "git update-index*", "git symbolic-ref*", "git gc*", "git prune*", "gh pr close*", "gh pr ready*",
  "gh pr create*", "gh issue*", "gh release*", "gh repo*", "gh workflow*", "gh run*", "gh label*", "gh secret*",
  "gh variable*", "gh gist*"]
export const LIGHT_MUTATIONS = ["git add .", "git commit -m probe", "git push origin HEAD", "git switch main",
  "git checkout --detach HEAD", "git restore --staged file", "git reset HEAD file", "git stash push", "gh pr checkout 1",
  "gh api --method POST repos/example/project/pulls/42/reviews", "gh pr review 42 --approve", "gh pr comment 42 --body probe",
  "gh pr merge 42", "gh pr edit 42 --title probe", "git -C . add .", "git -c core.hooksPath=/dev/null commit -m probe",
  "git update-ref refs/heads/main HEAD", "git rm file", "git branch -D main", "git worktree add --detach ../review HEAD",
  "git worktree remove --force ../review", "git worktree prune", "git read-tree -u --reset HEAD",
  "git --git-dir=.git read-tree -u --reset HEAD", "git --work-tree=. reset --hard HEAD", "git --no-optional-locks worktree add ../review HEAD",
  "git merge FETCH_HEAD", "git pull", "git rebase main", "git cherry-pick HEAD", "git revert HEAD", "git am patch.mbox",
  "git apply patch.diff", "git restore .", "git clean -fd", "git mv old new", "git tag v1", "git config core.hooksPath x",
  "git notes add -m probe", "git update-index --add file", "git symbolic-ref HEAD refs/heads/main", "git gc", "git prune",
  "gh pr close 15", "gh pr ready 15", "gh pr create --title probe", "gh issue create --title probe", "gh release create v1",
  "gh repo delete example/project", "gh workflow disable ci", "gh run cancel 1", "gh label create probe", "gh secret set TOKEN",
  "gh variable set NAME --body probe", "gh gist create file"]
export const LIGHT_READS = ["git fetch --no-tags origin pull/42/head", "git fetch --no-tags https://github.com/example/project.git pull/42/head",
  "git remote get-url origin", "git ls-files -- .corvus/reviews/pr42/lock.yaml", "git show HEAD:src/index.ts",
  "git diff HEAD", "git log -1", "git rev-parse HEAD", "git cat-file -e 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{commit}'",
  "git remote -v", "date -u +%Y-%m-%dT%H:%M:%SZ"]

// These are contract scenarios, not simulated model runs. Tests assert the real
// prompt's evidence-selection and omission instructions for each input shape.
export const LIGHT_EVIDENCE_CASES = [
  { name: "PR head differs from worktree", mode: "pr", code_head: "a".repeat(40), base_sha: "b".repeat(40),
    worktree_head: "c".repeat(40), merge_base: null, head_content: "available", diagnostic: null,
    path: "src/example.ts", pr_head_bytes: "export const limit = 1", worktree_bytes: "export const limit = 100" },
  { name: "head preparation failed", mode: "pr", code_head: "a".repeat(40), base_sha: "b".repeat(40),
    worktree_head: "c".repeat(40), merge_base: null, head_content: "unavailable", diagnostic: "fetch failed: remote unavailable",
    path: "src/example.ts", pr_head_bytes: null, worktree_bytes: "export const limit = 100" },
  { name: "LOCAL tracked staged and unstaged evidence", mode: "local", code_head: "c".repeat(40), base_sha: "b".repeat(40),
    worktree_head: "c".repeat(40), merge_base: "b".repeat(40), head_content: null, diagnostic: null,
    path: "src/example.ts", pr_head_bytes: null, worktree_bytes: "export const limit = 100", staged: "limit = 10", unstaged: "limit = 100" },
] as const
