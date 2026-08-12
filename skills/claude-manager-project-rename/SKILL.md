---
name: claude-manager-project-rename
description: Safely rename (or move) one of Keith's project folders, carrying over everything Claude Code keys to the old folder path — chat history, project memory, tool permissions, and the trusted-folder setting — plus every hardcoded reference inside the project. Handles the Windows lock that stops a folder being renamed while a Claude session is running inside it. Use whenever Keith says "rename this project", "rename the folder", "change the project name", "call this project X instead", or wants a project folder moved.
version: 1.0.0
user-invocable: true
argument-hint: "[new folder name] (and the project, if it isn't the current one)"
---

# Renaming a project folder

A project folder name is not just a folder name. Claude Code keys **four separate things**
to the absolute path, and a naive `Rename-Item` silently orphans three of them. Keith then
loses his chat history for the project, his memory files, his tool permission allowlist, and
gets the "do you trust this folder?" dialog again.

Rename all four together, or don't rename.

---

## The four things keyed to the path

| # | What | Where | Lost if not carried over |
|---|---|---|---|
| 1 | The folder itself | `C:\Users\keith\OneDrive\claude\<NAME>` | — |
| 2 | Session history + project memory | `C:\Users\keith\.claude\projects\<KEY>\` (contains `*.jsonl` transcripts and `memory\`) | All past chats, all saved memories |
| 3 | Per-project settings | `C:\Users\keith\.claude.json` → `projects["<FORWARD/SLASH/PATH>"]` | `allowedTools`, `hasTrustDialogAccepted`, MCP server enable/disable state |
| 4 | Hardcoded references inside the project | various files | Broken scripts, wrong titles, dead dashboard sync |

### How `<KEY>` is derived (thing #2)

Take the **full absolute path** and replace every character that isn't a letter or digit
with a single `-`. Each replaced character produces one `-` (they are not collapsed).

```
C:\Users\keith\OneDrive\claude\Kenn - Call Recording Analyzer
 →  C--Users-keith-OneDrive-claude-Kenn---Call-Recording-Analyzer
```

Note `C:` → `C-` then `\` → `-` gives `C--`, and the ` - ` in the folder name gives `---`.

**Always verify** rather than trusting the derivation: list `C:\Users\keith\.claude\projects\`
and find the folder that matches the old path. Compute the new key the same way and
sanity-check it against the pattern of the old one.

### The `.claude.json` key form (thing #3)

That key uses **forward slashes**, not backslashes:

```
C:/Users/keith/OneDrive/claude/Kenn - Call Recording Analyzer
```

---

## Step 1 — Establish the facts

1. Confirm the exact new folder name Keith wants. Use it verbatim, including capitalisation
   and spacing (`CX-Call Recording Analysis` has no space after `CX-`).
2. Confirm the target does **not** already exist:
   `Test-Path 'C:\Users\keith\OneDrive\claude\<NEW_NAME>'` must be `False`. Stop if it's `True`.
3. Work out whether the folder being renamed is the **current session's working directory**
   (or an ancestor of it). This decides everything downstream — see Step 5.

---

## Step 2 — Survey what will break

Run these before touching anything. Each one has bitten a real rename.

```powershell
$root = 'C:\Users\keith\OneDrive\claude\<OLD_NAME>'

# Python virtualenvs hardcode their absolute path and WILL break
Get-ChildItem -LiteralPath $root -Recurse -Filter 'pyvenv.cfg' -ErrorAction SilentlyContinue

# Launcher scripts — fine if they use %~dp0, broken if they use an absolute path
Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.bat','.cmd','.ps1' }

