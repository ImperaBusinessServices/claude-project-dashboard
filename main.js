const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

const APP_VERSION = require('./package.json').version;
const GITHUB_OWNER = 'ImperaBusinessServices';
const GITHUB_REPO = 'claude-project-dashboard';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`;

const HOME = process.env.USERPROFILE || process.env.HOME;
const SETTINGS_PATH = path.join(HOME, '.claude-manager-settings.json');
const GLOBAL_CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// Folders to skip when scanning
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'venv', '.cache', 'build', 'coverage']);

const MEMORY_PROTOCOL_BEGIN = '<!-- BEGIN: claude-manager memory protocol v1 -->';
const MEMORY_PROTOCOL_END = '<!-- END: claude-manager memory protocol v1 -->';
const MEMORY_PROTOCOL_TEMPLATE = `${MEMORY_PROTOCOL_BEGIN}

## Project memory protocol

Each project may contain a \`brain/\` folder for persistent context across Claude Code sessions:
- \`STATE.md\` — what's in flight right now
- \`next.md\` — a checklist of what's next. Mark each item \`- [ ]\` not started, \`- [~]\` in progress, \`- [?]\` done & awaiting the user's OK, \`- [x]\` approved & closed. **Claude marks finished work \`[?]\` (never \`[x]\`)** — only the user gives final approval by closing it. The status report renders these and the user can tick them off too (their clicks sync back here while the dashboard is open), so keep them current.
- \`changelog.md\` — append-only log: YYYY-MM-DD — what changed, with file paths
- \`decisions.md\` — decisions with a one-line Why
- \`links.md\` (optional) — for a project with several live pages/things: one bullet per link, \`- [Name](https://url) — short description\`. Shown pinned at the top of the status report.

### Triggers
- **"WWW?"** / **"where were we?"** → read \`./brain/STATE.md\`, \`./brain/next.md\`, and the last 20 lines of \`./brain/changelog.md\`. Tell the user where we are and what's next. If no \`brain/\` folder, say "no project memory here yet — want me to start one?" and bootstrap on yes.
- **"save state"** / **"SS!"** → make \`STATE.md\`/\`next.md\`/\`changelog.md\`/\`decisions.md\` current and consistent. Confirm done in one sentence.

### Update protocol (automatic — don't wait to be asked)
- After every meaningful step → update \`./brain/STATE.md\` and append to \`./brain/changelog.md\` (with file paths of what changed).
- On any decision that affects future work → append to \`./brain/decisions.md\` with a one-line **Why:**.
- Before a natural pause → run the "save state" sweep.

### Date convention
Always write dates as \`YYYY-MM-DD\`. Convert relative references ("yesterday", "Thursday") to absolute dates when filing.

${MEMORY_PROTOCOL_END}`;

let mainWindow;
let settings = loadSettings();

// Tray meter state (the optional Zeno-style live icon + click-popup)
let tray = null;
let flyoutWindow = null;
let latestUsage = null;   // last good usage payload, cached from the renderer
let isQuitting = false;   // true once we're really quitting (not close-to-tray)

// Two-way status-report sync: a tiny loopback HTTP server the browser report
// pings (via sendBeacon) when you click a task, so we can write the new state
// back into that project's brain/next.md. 127.0.0.1 only — never exposed.
let syncServer = null;
let syncPort = null;
// Random per-launch secret. Embedded only into the locally-generated report
// files, and required on every sync request — so a random web page you visit
// can't forge clicks into your next.md files even though the port is loopback.
let syncToken = crypto.randomBytes(16).toString('hex');

// Single-instance lock: if a copy of the app is already running (e.g. hidden in
// the tray with the meter on), don't start a second one — just resurface the
// existing window. Without this, every launch spawned a fresh process and a
// fresh tray icon, so opening/closing repeatedly piled up duplicate meters.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch (e) {}
  // Auto-detect common Claude project locations (skip .claude — it's config, not projects)
  const candidates = [
    path.join(HOME, 'OneDrive', 'claude'),
    path.join(HOME, 'claude-projects'),
    path.join(HOME, 'Documents', 'claude'),
    path.join(HOME, 'Projects')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return { projectRoot: dir };
    }
  }
  return { projectRoot: '' };
}

function saveSettings(s) {
  settings = s;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// Find the newest file modification time inside a directory (recursive, shallow limit)
function newestMtime(dir, depth = 0) {
  if (depth > 4) return 0;
  let newest = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const sub = newestMtime(full, depth + 1);
        if (sub > newest) newest = sub;
      } else {
        try {
          const mt = fs.statSync(full).mtimeMs;
          if (mt > newest) newest = mt;
        } catch (e) {}
      }
    }
  } catch (e) {}
  return newest;
}

// Get top-level folders only, with subfolder info
function findProjects(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const stats = fs.statSync(fullPath);
      const hasClaudeMd = fs.existsSync(path.join(fullPath, 'CLAUDE.md'));
      const subprojects = [];
      findSubProjects(fullPath, subprojects, 0);
      const fileModified = newestMtime(fullPath);
      results.push({
        name: entry.name,
        path: fullPath,
        modified: Math.max(stats.mtimeMs, fileModified),
        created: stats.birthtimeMs,
        hasClaudeMd,
        subprojects
      });
    }
  } catch (e) {}
  return results;
}

function findSubProjects(dir, results, depth) {
  if (depth > 3) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (fs.existsSync(path.join(fullPath, 'CLAUDE.md'))) {
        results.push(path.relative(path.dirname(dir), fullPath).replace(/\\/g, '/'));
      }
      findSubProjects(fullPath, results, depth + 1);
    }
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true,
    titleBarStyle: 'default',
    title: 'Claude Project Dashboard'
  });

  mainWindow.loadFile('index.html');

  // Open target="_blank" / external links in the user's real browser instead
  // of a bare Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close-to-tray: when the tray meter is on, the X button hides the window
  // (the app keeps running in the tray, Zeno-style) instead of quitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting && settings.trayEnabled) {
      e.preventDefault();
      mainWindow.hide();
      if (!settings.trayBalloonShown && tray) {
        try {
          tray.displayBalloon({
            title: 'Still running',
            content: 'The usage meter is here in your tray. Click it to reopen the dashboard, or right-click to quit.'
          });
        } catch (err) {}
        saveSettings({ ...settings, trayBalloonShown: true });
      }
    }
  });
}

if (gotInstanceLock) {
  app.whenReady().then(() => {
    createWindow();
    if (settings.trayEnabled) createTray();
    startSyncServer();
  });
}
app.on('before-quit', () => { isQuitting = true; });
// Only quit on all-windows-closed when the tray meter isn't keeping us alive.
app.on('window-all-closed', () => { if (!settings.trayEnabled) app.quit(); });

// ---- Two-way status-report sync server (loopback only) ----
// Flip the marker on one task line in a project's brain/next.md:
// state 0 -> [ ], 1 -> [~], 2 -> [?], 3 -> [x]. Matches the task by its exact
// source text so it survives the file being re-ordered. Only ever touches that
// single file, and only a single character on a matching line.
// A sync request may only target a folder inside the dashboard's project root
// (junction-linked projects live under the root too, so this still covers them).
function isAllowedProjectPath(projectPath) {
  try {
    if (!projectPath || typeof projectPath !== 'string') return false;
    var root = settings.projectRoot;
    if (!root) return false;
    var normRoot = path.resolve(root).toLowerCase();
    var normProj = path.resolve(projectPath).toLowerCase();
    return normProj !== normRoot && normProj.indexOf(normRoot + path.sep) === 0;
  } catch (e) { return false; }
}

function applyTaskStateToNextMd(projectPath, taskText, state) {
  try {
    if (!projectPath || typeof projectPath !== 'string') return false;
    var norm = path.normalize(projectPath);
    if (norm.indexOf('..') !== -1) return false;
    var marker = ({ 0: ' ', 1: '~', 2: '?', 3: 'x' })[state];
    if (marker === undefined) return false;
    var nextPath = path.join(norm, 'brain', 'next.md');
    if (!fs.existsSync(nextPath)) return false;
    var want = String(taskText || '').trim();
    if (!want) return false;
    var lines = fs.readFileSync(nextPath, 'utf-8').split(/\r?\n/);
    var changed = false;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(\s*[-*]\s+\[)[ xX~/?-](\]\s+)(.*)$/);
      if (m && m[3].trim() === want) {
        lines[i] = m[1] + marker + m[2] + m[3];
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    fs.writeFileSync(nextPath, lines.join('\n'));
    return true;
  } catch (e) { return false; }
}

