# Claude Project Dashboard

A simple Windows desktop app for managing your Claude Code project folders. Built for non-technical users — designed to make working with Claude Code feel effortless.

## What it does

- **See all your Claude Code projects** as cards in one window
- **Launch Claude Code** in any project with one click — opens a terminal in that folder and starts a session
- **Generate status reports** for any project, pulled from the project's `brain/` folder
- **Track project state across sessions** via per-project `brain/` notes that Claude reads and updates
- **Beep when Claude is waiting on you** so you can switch tasks while it works
- **Auto-update** when new versions ship — click "Check for updates" in the About page

## Install

1. Go to the [latest release](https://github.com/Remagent001/claude-project-dashboard/releases/latest)
2. Download `Claude Project Dashboard Setup X.Y.Z.exe`
3. Double-click to install. Windows SmartScreen may show a warning — click **More info → Run anyway**. (The app isn't code-signed; this is a one-person side project, not malware.)
4. The installer is one-click — no admin rights needed, installs per-user.

## Updating

From inside the app: **About → Check for updates → Download & Install**. The app handles the rest.

## Built with

- [Electron](https://www.electronjs.org/)
- A small amount of Node.js
- No frameworks on the renderer side — plain HTML/CSS/JS so it stays hackable

## License

ISC
