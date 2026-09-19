# DSH integration — status: EXPERIMENTAL / UNVERIFIED

`deepseek_harness` is declared `experimental` in `backend/app/cli.py` and has
no entry in `coding_agent_runtime.RUNTIME_DEFINITIONS`.  It is not a supported
runtime.

## Ghost directory `dsh/dsh-home`

`integrations/dsh/dsh-home` is a dangling NTFS reparse point whose target was
deleted.  Every filesystem API (delete, rename, `rmdir`,
`fsutil reparsepoint delete`) reports "file not found", yet the entry still
appears in directory enumeration — orphaned NTFS metadata, removable only via
`chkdsk`.  It is **untracked by git and referenced by no code**.  Left in place;
treat as inert residue, not a supported integration artifact.