function startSyncServer() {
  if (syncServer) return;
  var server = http.createServer(function (req, res) {
    // No CORS headers on purpose: the report fires the click and ignores the
    // response, so cross-origin pages gain nothing — and we don't want to invite
    // them to read it. Reject anything that isn't a loopback POST to /task.
    var host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); res.end(); return; }
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== '/task') {
      res.writeHead(404); res.end(); return;
    }
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 65536) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      var code = 400;
      try {
        var data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (data.token !== syncToken) {
          code = 403;  // forged request (a real report carries the launch token)
        } else if (!isAllowedProjectPath(data.project)) {
          code = 403;  // path outside the dashboard's project folder
        } else {
          code = applyTaskStateToNextMd(data.project, data.task, data.state) ? 204 : 400;
        }
        if (process.env.USAGE_DEBUG) console.log('[sync] ' + JSON.stringify(data.task) + ' -> ' + data.state + ' code=' + code);
      } catch (e) {}
      try { res.writeHead(code); res.end(); } catch (e) {}
    });
    req.on('error', function () { try { res.writeHead(400); res.end(); } catch (e) {} });
  });
  var candidates = [47615, 47616, 47617, 47618, 47619];
  var idx = 0;
  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE' && idx < candidates.length) {
      server.listen(candidates[idx++], '127.0.0.1');
    } else {
      syncServer = null; syncPort = null;
    }
  });
  server.on('listening', function () {
    syncServer = server;
    syncPort = server.address().port;
    if (process.env.USAGE_DEBUG) console.log('[sync] listening on 127.0.0.1:' + syncPort);
  });
  server.listen(candidates[idx++], '127.0.0.1');
}

// ---- Tray meter (live system-tray usage icon + click-popup flyout) ----

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.ico')));
  tray.setToolTip('Claude usage — waiting…');
  tray.on('click', (event, bounds) => toggleFlyout(bounds));
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open Dashboard', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]));
  });
  // Ask the renderer to draw the current gauge right away (if it has data)
  if (mainWindow) mainWindow.webContents.send('tray-render-now');
}

function destroyTray() {
  if (flyoutWindow) { try { flyoutWindow.close(); } catch (e) {} flyoutWindow = null; }
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
}

function createFlyout() {
  flyoutWindow = new BrowserWindow({
    width: 300, height: 230,
    show: false, frame: false, resizable: false, movable: false,
    transparent: true, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  flyoutWindow.loadFile('tray-flyout.html');
  flyoutWindow.on('blur', () => { if (flyoutWindow && !flyoutWindow.webContents.isDevToolsFocused()) flyoutWindow.hide(); });
}

function toggleFlyout(bounds) {
  if (!flyoutWindow) createFlyout();
  if (flyoutWindow.isVisible()) { flyoutWindow.hide(); return; }
  const w = 300, h = 230;
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const wa = display.workArea;
  // Center over the tray icon if we have its bounds, else over the cursor
  let cx = (bounds && bounds.width) ? (bounds.x + bounds.width / 2) : pt.x;
  let x = Math.round(cx - w / 2);
  let y = wa.y + wa.height - h - 6;        // just above the taskbar
  x = Math.min(Math.max(wa.x + 4, x), wa.x + wa.width - w - 4);
  flyoutWindow.setBounds({ x, y, width: w, height: h });
  flyoutWindow.webContents.send('tray-usage', latestUsage);
  flyoutWindow.show();
  flyoutWindow.focus();
}

// Renderer pushes each fresh usage payload here so the tray + flyout stay in sync
// without adding a second poller (the endpoint rate-limits easily).
ipcMain.on('usage-update', (event, data) => {
  if (data && data.success) latestUsage = data;
  if (flyoutWindow && flyoutWindow.isVisible()) {
    flyoutWindow.webContents.send('tray-usage', latestUsage);
  }
});

ipcMain.on('set-tray-icon', (event, dataUrl, tooltip) => {
  if (process.env.USAGE_DEBUG) console.log('[tray] set-icon dataUrlLen=' + (dataUrl ? dataUrl.length : 0) + ' tip=' + JSON.stringify(tooltip));
  if (!tray) return;
  try {
    if (dataUrl) tray.setImage(nativeImage.createFromDataURL(dataUrl));
    if (tooltip) tray.setToolTip(tooltip);
  } catch (e) {}
});

ipcMain.handle('get-cached-usage', async () => latestUsage);
ipcMain.handle('show-main-window', async () => { showMainWindow(); if (flyoutWindow) flyoutWindow.hide(); });
ipcMain.handle('quit-app', async () => { isQuitting = true; app.quit(); });

ipcMain.handle('get-tray-enabled', async () => !!settings.trayEnabled);
ipcMain.handle('set-tray-enabled', async (event, enabled) => {
  saveSettings({ ...settings, trayEnabled: !!enabled });
  if (enabled) {
    createTray();
  } else {
    destroyTray();
    if (mainWindow && !mainWindow.isVisible()) showMainWindow();
  }
  return !!settings.trayEnabled;
});

// Get settings
ipcMain.handle('get-settings', async () => {
  return settings;
});

// Choose project root folder
ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Claude projects folder',
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    saveSettings({ ...settings, projectRoot: result.filePaths[0] });
    return settings;
  }
  return settings;
});

// Get all project folders (with archive status + cached summary)
ipcMain.handle('get-folders', async () => {
  if (!settings.projectRoot || !fs.existsSync(settings.projectRoot)) {
    return [];
  }
  const archived = settings.archived || {};
  const summaries = settings.summaries || {};
  const projects = findProjects(settings.projectRoot);
  return projects.map(p => ({
    ...p,
    archived: !!archived[p.path],
    summary: summaries[p.path] ? summaries[p.path].text : null,
    summaryManual: summaries[p.path] ? !!summaries[p.path].manual : false,
    hasBrain: hasBrainFolder(p.path),
    hasStatusReport: hasStatusReport(p.path)
  }));
});

// Toggle archive status for a project
ipcMain.handle('toggle-archive', async (event, folderPath) => {
  if (!settings.archived) settings.archived = {};
  if (settings.archived[folderPath]) {
    delete settings.archived[folderPath];
  } else {
    settings.archived[folderPath] = true;
  }
  saveSettings(settings);
  return settings.archived[folderPath] || false;
});