# Is it a git repo / worktree?
Test-Path (Join-Path $root '.git')
```

Then grep the project for the old folder name **and** the old project key:

```
Grep pattern: <OLD_NAME>|<OLD_KEY>
```

Typical hits worth fixing:
- `CLAUDE.md` / `CLAUDE.txt` — the project heading
- `brain/status-report.html` — `<title>`, `<h1>`, `data-project-key`, `data-project-path`
- any `.py` / `.js` with a hardcoded `base = r'C:/Users/keith/OneDrive/claude/<OLD_NAME>/...'`
- `brain/next.md`, `brain/STATE.md`

Also grep **outside** the project — `C:\Users\keith\OneDrive\claude\claude-manager` at minimum,
plus any sibling project that might cross-reference this one.

**If a virtualenv exists:** tell Keith it has to be recreated after the rename (venvs bake the
absolute path into `pyvenv.cfg` and every `Scripts\*.exe` shim). Offer to do it for him.
**If `.git` is a file rather than a folder,** it's a worktree pointing at an absolute gitdir —
that needs fixing too; flag it.

---

## Step 3 — Update the internal references

Do this **before** the rename, so the moment the folder changes everything is already correct.

For the `data-project-key` / `data-project-path` attributes in `brain/status-report.html`,
use the newly computed key and the new absolute path. Leave `data-sync-port` and
`data-sync-token` alone.

---

## Step 4 — Update the brain files

- `brain/STATE.md` — bump the date, retitle the project heading, and add a short blockquote at
  the top saying the rename is pending and how to finish it (delete that note once done).
- `brain/next.md` — add a note at the very top so a cold session checks the folder name first
  and knows not to attempt the rename from inside a session.
- `brain/changelog.md` — append a dated entry listing every file changed and both old/new keys.

---

## Step 5 — Execute, or hand off

### Case A — the folder is NOT the current working directory

Just do it, in this order, from a shell whose location is somewhere else entirely:

```powershell
Rename-Item -LiteralPath '<OLD_FULL_PATH>' -NewName '<NEW_NAME>'
Rename-Item -LiteralPath 'C:\Users\keith\.claude\projects\<OLD_KEY>' -NewName '<NEW_KEY>'
```

Then apply the `.claude.json` edit described below. Verify, tell Keith it's done, stop here.

### Case B — the folder IS the current working directory (the usual case)

**Windows will refuse the rename.** A process holds an open handle on its own current
directory without delete-sharing, so the running Claude Code session blocks it. The error is:

```
The process cannot access the file because it is being used by another process.
```

You cannot work around this from inside the session. Do **not**:

- try to kill the terminal or the Claude process (Windows Terminal is one process for **all**
  of Keith's windows and tabs — see the `SSX!` note in his global CLAUDE.md);
- install a scheduled task or a detached background watcher to do the rename after exit.
  The safety classifier blocks writing that kind of persistent auto-run script, correctly.

Instead, write a **single visible, double-clickable `.cmd` on Keith's Desktop**
(`[Environment]::GetFolderPath('Desktop')`) and have him run it after closing his windows.
That is the pattern: one file, one click, self-explanatory output, deletable afterwards.

Use the template at the end of this skill.

#### Which windows actually need closing — be precise, Keith has ~6 sessions open

Don't tell him "close everything" reflexively. The two halves of the job have different scopes:

| Job | Whose windows matter |
|---|---|
| Renaming the folder + the history/memory dir | **Only sessions running inside the project being renamed.** Claude windows for other projects are irrelevant. |
| Carrying over `~\.claude.json` | **All of them.** That file is shared across every project, so any live session can overwrite the edit when it exits. |

The first row is verified, not assumed — a directory is only locked by processes whose current
directory is inside *that* directory. To re-confirm on a future machine:

```powershell
$a = 'C:\...\scratch\A'; $b = 'C:\...\scratch\B'
New-Item -ItemType Directory -Path $a,$b -Force | Out-Null
$p = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 25' `
       -WorkingDirectory $a -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1500
Rename-Item $a 'A_renamed'   # BLOCKED
Rename-Item $b 'B_renamed'   # SUCCEEDS
```

So the honest instruction is: **close the windows for this project** to get the rename, and
**close the rest too if it's convenient** to guarantee the settings carry over. If the settings
edit does get clobbered the only symptom is one "do you trust this folder?" dialog — say that,
so he can judge whether it's worth closing six terminals.

Have the script detect it rather than relying on him: `@(Get-Process claude -ErrorAction
SilentlyContinue).Count` counts live Claude Code sessions (the process is `claude.exe`; the
`cmd /k claude` wrappers are separate). If it's above zero after the settings edit, print a
note telling him what might be undone and that re-running the file fixes it.

---

## The `.claude.json` edit (both cases)

Do **not** round-trip the file through `ConvertFrom-Json` / `ConvertTo-Json`. It's ~250 KB and
PowerShell 5.1's serialiser mangles it (default `-Depth 2`, reformatting, unicode escaping).

Do a **targeted string replace**, then validate and roll back on failure:

1. Count occurrences of the forward-slash old path first — expect exactly `1` (the project key).
   If it's more, read them before replacing; if it's `0`, check whether the escaped-backslash
   form `C:\\Users\\...` is used instead.
2. Back up to `.claude.json.bak-rename`.
3. Replace, then `ConvertFrom-Json` the **result** purely as a validity check.
4. If parsing throws, restore the backup and report it — never leave a broken config.

This must run **after** all Claude sessions are closed, otherwise a session writes the old key
back on shutdown. In Case B that means it belongs inside the Desktop `.cmd`.

---

## Step 6 — Verify and report

Verification: the old folder is gone, the new one exists, `.claude\projects\<NEW_KEY>` exists
and still contains `memory\`, and `.claude.json` still parses with the new key present.

Report to Keith in plain language, per his global CLAUDE.md: lead with what he needs to do
(at most two steps), then what you already handled. Don't hand him a checklist.

---

## Handoff script template

Replace every `<...>` placeholder. Keep it ASCII-only and **write it without a BOM** — a UTF-8
byte-order mark ahead of `@echo off` garbles the first line of a batch file. Verify after
writing: the first four bytes must be `40 65 63 68`.

```bat
@echo off
title Rename project folder to <NEW_NAME>
cd /d "C:\Users\keith\OneDrive\claude"
echo.
echo  Renaming:  <OLD_NAME>
echo        to:  <NEW_NAME>
echo.

