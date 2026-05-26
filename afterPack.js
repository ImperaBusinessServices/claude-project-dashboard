const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'win32') return;

  const rcedit = path.join(__dirname, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(__dirname, 'icon.ico');

  if (!fs.existsSync(rcedit)) throw new Error(`rcedit not found at ${rcedit}`);
  if (!fs.existsSync(exe)) throw new Error(`app exe not found at ${exe}`);
  if (!fs.existsSync(icon)) throw new Error(`icon not found at ${icon}`);

  execFileSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit' });
  console.log(`  • embedded icon into ${path.basename(exe)}`);
};