// Create new folder (with a CLAUDE.md so it's a proper project)
ipcMain.handle('create-folder', async (event, folderName) => {
  const fullPath = path.join(settings.projectRoot, folderName);
  if (fs.existsSync(fullPath)) {
    return { success: false, error: 'Folder already exists' };
  }
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    fs.writeFileSync(path.join(fullPath, 'CLAUDE.md'), `# ${folderName}\n\nProject instructions go here.\n`);
    if (settings.createBrainOnNewProject !== false) {
      scaffoldBrain(fullPath, folderName);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Create brain/ folder with starter memory files so Claude's save-state protocol
// works in this project from day one. Matches the convention in the global CLAUDE.md.
function scaffoldBrain(projectPath, projectName) {
  const brainDir = path.join(projectPath, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  const files = {
    'STATE.md': `# ${projectName} — STATE\n\n<!-- What's in flight right now. Updated as work progresses. -->\n`,
    'next.md': `# next\n\n<!-- Checklist of what's next. Markers: [ ] = not started, [~] = in progress, [?] = done, awaiting Keith's OK, [x] = approved & closed. Claude marks finished work [?] (never [x]); only Keith closes with [x]. The status report shows and edits these. -->\n\n- [ ] First task goes here\n`,
    'changelog.md': `# changelog\n\n<!-- Append-only log: YYYY-MM-DD — what changed, file paths. -->\n`,
    'decisions.md': `# decisions\n\n<!-- Project decisions with a one-line Why. -->\n`
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(brainDir, name), body);
  }
}

// Get/set the "create brain/ on new project" toggle (defaults to ON when unset)
ipcMain.handle('get-create-brain-enabled', async () => {
  return settings.createBrainOnNewProject !== false;
});
ipcMain.handle('set-create-brain-enabled', async (event, enabled) => {
  const s = { ...settings, createBrainOnNewProject: !!enabled };
  saveSettings(s);
  return !!enabled;
});

// Track launched terminal PIDs per project
const launchedTerminals = {};

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// Open folder in terminal and start Claude Code
ipcMain.handle('open-terminal', async (event, folderPath) => {
  // Check if we already launched a terminal for this project
  const existing = launchedTerminals[folderPath];
  if (existing && isProcessRunning(existing)) {
    // Try to bring existing terminal window to front
    exec(`powershell -Command "(Get-Process -Id ${existing} -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowHandle })" `, (err, stdout) => {
      const hwnd = stdout.trim();
      if (hwnd && hwnd !== '0') {
        exec(`powershell -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }'; [Win]::ShowWindow([IntPtr]${hwnd}, 9); [Win]::SetForegroundWindow([IntPtr]${hwnd})"`);
      }
    });
    return { alreadyOpen: true };
  }

  // Launch new terminal with project name as tab title
  const projectName = path.basename(folderPath);
  const child = exec(`wt --title "${projectName}" --suppressApplicationTitle -d "${folderPath}" cmd /k claude`, (err) => {
    if (err) {
      const fallback = exec(`start cmd /k "cd /d ${folderPath} && claude"`);
      if (fallback.pid) launchedTerminals[folderPath] = fallback.pid;
    }
  });
  if (child.pid) launchedTerminals[folderPath] = child.pid;
  return { alreadyOpen: false };
});

// Open CLAUDE.md for a project
ipcMain.handle('open-claude-md', async (event, folderPath) => {
  const claudeMdPath = path.join(folderPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `# ${path.basename(folderPath)}\n\nProject instructions go here.\n`);
  }
  shell.openPath(claudeMdPath);
});

// Open global CLAUDE.md
ipcMain.handle('open-global-claude-md', async () => {
  if (fs.existsSync(GLOBAL_CLAUDE_MD)) {
    shell.openPath(GLOBAL_CLAUDE_MD);
  }
});

// Open folder in file explorer
ipcMain.handle('open-explorer', async (event, folderPath) => {
  shell.openPath(folderPath);
});

// Open an external URL in the user's default browser
ipcMain.handle('open-external', async (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Test beep sound
ipcMain.handle('test-beep', async () => {
  exec('powershell.exe -Command "[Console]::Beep(1000, 400)"');
});

// Get beep-on-prompt hook status
ipcMain.handle('get-beep-enabled', async () => {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    const notifs = data.hooks && data.hooks.Notification;
    if (!Array.isArray(notifs)) return false;
    return notifs.some(n =>
      Array.isArray(n.hooks) && n.hooks.some(h => h.command && h.command.includes('Beep'))
    );
  } catch (e) { return false; }
});

// Toggle beep-on-prompt hook
ipcMain.handle('set-beep-enabled', async (event, enabled) => {
  let data = {};
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    }
  } catch (e) {}

  if (!data.hooks) data.hooks = {};
  if (!Array.isArray(data.hooks.Notification)) data.hooks.Notification = [];

  // Remove any existing beep hooks
  data.hooks.Notification = data.hooks.Notification.filter(n =>
    !(Array.isArray(n.hooks) && n.hooks.some(h => h.command && h.command.includes('Beep')))
  );

  if (enabled) {
    data.hooks.Notification.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'powershell.exe -Command "[Console]::Beep(1000, 400)"'
      }]
    });
  }

  // Clean up empty arrays
  if (data.hooks.Notification.length === 0) delete data.hooks.Notification;
  if (Object.keys(data.hooks).length === 0) delete data.hooks;

  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(data, null, 2));
  return enabled;
});

// ---- Memory protocol (writes brain/ instructions into the user's global CLAUDE.md) ----

function isMemoryProtocolInstalled() {
  try {
    if (!fs.existsSync(GLOBAL_CLAUDE_MD)) return false;
    const content = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8');
    // Treat as installed if our marker is present, OR if the user already has
    // a "## Memory protocol" section (so power users like Keith aren't prompted).
    return content.includes(MEMORY_PROTOCOL_BEGIN) || /^##\s+Memory protocol\b/m.test(content);
  } catch (e) { return false; }
}

function installMemoryProtocol() {
  const dir = path.dirname(GLOBAL_CLAUDE_MD);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let content = '';
  if (fs.existsSync(GLOBAL_CLAUDE_MD)) {
    content = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8');
    if (content.includes(MEMORY_PROTOCOL_BEGIN)) return true; // already there
  }
  const sep = content.length > 0 ? (content.endsWith('\n') ? '\n' : '\n\n') : '';
  fs.writeFileSync(GLOBAL_CLAUDE_MD, content + sep + MEMORY_PROTOCOL_TEMPLATE + '\n');
  return true;
}

function removeMemoryProtocol() {
  if (!fs.existsSync(GLOBAL_CLAUDE_MD)) return false;
  const content = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8');
  // Strip the marked block plus any blank line padding around it. Idempotent.
  const re = new RegExp(
    '\\n*' + MEMORY_PROTOCOL_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '[\\s\\S]*?' + MEMORY_PROTOCOL_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n*',
    'g'
  );
  const stripped = content.replace(re, '\n');
  fs.writeFileSync(GLOBAL_CLAUDE_MD, stripped);
  return false;
}

ipcMain.handle('get-memory-protocol-installed', async () => {
  return isMemoryProtocolInstalled();
});

ipcMain.handle('set-memory-protocol-installed', async (event, enabled) => {
  return enabled ? installMemoryProtocol() : removeMemoryProtocol();
});

ipcMain.handle('get-memory-prompt-dismissed', async () => {
  return settings.memoryPromptDismissed === true;
});

ipcMain.handle('set-memory-prompt-dismissed', async (event, dismissed) => {
  const s = { ...settings, memoryPromptDismissed: !!dismissed };
  saveSettings(s);
  return !!dismissed;
});

// ---- Summary generation (calls `claude -p` headlessly) ----

const SUMMARY_PROMPT =
  'You are a labeling tool, not a chatbot. Read this project (CLAUDE.md, README, package.json, src files, configs) ' +
  'and output ONE declarative sentence (max 20 words) saying what this project is. Be specific — name actual domain ' +
  'names, business names, clients, or distinctive identifiers. ' +
  'GOOD: "Static HTML site for imperabusinessservices.com deployed via SFTP to IONOS." ' +
  'GOOD: "Next.js sites for eighteeneightdallas.com, eighteeneightwv.com, and eighteeneightphv.com salons." ' +
  'BAD: "What would you like me to look at?" ' +
  'BAD: "Looking at this project, I see..." ' +
  'BAD: "1. Option one 2. Option two" ' +
  'NEVER ask a question. NEVER offer options. NEVER explain what you\'re doing. ' +
  'If empty/unclear, output exactly: NO_SUMMARY ' +
  'Output the sentence and nothing else.';

const MAX_CONCURRENT_SUMMARIES = 2;
let activeSummaryJobs = 0;
const summaryQueue = [];

function processSummaryQueue() {
  while (activeSummaryJobs < MAX_CONCURRENT_SUMMARIES && summaryQueue.length > 0) {
    const job = summaryQueue.shift();
    activeSummaryJobs++;
    runSummaryJob(job);
  }
}

