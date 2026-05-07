// Cross-platform Chromium-family browser detection.
//
// Lookup order: Chrome → Edge → Brave → Chromium. The user can override with
// the TESLA_CHROME env var (handled in configs/) or by passing an explicit
// `executablePath` to `launchBrowser`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function windowsCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData && join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFiles, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ].filter(Boolean);
}

function macCandidates() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
}

function linuxCandidates() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
}

export function findChromeExecutable(override) {
  if (override) return override;
  let candidates;
  if (process.platform === 'win32') candidates = windowsCandidates();
  else if (process.platform === 'darwin') candidates = macCandidates();
  else candidates = linuxCandidates();
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}
