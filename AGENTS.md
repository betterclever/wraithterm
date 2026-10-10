# Working on Wraith

Commit completed, validated milestones as work proceeds. Use focused commits with
an imperative subject explaining the change, and record relevant validation in
the commit body. Do not defer all work to a final catch-all commit or fabricate
historical commits. Preserve unrelated user changes. Never push, publish, or
create a release without authorization.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for checks and generated-file policy.
Before committing, review the staged diff and file list, run `git diff --cached
--check`, and confirm no caches, traces, secrets, or scratch files are staged.

Keep performance claims tied to the workload, hardware, build hash, and raw
measurements. GPU-completed throughput and display presentation are distinct.
Keep both the libghostty profile and xterm-compatible profile working.