// Strip Claude's conversational preamble and take just the first declarative sentence.
// Returns '' if the output looks conversational (questions, lists, "what would you like" etc.).
function cleanSummaryOutput(raw) {
  if (!raw) return '';
  let text = raw.trim();

  // Strip code-fences and markdown emphasis
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '');
  text = text.replace(/\*+/g, '').replace(/_+/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  // Bail on dead-giveaway conversational patterns anywhere in the response
  const conversationalRedFlags = [
    /\bwould you like\b/i,
    /\bwhat would you\b/i,
    /\bcan you (?:tell|share|give|paste|provide)\b/i,
    /\b(?:could you|can you) (?:tell|give|share)\b/i,
    /\bplease (?:share|provide|specify|tell)\b/i,
    /\bnothing (?:to examine|here to)\b/i,
    /\bwhat (?:do you|would you|file|folder|topic|project)\b/i,
    /\bwhich (?:file|folder|module|page|project)\b/i,
    /\bdid you mean\b/i,
    /\b(?:happy|here) to (?:help|examine|look)\b/i,
    /\bI'?ll wait\b/i,
    /\bI need (?:a bit|more)\b/i
  ];
  for (const re of conversationalRedFlags) {
    if (re.test(text)) return '';
  }

  // Strip leading conversational openers (try to recover a usable sentence)
  if (/^(["'`]?(?:looking|examining|i see|i notice|i'?m|let me|this appears|this is|hmm|sure|here|okay|ok|the (?:project|directory|folder))\b)/i.test(text)) {
    const colonIdx = text.indexOf(':');
    const dashIdx = text.indexOf('—');
    let cut = -1;
    if (colonIdx > 0 && colonIdx < 80) cut = colonIdx;
    if (dashIdx > 0 && dashIdx < 80 && (cut < 0 || dashIdx < cut)) cut = dashIdx;
    if (cut > 0) text = text.slice(cut + 1).trim();
  }

  // Numbered list as first content → give up
  if (/^\s*\d+\.\s+/.test(text) || /\b\d+\.\s+\*?\*?\w/.test(text.slice(0, 80))) {
    return '';
  }

  // Strip surrounding quotes
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();

  // Take just the first sentence
  const sentenceMatch = text.match(/^[^.!?]+[.!?]/);
  if (sentenceMatch) {
    text = sentenceMatch[0].trim();
  } else {
    text = text.slice(0, 200).trim();
  }

  // If the first sentence (or full text) is itself a question → bail
  if (/\?\s*$/.test(text) || /^(?:what|which|can|could|would|do|does|is\s+there|are\s+there)\b/i.test(text)) {
    return '';
  }

  // Reject suspiciously short or generic
  if (text.length < 12) return '';

  // Final length cap
  if (text.length > 240) text = text.slice(0, 237).trimEnd() + '...';

  return text;
}

function runSummaryJob({ folderPath, resolve }) {
  let stdout = '';
  let stderr = '';
  let proc;
  try {
    // Pipe the prompt via stdin instead of passing as arg — avoids Windows
    // cmd shell mangling double quotes / em-dashes in the prompt text.
    proc = spawn('claude', ['-p'], {
      cwd: folderPath,
      shell: true,
      windowsHide: true
    });
  } catch (err) {
    activeSummaryJobs--;
    processSummaryQueue();
    resolve({ success: false, error: 'Could not start claude CLI: ' + err.message });
    return;
  }

  const timer = setTimeout(() => {
    try { proc.kill(); } catch (e) {}
  }, 120000);

  try {
    proc.stdin.write(SUMMARY_PROMPT);
    proc.stdin.end();
  } catch (err) {
    // stdin write failed — process probably died
  }

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('error', (err) => {
    clearTimeout(timer);
    activeSummaryJobs--;
    processSummaryQueue();
    resolve({ success: false, error: err.message });
  });

  proc.on('close', (code) => {
    clearTimeout(timer);
    activeSummaryJobs--;
    processSummaryQueue();
    if (code !== 0) {
      resolve({ success: false, error: (stderr.trim() || `claude exited with code ${code}`).slice(0, 300) });
      return;
    }
    let summary = cleanSummaryOutput(stdout);
    if (!summary || /^NO_SUMMARY/i.test(summary)) {
      resolve({ success: false, error: 'Could not determine project (try adding a CLAUDE.md)' });
      return;
    }
    if (!settings.summaries) settings.summaries = {};
    settings.summaries[folderPath] = { text: summary, generatedAt: Date.now() };
    saveSettings(settings);
    resolve({ success: true, summary });
  });
}

ipcMain.handle('generate-summary', async (event, folderPath) => {
  return new Promise((resolve) => {
    summaryQueue.push({ folderPath, resolve });
    processSummaryQueue();
  });
});

// ---- Suggest summary from local files (no AI call needed) ----

function encodeProjectPath(folderPath) {
  return folderPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function isPlaceholderText(text) {
  const t = (text || '').trim();
  if (t.length < 12) return true;
  if (/^project instructions go here\.?$/i.test(t)) return true;
  return false;
}

function extractFirstParagraph(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  let inFrontmatter = false;
  const collected = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && line === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (line === '---') inFrontmatter = false; continue; }
    if (!line) { if (collected.length > 0) break; else continue; }
    if (line.startsWith('#')) continue;
    if (line.startsWith('<')) continue;
    if (line.startsWith('```')) break;
    collected.push(line);
    const joined = collected.join(' ');
    if (joined.length > 200) break;
  }
  let out = collected.join(' ').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
  // Take 1-2 sentences
  const sent = out.match(/^[^.!?]+[.!?](?:\s+[^.!?]+[.!?])?/);
  if (sent && sent[0].length >= 20) out = sent[0].trim();
  return out;
}

function readLatestAiTitle(folderPath) {
  const encoded = encodeProjectPath(folderPath);
  const projDir = path.join(HOME, '.claude', 'projects', encoded);
  if (!fs.existsSync(projDir)) return null;
  let files;
  try {
    files = fs.readdirSync(projDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return null; }
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(projDir, file.name), 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('"type":"ai-title"')) {
          const m = line.match(/"aiTitle":"((?:[^"\\]|\\.)*)"/);
          if (m) {
            try { return JSON.parse('"' + m[1] + '"'); }
            catch (e) { return m[1]; }
          }
        }
      }
    } catch (e) {}
  }
  return null;
}

function suggestSummaryFromFiles(folderPath) {
  let text = null;
  let source = null;

  // 1. CLAUDE.md (if substantive)
  try {
    const p = path.join(folderPath, 'CLAUDE.md');
    if (fs.existsSync(p)) {
      const para = extractFirstParagraph(fs.readFileSync(p, 'utf-8'));
      if (para && !isPlaceholderText(para)) { text = para; source = 'CLAUDE.md'; }
    }
  } catch (e) {}

  // 2. README
  if (!text) {
    for (const name of ['README.md', 'readme.md', 'README', 'Readme.md']) {
      try {
        const p = path.join(folderPath, name);
        if (fs.existsSync(p)) {
          const para = extractFirstParagraph(fs.readFileSync(p, 'utf-8'));
          if (para && !isPlaceholderText(para)) { text = para; source = 'README'; break; }
        }
      } catch (e) {}
    }
  }

  // 3. package.json description
  if (!text) {
    try {
      const p = path.join(folderPath, 'package.json');
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (pkg.description && pkg.description.trim().length >= 12) {
          text = pkg.description.trim();
          source = 'package.json';
        }
      }
    } catch (e) {}
  }

  // 4. Latest ai-title from Claude Code session files
  if (!text) {
    const title = readLatestAiTitle(folderPath);
    if (title) { text = 'Last session: ' + title; source = 'session'; }
  }

  if (!text) return null;
  if (text.length > 240) text = text.slice(0, 237).trimEnd() + '...';
  return { text, source };
}

ipcMain.handle('suggest-summary', async (event, folderPath) => {
  return suggestSummaryFromFiles(folderPath);
});

ipcMain.handle('set-summary', async (event, folderPath, text) => {
  if (!settings.summaries) settings.summaries = {};
  if (text && text.trim()) {
    settings.summaries[folderPath] = {
      text: text.trim().slice(0, 280),
      generatedAt: Date.now(),
      manual: true
    };
  } else {
    delete settings.summaries[folderPath];
  }
  saveSettings(settings);
  return true;
});

// ---- Status Reports (v2.0) ----
// A friendly HTML status report per project, generated from its brain/ folder.
// Lives at <project>/brain/status-report.html. Template editable from About page.

const STATUS_REPORT_FILENAME = 'status-report.html';
const STATUS_TEMPLATE_PATH = path.join(HOME, '.claude-manager-status-template.html');