if exist "<NEW_NAME>" goto already
if not exist "<OLD_NAME>" goto missing

ren "<OLD_NAME>" "<NEW_NAME>"
if not exist "<NEW_NAME>" goto locked

echo   [OK]  Project folder renamed.
goto carryover

:already
echo   [OK]  Project folder already renamed.
goto carryover

:carryover
pushd "%USERPROFILE%\.claude\projects"
if exist "<OLD_KEY>" (
  ren "<OLD_KEY>" "<NEW_KEY>"
  if exist "<NEW_KEY>" echo   [OK]  Chat history and project memory carried over.
)
popd

powershell -NoProfile -ExecutionPolicy Bypass -Command "$others=@(Get-Process claude -ErrorAction SilentlyContinue).Count; $f=Join-Path $env:USERPROFILE '.claude.json'; if(Test-Path $f){ $bak=$f+'.bak-rename'; Copy-Item $f $bak -Force; $t=[IO.File]::ReadAllText($f); $t2=$t.Replace('<OLD_FWD_PATH>','<NEW_FWD_PATH>'); if($t2 -eq $t){ Write-Host '  [i]   Permissions and trusted-folder setting already up to date.' } else { try{ $null=ConvertFrom-Json -InputObject $t2; [IO.File]::WriteAllText($f,$t2); Write-Host '  [OK]  Permissions and trusted-folder setting carried over.' } catch { Copy-Item $bak $f -Force; Write-Host '  [!]   Could not update settings - original file restored.' } } }; if($others -gt 0){ Write-Host ''; Write-Host ('  [!]   ' + $others + ' other Claude window(s) are still open. Claude shares one'); Write-Host '        settings file across all projects, so one of them may undo the'; Write-Host '        line above when it closes.'; Write-Host '        Not serious - it would just ask you to trust this folder once.'; Write-Host '        To avoid it: close them and double-click this file again.' }"
goto done

:missing
echo   [X]   Could not find the folder "<OLD_NAME>".
echo         It may have already been renamed or moved.
goto end

:locked
echo   [X]   Could not rename - something still has that folder open.
echo.
echo         Close any Claude Code window that is running IN THIS PROJECT,
echo         plus any File Explorer window or open file inside the folder.
echo         Claude windows for OTHER projects do not matter here.
echo.
echo         Then double-click this file again.
goto end

:done
echo.
echo   All finished. You can delete this file from your Desktop.
:end
echo.
pause
```

### Checking the template before handing it over

The embedded PowerShell uses **single quotes only** so it survives batch's quoting rules, and
contains no `%`, `|`, `&` or `>` characters. If you edit it, keep it that way, and syntax-check
it without executing (executing it mid-session would edit the live config):

```powershell
$line = (Get-Content -LiteralPath $cmd) | Where-Object { $_ -like 'powershell -NoProfile*' }
$code = $line -replace '^powershell -NoProfile -ExecutionPolicy Bypass -Command "(.*)"$','$1'
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$null, [ref]$errs)
$errs
```

---

## Gotchas learned the hard way

- **OneDrive** handles a folder rename as a move, not a re-upload. No special handling needed.
- **`%~dp0` in launcher scripts survives the rename.** Absolute paths don't. Check which.
- **`node_modules` is fine** — its `.bin` shims are relative.
- **Python venvs are not fine.** Recreate them.
- The **scratchpad and tool-results directories** under `.claude\projects\<KEY>\<session-id>\`
  move with the key rename; nothing extra to do.
- After the rename, the **spend tracker** will show the project under its new name. Older spend
  history keyed to the old name stays under the old label — harmless, but mention it if Keith
  asks why a project appears twice.

---

## Where this skill lives

It exists in two places, deliberately:

| Copy | Path | Role |
|---|---|---|
| Canonical | `C:\Users\keith\OneDrive\claude\claude-manager\skills\claude-manager-project-rename\SKILL.md` | Source of truth. Version-controlled with the claude-manager repo. |
| Installed | `C:\Users\keith\.claude\skills\claude-manager-project-rename\SKILL.md` | What Claude Code actually loads. Must be a real file here — skills are only global from `~\.claude\skills\`. |

A project-scoped copy under `claude-manager\.claude\skills\` would **not** work: this skill has
to run from inside whichever project is being renamed, so it must be installed globally.

**If you edit this skill, update both copies.** Edit the installed copy, then
`Copy-Item` it over the canonical one and commit the repo — that order keeps them byte-identical.
