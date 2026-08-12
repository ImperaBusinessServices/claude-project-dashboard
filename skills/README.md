# Skills

Canonical source for Claude Code skills that belong to claude-manager — the ones about
managing Keith's Claude projects themselves, rather than about building any one project.

Kept here so they're version-controlled and backed up with the repo.

## Important: these are sources, not the installed copies

Claude Code only loads global skills from `C:\Users\keith\.claude\skills\`. A skill sitting
in this repo does nothing on its own. Each one must also exist as a **real folder** (not a
symlink or junction — Claude Code's skill scan skips reparse points) at:

```
C:\Users\keith\.claude\skills\<skill-name>\SKILL.md
```

### Installing / updating

Edit the installed copy first, then mirror it here and commit:

```powershell
$name = 'claude-manager-project-rename'
Copy-Item "$env:USERPROFILE\.claude\skills\$name\SKILL.md" `
          ".\skills\$name\SKILL.md" -Force
```

Verify they match with `Get-FileHash` on both before committing.

## Skills in here

| Skill | Invoke as | What it does |
|---|---|---|
| `claude-manager-project-rename` | `/claude-manager-project-rename` | Renames a project folder and carries over everything Claude Code keys to the old path — chat history, project memory, tool permissions, trusted-folder setting — plus hardcoded references inside the project. Handles the Windows lock that blocks renaming a folder a session is running in. |