const DEFAULT_STATUS_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{{projectName}} — Status Report</title>
<style>
  :root {
    --bg: #1a1a2e;
    --panel: #16213e;
    --panel-2: #0f1729;
    --text: #e0e0e0;
    --muted: #888;
    --accent: #e94560;
    --accent-soft: rgba(233,69,96,0.12);
    --purple: #b388ff;
    --done: #4ade80;
    --amber: #f5b97d;
    --amber-soft: rgba(245,185,125,0.12);
    --pending: #60a5fa;
    --pending-soft: rgba(96,165,250,0.14);
    --border: rgba(255,255,255,0.1);
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 32px 20px 60px;
    line-height: 1.6;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  header.report-head {
    border-bottom: 2px solid var(--accent);
    padding-bottom: 14px;
    margin-bottom: 24px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 10px;
  }
  header.report-head h1 { margin: 0 0 4px 0; font-size: 26px; }
  .meta { color: var(--muted); font-size: 12px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 22px;
    margin-bottom: 16px;
  }
  .card h2 {
    color: var(--accent);
    margin: 0 0 12px 0;
    font-size: 16px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px;
  }
  /* Collapsible card headers (every section is a <details class="card">) */
  details.card > summary {
    color: var(--accent); font-size: 16px; font-weight: 600;
    cursor: pointer; user-select: none; list-style: none; outline: none;
    border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  details.card > summary::-webkit-details-marker { display: none; }
  details.card > summary::before {
    content: '▾'; font-size: 12px; color: var(--muted); transition: transform 0.15s;
    display: inline-block; width: 12px;
  }
  details.card:not([open]) > summary::before { content: '▸'; }
  details.card:not([open]) > summary { margin-bottom: 0; border-bottom: none; }
  .card h3 { font-size: 14px; margin: 14px 0 6px; color: var(--purple); }
  .card h4 { font-size: 13px; margin: 12px 0 4px; color: var(--text); }
  .card p { margin: 6px 0; }
  .card .empty { color: var(--muted); font-style: italic; }
  .card ul, .card ol { padding-left: 20px; margin: 6px 0; }
  .card ul.checklist { list-style: none; padding-left: 0; }
  .card ul.checklist li {
    padding: 5px 8px; display: flex; align-items: flex-start; gap: 10px;
    border-left: 3px solid transparent; border-radius: 4px;
    transition: background 0.15s, border-color 0.15s;
  }
  .card ul.checklist input[type="checkbox"] {
    margin-top: 5px; width: 16px; height: 16px; accent-color: var(--accent);
    cursor: pointer; flex-shrink: 0;
  }
  .card ul.checklist label { cursor: pointer; flex: 1; }
  /* Quad-state: 1 = in progress (amber), 2 = done/awaiting your OK (blue),
     3 = approved & closed (green + strikethrough). */
  .card ul.checklist li[data-state="1"] {
    background: var(--amber-soft); border-left-color: var(--amber);
  }
  .card ul.checklist li[data-state="1"] input[type="checkbox"] { accent-color: var(--amber); }
  .card ul.checklist li[data-state="2"] {
    background: var(--pending-soft); border-left-color: var(--pending);
  }
  .card ul.checklist li[data-state="2"] input[type="checkbox"] { accent-color: var(--pending); }
  .card ul.checklist li[data-state="3"] input[type="checkbox"] { accent-color: var(--done); }
  .card ul.checklist li[data-state="3"] label {
    color: var(--muted); text-decoration: line-through;
  }
  .tag {
    font-size: 11px; font-weight: 600; margin-left: 6px; opacity: 0; white-space: nowrap;
  }
  li[data-state="2"] .tag { color: var(--pending); opacity: 1; }
  li[data-state="3"] .tag { color: var(--done); opacity: 1; text-decoration: none; }
  .card li.static-cb { list-style: none; padding: 3px 0; }
  .legend {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 16px; margin-bottom: 16px; font-size: 12px; color: var(--muted);
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  }
  .legend b { color: var(--text); font-weight: 600; }
  .legend .chip { display: inline-flex; align-items: center; gap: 6px; }
  .legend .dot { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .legend .dot.amber { background: var(--amber); }
  .legend .dot.blue { background: var(--pending); }
  .legend .dot.green { background: var(--done); }
  .legend .dot.empty { background: transparent; border: 1px solid var(--muted); }
  .legend-sub { flex-basis: 100%; margin-top: 2px; opacity: 0.85; }
  .links-card ul { list-style: none; padding-left: 0; margin: 4px 0; }
  .links-card li { padding: 7px 2px; border-bottom: 1px solid var(--border); }
  .links-card li:last-child { border-bottom: none; }
  .links-card a { color: var(--purple); font-weight: 600; text-decoration: none; }
  .links-card a:hover { text-decoration: underline; }
  .progress-text { white-space: nowrap; }
  code {
    background: var(--panel-2); padding: 2px 6px; border-radius: 4px;
    font-size: 13px; color: #f5b97d; font-family: 'Consolas', 'Courier New', monospace;
  }
  textarea.notes {
    width: 100%; min-height: 110px; background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 10px;
    font-family: inherit; font-size: 14px; resize: vertical; line-height: 1.5;
  }
  textarea.notes:focus { outline: none; border-color: var(--accent); }
  .save-status {
    font-size: 11px; color: var(--muted); font-style: italic; margin-top: 4px; min-height: 14px;
  }
  details.decisions-toggle summary {
    color: var(--accent); font-size: 16px; font-weight: 600; cursor: pointer;
    padding: 6px 0; user-select: none; list-style: none;
  }
  details.decisions-toggle summary::before { content: '▶ '; font-size: 11px; transition: transform 0.2s; display: inline-block; }
  details.decisions-toggle[open] summary::before { content: '▼ '; }
  .refresh-link {
    background: transparent; border: 1px solid var(--border); color: var(--muted);
    padding: 5px 10px; border-radius: 5px; font-size: 11px; cursor: default;
    text-decoration: none; display: inline-block;
  }
  .progress {
    background: var(--panel-2); border-radius: 6px; padding: 8px 12px;
    margin-top: 8px; display: flex; align-items: center; gap: 12px;
    font-size: 12px; color: var(--muted);
  }
  .progress-bar {
    flex: 1; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: var(--accent); width: 0%; transition: width 0.3s;
  }
  footer.report-foot {
    text-align: center; color: var(--muted); font-size: 11px; margin-top: 28px;
    padding-top: 16px; border-top: 1px solid var(--border);
  }
</style>
</head>
<body>
<!-- CMSR-TEMPLATE-VERSION: 5 -->
<div class="wrap" data-project-key="{{projectKey}}" data-project-path="{{projectPath}}" data-sync-port="{{syncPort}}" data-sync-token="{{syncToken}}">

  <header class="report-head">
    <div>
      <h1>{{projectName}}</h1>
      <div class="meta">Status Report · Last updated {{updatedAt}}</div>
    </div>
    <span class="refresh-link" title="Use the dashboard's right-click menu to refresh">↻ Refresh from dashboard</span>
  </header>

  <div class="legend">
    <b>Tip:</b> click any checkbox to cycle it ·
    <span class="chip"><span class="dot amber"></span>1 = in progress</span>
    <span class="chip"><span class="dot blue"></span>2 = done, waiting your OK</span>
    <span class="chip"><span class="dot green"></span>3 = approved &amp; closed</span>
    <span class="chip"><span class="dot empty"></span>4 = clear</span>
    <div class="legend-sub">Claude marks things "done, waiting your OK"; only your click closes them. Your clicks save back to <code>brain/next.md</code> while the dashboard is open, so Claude sees them too.</div>
  </div>

  {{linksSection}}

  <details class="card" open>
    <summary>🎯 Objective</summary>
    <div class="card-body">{{objective}}</div>
  </details>

  <details class="card" open>
    <summary>✅ Done so far</summary>
    <div class="card-body">{{done}}</div>
  </details>

  <details class="card" open>
    <summary>➡️ Up next</summary>
    <div class="card-body">{{next}}</div>
  </details>

  <details class="card" open>
    <summary>📝 My notes</summary>
    <div class="card-body">
      <textarea class="notes" id="notesArea" placeholder="Scratchpad — your typing autosaves to this browser..."></textarea>
      <div class="save-status" id="notesStatus"></div>
    </div>
  </details>

  <details class="card">
    <summary>🧠 Decisions</summary>
    <div class="card-body">{{decisions}}</div>
  </details>

  <footer class="report-foot">
    Generated from this project's <code>brain/</code> folder.<br>
    Ask Claude to update brain files, then right-click the tile in the dashboard and choose Refresh.
  </footer>

</div>

<script>
(function() {
  var wrap = document.querySelector('.wrap');
  var projectKey = wrap ? wrap.getAttribute('data-project-key') : 'default';
  var projectPath = wrap ? wrap.getAttribute('data-project-path') : '';
  var syncPort = wrap ? wrap.getAttribute('data-sync-port') : '';
  var syncToken = wrap ? wrap.getAttribute('data-sync-token') : '';
  var storagePrefix = 'crepo-' + projectKey + '-';

  // Two-way sync: when you click a task, tell the dashboard app so it can save
  // the new state into brain/next.md (so Claude sees what you've done/approved).
  // Fire-and-forget over localhost; only works while the dashboard is running,
  // and silently no-ops otherwise (your click still saves in this browser).
  var TAGS = { 0: '', 1: '', 2: 'waiting for your OK', 3: 'approved' };
  function syncToApp(task, state) {
    if (!syncPort || !projectPath || !task) return;
    var url = 'http://127.0.0.1:' + syncPort + '/task';
    var body = JSON.stringify({ token: syncToken, project: projectPath, task: task, state: state });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try {
      fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: body });
    } catch (e) {}
  }

  // Notes autosave (debounced)
  var notesArea = document.getElementById('notesArea');
  var notesStatus = document.getElementById('notesStatus');
  var notesKey = storagePrefix + 'notes';
  try {
    var saved = localStorage.getItem(notesKey);
    if (saved !== null) notesArea.value = saved;
  } catch (e) {}
  var saveTimer = null;
  notesArea.addEventListener('input', function() {
    notesStatus.textContent = 'Saving...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function() {
      try {
        localStorage.setItem(notesKey, notesArea.value);
        var now = new Date();
        notesStatus.textContent = 'Saved ' + now.toLocaleTimeString();
      } catch (e) {
        notesStatus.textContent = 'Could not save (browser storage full?)';
      }
    }, 800);
  });

  // Quad-state check items, keyed by the task's source text (stable across
  // regenerations). 0 = not started, 1 = in progress, 2 = done/awaiting your OK,
  // 3 = approved & closed.
  function hashId(s) {
    var h = 0, i, c;
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h = ((h << 5) - h) + c; h |= 0; }
    return Math.abs(h).toString(36);
  }

  function applyState(li, cb, state) {
    li.setAttribute('data-state', String(state));
    var tag = li.querySelector('.tag');
    if (tag) tag.textContent = TAGS[state] || '';
    // A prevented checkbox click makes the browser revert checked/indeterminate
    // after the handler runs, so set them on the next tick.
    setTimeout(function() {
      cb.checked = (state === 2 || state === 3);
      cb.indeterminate = (state === 1);
    }, 0);
  }

  var items = document.querySelectorAll('ul.checklist li');
  items.forEach(function(li) {
    var cb = li.querySelector('input[type="checkbox"]');
    var label = li.querySelector('label');
    if (!cb || !label) return;
    // data-task = the exact source line text from next.md (used for the storage
    // key AND for telling the app which task to update).
    var task = li.getAttribute('data-task') || label.textContent.trim();
    var key = storagePrefix + 'cb-' + hashId(task);
    // mdState = the state Claude wrote in brain/next.md: [ ]=0, [~]=1,
    // [?]=2 (done, awaiting your OK), [x]=3 (approved/closed). Your clicks are
    // remembered on top; when the file changes (Claude or your own synced click)
    // the file wins.
    var mdState = parseInt(li.getAttribute('data-md-state') || '0', 10) || 0;
    var state = mdState;
    try {
      var raw = localStorage.getItem(key);
      if (raw !== null) {
        var rec;
        if (raw === '0' || raw === '1' || raw === '2' || raw === '3') {
          rec = { u: parseInt(raw, 10), b: mdState };  // migrate old numeric format
        } else {
          try { rec = JSON.parse(raw); } catch (e) { rec = null; }
        }
        if (rec && typeof rec.u === 'number') {
          if (rec.b !== mdState) {
            state = mdState;  // next.md changed since your last click — file wins
            localStorage.setItem(key, JSON.stringify({ u: mdState, b: mdState }));
          } else {
            state = rec.u;
          }
        }
      }
    } catch (e) {}
    applyState(li, cb, state);

    cb.addEventListener('click', function(e) {
      e.preventDefault();
      state = (state + 1) % 4;
      try { localStorage.setItem(key, JSON.stringify({ u: state, b: mdState })); } catch (e) {}
      applyState(li, cb, state);
      syncToApp(task, state);
      updateAllProgress();
    });
  });

  // Collapsible sections: remember which ones you collapsed (the report rebuilds
  // from brain/ each time you open it, so without this your choices would reset).
  document.querySelectorAll('details.card').forEach(function(d) {
    var sum = d.querySelector('summary');
    if (!sum) return;
    var skey = storagePrefix + 'sec-' + hashId(sum.textContent.trim());
    try {
      var sv = localStorage.getItem(skey);
      if (sv === 'closed') d.open = false;
      else if (sv === 'open') d.open = true;
    } catch (e) {}
    d.addEventListener('toggle', function() {
      try { localStorage.setItem(skey, d.open ? 'open' : 'closed'); } catch (e) {}
    });
  });

  // Per-card progress: one bar per card that contains a checklist, counting
  // only the items inside that card.
  var cards = document.querySelectorAll('.card');
  cards.forEach(function(card) {
    if (card.querySelectorAll('ul.checklist li').length === 0) return;
    var body = card.querySelector('.card-body') || card;
    var bar = document.createElement('div');
    bar.className = 'progress';
    bar.innerHTML = '<div class="progress-bar"><div class="progress-fill"></div></div>'
                  + '<span class="progress-text"></span>';
    body.appendChild(bar);
  });

  function updateAllProgress() {
    cards.forEach(function(card) {
      var bar = card.querySelector('.progress');
      if (!bar) return;
      var lis = card.querySelectorAll('ul.checklist li');
      var closed = 0, awaiting = 0, prog = 0;
      lis.forEach(function(li) {
        var s = li.getAttribute('data-state');
        if (s === '3') closed++;
        else if (s === '2') awaiting++;
        else if (s === '1') prog++;
      });
      var total = lis.length;
      var pct = total ? Math.round((closed / total) * 100) : 0;
      bar.querySelector('.progress-fill').style.width = pct + '%';
      var txt = closed + ' / ' + total + ' approved';
      if (awaiting > 0) txt += ' · ' + awaiting + ' waiting your OK';
      if (prog > 0) txt += ' · ' + prog + ' in progress';
      bar.querySelector('.progress-text').textContent = txt;
    });
  }
  updateAllProgress();
})();
</script>
</body>
</html>
`;

// Bump this when DEFAULT_STATUS_TEMPLATE gains features every report should get.
// Must match the CMSR-TEMPLATE-VERSION marker embedded in the template.
const STATUS_TEMPLATE_VERSION = 5;

function ensureStatusTemplate() {
  try {
    if (!fs.existsSync(STATUS_TEMPLATE_PATH)) {
      fs.writeFileSync(STATUS_TEMPLATE_PATH, DEFAULT_STATUS_TEMPLATE);
      return;
    }
    // Auto-upgrade an older stock template so existing installs pick up new
    // report features (tri-state checks, per-card progress, etc.). A template
    // with no version marker predates versioning and is treated as stock.
    var current = fs.readFileSync(STATUS_TEMPLATE_PATH, 'utf-8');
    var m = current.match(/CMSR-TEMPLATE-VERSION:\s*(\d+)/);
    var onDisk = m ? parseInt(m[1], 10) : 0;
    if (onDisk < STATUS_TEMPLATE_VERSION) {
      fs.writeFileSync(STATUS_TEMPLATE_PATH, DEFAULT_STATUS_TEMPLATE);
    }
  } catch (e) { /* non-fatal — report gen will surface a read error if any */ }
}

function readStatusTemplate() {
  ensureStatusTemplate();
  return fs.readFileSync(STATUS_TEMPLATE_PATH, 'utf-8');
}

function hasBrainFolder(projectPath) {
  try { return fs.existsSync(path.join(projectPath, 'brain')); }
  catch (e) { return false; }
}

function hasStatusReport(projectPath) {
  try { return fs.existsSync(path.join(projectPath, 'brain', STATUS_REPORT_FILENAME)); }
  catch (e) { return false; }
}

function readBrainFile(projectPath, name) {
  try { return fs.readFileSync(path.join(projectPath, 'brain', name), 'utf-8'); }
  catch (e) { return ''; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

// Inline markdown: code, bold, italic, links (after HTML escaping)
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Minimal markdown-to-HTML for brain content. Supports headings, paragraphs,
// bullet lists, ordered lists, and GFM checkboxes. Strips HTML comments first.
function mdToHtml(md, opts) {
  opts = opts || {};
  if (!md) return '<p class="empty">Nothing here yet.</p>';
  md = md.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!md) return '<p class="empty">Nothing here yet.</p>';

  var lines = md.split(/\r?\n/);
  var out = [];
  var inUl = false, inOl = false, inChecklist = false;
  var para = [];

  function flushPara() {
    if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = []; }
  }
  function closeList() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
    if (inChecklist) { out.push('</ul>'); inChecklist = false; }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); closeList(); continue; }

    var h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushPara(); closeList();
      var lvl = Math.min(h[1].length + 2, 6); // brain h1 -> report h3
      out.push('<h' + lvl + '>' + inlineMd(h[2]) + '</h' + lvl + '>');
      continue;
    }

    // Checkbox markers: [ ]=not started, [~]/[/]/[-]=in progress,
    // [?]=done/awaiting your OK, [x]=approved & closed.
    var cb = line.match(/^\s*[-*]\s+\[([ xX~/?-])\]\s+(.+)$/);
    if (cb) {
      flushPara();
      var mark = cb[1];
      var mdState = /[xX]/.test(mark) ? 3 : (mark === '?' ? 2 : (/[~/-]/.test(mark) ? 1 : 0));
      if (opts.checkboxes) {
        if (!inChecklist) { closeList(); out.push('<ul class="checklist">'); inChecklist = true; }
        var id = 'cb' + (out.length + i);
        var checkedAttr = (mdState === 2 || mdState === 3) ? ' checked' : '';
        out.push('<li data-md-state="' + mdState + '" data-task="' + escapeHtml(cb[2]) + '"><input type="checkbox" id="' + id + '"' + checkedAttr + '><label for="' + id + '">' + inlineMd(cb[2]) + '<span class="tag"></span></label></li>');
      } else {
        if (!inUl) { closeList(); out.push('<ul>'); inUl = true; }
        var glyph = mdState === 3 ? '☑' : (mdState === 2 ? '◩' : (mdState === 1 ? '◧' : '☐'));
        out.push('<li class="static-cb">' + glyph + ' ' + inlineMd(cb[2]) + '</li>');
      }
      continue;
    }

    var li = line.match(/^\s*[-*]\s+(.+)$/);
    if (li) {
      flushPara();
      if (!inUl) { closeList(); out.push('<ul>'); inUl = true; }
      out.push('<li>' + inlineMd(li[1]) + '</li>');
      continue;
    }

    var oli = line.match(/^\s*\d+\.\s+(.+)$/);
    if (oli) {
      flushPara();
      if (!inOl) { closeList(); out.push('<ol>'); inOl = true; }
      out.push('<li>' + inlineMd(oli[1]) + '</li>');
      continue;
    }

    closeList();
    para.push(line);
  }
  flushPara();
  closeList();

  if (out.length === 0) return '<p class="empty">Nothing here yet.</p>';
  return out.join('\n');
}

// Take recent entries from changelog (newest first). Robust to either
// append-only (oldest at top) or reverse-chrono (newest at top) conventions —
// if every entry has a date, sort by date desc; otherwise assume append-only.
function recentChangelog(changelogMd, limit) {
  limit = limit || 15;
  var stripped = changelogMd.replace(/<!--[\s\S]*?-->/g, '');
  var lines = stripped.split(/\r?\n/);
  var entries = [];
  var buf = [];
  function isEntryStart(l) {
    return /^\s*[-*]\s/.test(l) || /^\d{4}-\d{2}-\d{2}/.test(l);
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (isEntryStart(line)) {
      if (buf.length) entries.push(buf.join('\n'));
      buf = [line];
    } else if (buf.length) {
      if (line.trim()) buf.push(line);
    }
  }
  if (buf.length) entries.push(buf.join('\n'));
  if (entries.length === 0) return stripped.trim();
  function dateOf(e) { var m = e.match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; }
  var allDated = entries.every(function (e) { return dateOf(e); });
  if (allDated) {
    entries.sort(function (a, b) { return dateOf(b).localeCompare(dateOf(a)); });
  } else {
    entries.reverse(); // assume append-only
  }
  return entries.slice(0, limit).join('\n');
}

function extractObjective(stateMd, fallbackSummary, claudeMdPath) {
  var stripped = stateMd.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (stripped) {
    var objMatch = stripped.match(/^##\s+Objective\s*\n+([\s\S]*?)(?=\n##|$)/im);
    if (objMatch) return objMatch[1].trim();
    var lines = stripped.split(/\r?\n/);
    var collected = [];
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { if (collected.length) break; else continue; }
      if (t.startsWith('#')) continue;
      collected.push(t);
    }
    if (collected.length) return collected.join('\n');
  }
  if (fallbackSummary) return fallbackSummary;
  if (claudeMdPath && fs.existsSync(claudeMdPath)) {
    try {
      var para = extractFirstParagraph(fs.readFileSync(claudeMdPath, 'utf-8'));
      if (para && !isPlaceholderText(para)) return para;
    } catch (e) {}
  }
  return '_No objective set yet. Open `brain/STATE.md` and add a short description, then refresh this report._';
}

// Strip the leading H1 title from a brain file (every brain file has one as metadata)
function stripBrainTitle(md) {
  if (!md) return md;
  return md.replace(/^\s*#\s+[^\n]+\n+/, '');
}

function buildStatusReportHtml(projectPath, projectName) {
  var brain = {
    state: stripBrainTitle(readBrainFile(projectPath, 'STATE.md')),
    next: stripBrainTitle(readBrainFile(projectPath, 'next.md')),
    changelog: stripBrainTitle(readBrainFile(projectPath, 'changelog.md')),
    decisions: stripBrainTitle(readBrainFile(projectPath, 'decisions.md')),
    links: stripBrainTitle(readBrainFile(projectPath, 'links.md'))
  };
  var summaries = settings.summaries || {};
  var fallbackSummary = summaries[projectPath] ? summaries[projectPath].text : null;
  var claudeMdPath = path.join(projectPath, 'CLAUDE.md');

  var objectiveMd = extractObjective(brain.state, fallbackSummary, claudeMdPath);
  var objectiveHtml = mdToHtml(objectiveMd);
  var doneHtml = mdToHtml(recentChangelog(brain.changelog));
  var nextHtml = mdToHtml(brain.next, { checkboxes: true });
  var decisionsHtml = mdToHtml(brain.decisions);

  // Optional "Links" card pinned at the top — only rendered when brain/links.md
  // has real content (projects building several pages/things keep their URLs
  // there, e.g. 188-AIOS).
  var linksSection = '';
  var linksMd = (brain.links || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (linksMd) {
    linksSection = '<details class="card links-card" open>\n    <summary>🔗 Key links</summary>\n    <div class="card-body">'
      + mdToHtml(brain.links) + '</div>\n  </details>';
  }

  var now = new Date();
  var updatedAt = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  var projectKey = encodeProjectPath(projectPath);

  var template = readStatusTemplate();
  return template
    .replace(/\{\{projectName\}\}/g, escapeHtml(projectName))
    .replace(/\{\{updatedAt\}\}/g, escapeHtml(updatedAt))
    .replace(/\{\{projectKey\}\}/g, escapeHtml(projectKey))
    .replace(/\{\{projectPath\}\}/g, escapeHtml(projectPath))
    .replace(/\{\{syncPort\}\}/g, escapeHtml(String(syncPort || '')))
    .replace(/\{\{syncToken\}\}/g, escapeHtml(String(syncToken || '')))
    .replace(/\{\{linksSection\}\}/g, linksSection)
    .replace(/\{\{objective\}\}/g, objectiveHtml)
    .replace(/\{\{done\}\}/g, doneHtml)
    .replace(/\{\{next\}\}/g, nextHtml)
    .replace(/\{\{decisions\}\}/g, decisionsHtml);
}

function writeStatusReport(projectPath, projectName) {
  var brainDir = path.join(projectPath, 'brain');
  if (!fs.existsSync(brainDir)) fs.mkdirSync(brainDir, { recursive: true });
  var html = buildStatusReportHtml(projectPath, projectName);
  var outPath = path.join(brainDir, STATUS_REPORT_FILENAME);
  fs.writeFileSync(outPath, html);
  return outPath;
}

ipcMain.handle('has-status-report', async (event, folderPath) => {
  return hasStatusReport(folderPath);
});

ipcMain.handle('has-brain-folder', async (event, folderPath) => {
  return hasBrainFolder(folderPath);
});

ipcMain.handle('generate-status-report', async (event, folderPath) => {
  if (!hasBrainFolder(folderPath)) {
    return { success: false, reason: 'no-brain' };
  }
  try {
    var projectName = path.basename(folderPath);
    var outPath = writeStatusReport(folderPath, projectName);
    return { success: true, path: outPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-status-report', async (event, folderPath) => {
  var reportPath = path.join(folderPath, 'brain', STATUS_REPORT_FILENAME);
  // Always rebuild from brain/ on open, so the report reflects the latest
  // next.md (including tasks Claude updated) and carries this launch's live sync
  // token. Also self-heals if the file was deleted (e.g. by OneDrive sync).
  if (hasBrainFolder(folderPath)) {
    try {
      writeStatusReport(folderPath, path.basename(folderPath));
    } catch (err) {
      if (!fs.existsSync(reportPath)) return { success: false, error: err.message };
      // else fall through and open whatever's already there
    }
  }
  if (!fs.existsSync(reportPath)) {
    return { success: false, error: 'Report does not exist' };
  }
  shell.openPath(reportPath);
  return { success: true };
});

ipcMain.handle('delete-status-report', async (event, folderPath) => {
  var reportPath = path.join(folderPath, 'brain', STATUS_REPORT_FILENAME);
  try {
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scaffold-brain-for-project', async (event, folderPath) => {
  try {
    var projectName = path.basename(folderPath);
    scaffoldBrain(folderPath, projectName);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-status-template', async () => {
  ensureStatusTemplate();
  shell.openPath(STATUS_TEMPLATE_PATH);
  return STATUS_TEMPLATE_PATH;
});

ipcMain.handle('reset-status-template', async () => {
  try {
    fs.writeFileSync(STATUS_TEMPLATE_PATH, DEFAULT_STATUS_TEMPLATE);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---- Claude plan usage (the %-remaining bars, like Claude's own /usage screen) ----
// Reads the local Claude Code OAuth token and queries the same internal endpoint
// Claude's own apps use. The endpoint is undocumented — if it changes, the widget
// silently hides rather than erroring at the user. Approach credit:
// CodeZeno/Claude-Code-Usage-Monitor (MIT) — reimplemented in Node, not copied.

const CLAUDE_CREDENTIALS_PATH = path.join(HOME, '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function getClaudeAccessToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));
    const oauth = raw.claudeAiOauth || raw;
    if (!oauth || !oauth.accessToken) return null;
    return {
      token: oauth.accessToken,
      expired: !!(oauth.expiresAt && Date.now() > oauth.expiresAt)
    };
  } catch (e) { return null; }
}

ipcMain.handle('get-usage', async () => {
  const cred = getClaudeAccessToken();
  if (!cred) return { success: false, reason: 'no-token' };
  try {
    const raw = await httpsGet(USAGE_URL, {
      'Authorization': 'Bearer ' + cred.token,
      'anthropic-beta': 'oauth-2025-04-20'
    });
    const data = JSON.parse(raw);
    function bucket(b) {
      if (!b || typeof b.utilization !== 'number') return null;
      return {
        pct: Math.max(0, Math.min(100, Math.round(b.utilization))),
        resetsAt: b.resets_at || null
      };
    }
    const result = {
      success: true,
      fiveHour: bucket(data.five_hour),
      sevenDay: bucket(data.seven_day),
      sevenDayOpus: bucket(data.seven_day_opus)
    };
    if (process.env.USAGE_DEBUG) console.log('[usage] ok keys=' + Object.keys(data).join(',') + ' parsed=' + JSON.stringify(result));
    return result;
  } catch (err) {
    if (process.env.USAGE_DEBUG) console.log('[usage] FAIL ' + (err.message || err) + ' expired=' + cred.expired);
    return { success: false, reason: 'api', error: err.message || String(err), expired: cred.expired };
  }
});

// Refresh interval for the usage bars (seconds; 0 = off). Default 60.
ipcMain.handle('get-usage-refresh-seconds', async () => {
  return (typeof settings.usageRefreshSeconds === 'number') ? settings.usageRefreshSeconds : 60;
});
ipcMain.handle('set-usage-refresh-seconds', async (event, sec) => {
  const s = { ...settings, usageRefreshSeconds: Number(sec) || 0 };
  saveSettings(s);
  return s.usageRefreshSeconds;
});

// ---- Check for updates (via GitHub Releases API) ----
// Queries the public GitHub Releases API for the latest tagged release.
// Returns { current, latest, isUpdate, notes, downloadUrl, downloadSize }.

function httpsGet(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    var headers = Object.assign({
      'User-Agent': 'ClaudeProjectDashboard/' + APP_VERSION,
      'Accept': 'application/json'
    }, extraHeaders || {});
    function follow(u, depth) {
      if (depth > 5) { reject(new Error('Too many redirects')); return; }
      var req = https.get(u, { timeout: 15000, headers: headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          follow(res.headers.location, depth + 1);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        var data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    }
    follow(url, 0);
  });
}

// Compare two semver-ish strings (a > b → 1, a < b → -1, equal → 0).
function compareVersions(a, b) {
  function clean(s) { return String(s || '0').replace(/^v/, ''); }
  var pa = clean(a).split('.').map(n => parseInt(n, 10) || 0);
  var pb = clean(b).split('.').map(n => parseInt(n, 10) || 0);
  for (var i = 0; i < 3; i++) {
    var x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

ipcMain.handle('check-for-updates', async () => {
  try {
    var raw = await httpsGet(RELEASES_API);
    var releases = JSON.parse(raw);
    if (!Array.isArray(releases) || releases.length === 0) {
      return { success: true, current: APP_VERSION, latest: APP_VERSION, isUpdate: false, intermediateReleases: [] };
    }
    // Filter out drafts/prereleases, ignore tags without a version-like name
    releases = releases.filter(r => !r.draft && !r.prerelease && /\d+\.\d+/.test(r.tag_name || r.name || ''));
    // Sort newest first by version (in case GitHub returns out of order)
    releases.sort((a, b) => compareVersions((b.tag_name || b.name), (a.tag_name || a.name)));
    var latest = releases[0];
    var latestVersion = (latest.tag_name || latest.name || '').replace(/^v/, '');
    var asset = (latest.assets || []).find(a => /\.exe$/i.test(a.name) && /setup/i.test(a.name));
    if (!asset) asset = (latest.assets || []).find(a => /\.exe$/i.test(a.name));
    var cmp = compareVersions(latestVersion, APP_VERSION);

    // Collect notes for every release newer than the user's current version.
    // This gives the user a complete delta when they're multiple versions behind.
    var intermediates = releases
      .filter(r => compareVersions((r.tag_name || r.name), APP_VERSION) > 0)
      .map(r => ({
        version: (r.tag_name || r.name || '').replace(/^v/, ''),
        releasedAt: r.published_at ? r.published_at.slice(0, 10) : null,
        notes: r.body || '',
        url: r.html_url || ''
      }));

    return {
      success: true,
      current: APP_VERSION,
      latest: latestVersion,
      isUpdate: cmp > 0,
      releasedAt: latest.published_at ? latest.published_at.slice(0, 10) : null,
      notes: latest.body || '',
      downloadUrl: asset ? asset.browser_download_url : '',
      downloadSize: asset ? asset.size : 0,
      releaseUrl: latest.html_url || '',
      intermediateReleases: intermediates
    };
  } catch (err) {
    return {
      success: false,
      current: APP_VERSION,
      error: err.message || String(err)
    };
  }
});

// ---- Download and install an update ----
// Streams the installer .exe to a temp file with progress events, then
// spawns it (detached) and quits the app so the installer can replace files.

ipcMain.handle('download-and-install-update', async (event, downloadUrl, version) => {
  if (!downloadUrl) return { success: false, error: 'No download URL provided' };
  var os = require('os');
  var safeVersion = String(version || 'latest').replace(/[^a-zA-Z0-9.\-]/g, '_');
  var tmpPath = path.join(os.tmpdir(), 'claude-project-dashboard-' + safeVersion + '-Setup.exe');

  return new Promise((resolve) => {
    function follow(url, depth) {
      if (depth > 5) { resolve({ success: false, error: 'Too many redirects' }); return; }
      https.get(url, {
        timeout: 60000,
        headers: { 'User-Agent': 'ClaudeProjectDashboard/' + APP_VERSION }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          follow(res.headers.location, depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ success: false, error: 'HTTP ' + res.statusCode });
          return;
        }
        var total = parseInt(res.headers['content-length'] || '0', 10);
        var got = 0;
        var lastReport = 0;
        var file = fs.createWriteStream(tmpPath);
        res.on('data', (chunk) => {
          got += chunk.length;
          var now = Date.now();
          if (total > 0 && now - lastReport > 200) {
            lastReport = now;
            try { event.sender.send('update-download-progress', { got: got, total: total, pct: Math.round(got / total * 100) }); } catch (e) {}
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try { event.sender.send('update-download-progress', { got: got, total: total || got, pct: 100 }); } catch (e) {}
            // Spawn installer detached, then quit. NSIS one-click installer will
            // close the existing app instance (it's gone by then) and auto-launch
            // the new version after install (runAfterFinish default).
            try {
              var child = spawn(tmpPath, [], { detached: true, stdio: 'ignore' });
              child.unref();
              setTimeout(() => { app.quit(); }, 600);
              resolve({ success: true, installerPath: tmpPath });
            } catch (err) {
              resolve({ success: false, error: 'Could not launch installer: ' + err.message, installerPath: tmpPath });
            }
          });
        });
        file.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      }).on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    }
    follow(downloadUrl, 0);
  });
});
