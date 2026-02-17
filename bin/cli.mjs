#!/usr/bin/env node

// Corvus AI — Plugin Installer for OpenCode
// Usage: npx corvus-ai [--global] [--force] [--uninstall] [--migrate] [--dry-run] [--help]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';

// ---------------------------------------------------------------------------
// Color helpers (disabled when stdout is not a terminal)
// ---------------------------------------------------------------------------
const isTTY = process.stdout.isTTY;
const RED = isTTY ? '\x1b[0;31m' : '';
const GREEN = isTTY ? '\x1b[0;32m' : '';
const YELLOW = isTTY ? '\x1b[0;33m' : '';
const BLUE = isTTY ? '\x1b[0;34m' : '';
const DIM = isTTY ? '\x1b[2m' : '';
const BOLD = isTTY ? '\x1b[1m' : '';
const RESET = isTTY ? '\x1b[0m' : '';

const info = (msg) => process.stdout.write(`${BLUE}[info]${RESET}  ${msg}\n`);
const ok = (msg) => process.stdout.write(`${GREEN}[ok]${RESET}    ${msg}\n`);
const warn = (msg) => process.stdout.write(`${YELLOW}[warn]${RESET}  ${msg}\n`);
const err = (msg) => process.stderr.write(`${RED}[error]${RESET} ${msg}\n`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PLUGIN_ENTRY = 'corvus-ai@latest';

const CORVUS_AGENTS = [
  'corvus.md',
  'code-explorer.md',
  'code-implementer.md',
  'code-quality.md',
  'task-planner.md',
  'requirements-analyst.md',
  'ux-dx-quality.md',
  'researcher.md',
];

const CORVUS_COMMANDS = [
  'git-commit.md',
  'summary.md',
  'readme.md',
  'cleanup-subagents.md',
];

const CORVUS_SKILLS = [
  'corvus-phase-0',
  'corvus-phase-1',
  'corvus-phase-2',
  'corvus-phase-4',
  'corvus-phase-5',
  'corvus-phase-6',
  'corvus-phase-7',
  'corvus-extras',
  'frontend-design',
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
let globalInstall = false;
let force = false;
let uninstallMode = false;
let migrate = false;
let dryRun = false;

const args = process.argv.slice(2);

for (const arg of args) {
  switch (arg) {
    case '--global':
      globalInstall = true;
      break;
    case '--force':
      force = true;
      break;
    case '--uninstall':
      uninstallMode = true;
      break;
    case '--migrate':
      migrate = true;
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;
    default:
      err(`Unknown option: ${arg}`);
      err("Run 'npx corvus-ai --help' for usage.");
      process.exit(1);
  }
}

// Validate flag combinations
if (uninstallMode && migrate) {
  err('--uninstall and --migrate cannot be used together.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  process.stdout.write(`${BOLD}Corvus AI${RESET} ${DIM}— Plugin Installer for OpenCode${RESET}

${BOLD}Usage:${RESET} npx corvus-ai [options]

${BOLD}Options:${RESET}
  ${BOLD}(no flags)${RESET}     Add corvus-ai to the plugin array in .opencode/opencode.json
  ${BOLD}--global${RESET}       Target ~/.config/opencode/opencode.json instead of local
  ${BOLD}--uninstall${RESET}    Remove corvus-ai from the plugin array
  ${BOLD}--migrate${RESET}      Remove manual corvus files from ~/.config/opencode/ and add plugin
  ${BOLD}--force${RESET}        Skip confirmation prompts
  ${BOLD}--dry-run${RESET}      Preview changes without modifying anything
  ${BOLD}--help, -h${RESET}     Show this help message

${BOLD}Examples:${RESET}
  npx corvus-ai                  Install plugin locally
  npx corvus-ai --global         Install plugin globally
  npx corvus-ai --migrate        Migrate from manual files to plugin
  npx corvus-ai --uninstall      Remove plugin entry
  npx corvus-ai --dry-run        Preview what would change
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the target config path.
 * Checks for existing files in OpenCode's discovery order,
 * and creates opencode.jsonc in .opencode/ (local) or ~/.config/opencode/ (global).
 */
function getTargetPath() {
  if (globalInstall) {
    const dir = path.join(os.homedir(), '.config', 'opencode');
    // Check existing files in OpenCode's load order
    for (const file of ['opencode.jsonc', 'opencode.json', 'config.json']) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) return p;
    }
    // Default: create opencode.jsonc in global config dir
    return path.join(dir, 'opencode.jsonc');
  }

  const cwd = process.cwd();
  // Check project root first (OpenCode's findUp checks these)
  for (const file of ['opencode.jsonc', 'opencode.json']) {
    const p = path.join(cwd, file);
    if (fs.existsSync(p)) return p;
  }
  // Then .opencode/ directory
  for (const file of ['opencode.jsonc', 'opencode.json']) {
    const p = path.join(cwd, '.opencode', file);
    if (fs.existsSync(p)) return p;
  }
  // Default: create opencode.jsonc in .opencode/
  return path.join(cwd, '.opencode', 'opencode.jsonc');
}

/**
 * Strip JSONC comments (single-line // and block comments) from a string.
 * Preserves strings that contain // or comment-like patterns.
 */
function stripJsonComments(text) {
  let result = '';
  let i = 0;
  const len = text.length;

  while (i < len) {
    // String literal — copy verbatim
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < len && text[i] !== '"') {
        if (text[i] === '\\') {
          result += text[i++]; // backslash
          if (i < len) result += text[i++]; // escaped char
        } else {
          result += text[i++];
        }
      }
      if (i < len) result += text[i++]; // closing quote
      continue;
    }

    // Single-line comment
    if (text[i] === '/' && i + 1 < len && text[i + 1] === '/') {
      // Skip until end of line
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (text[i] === '/' && i + 1 < len && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && i + 1 < len && text[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }

    result += text[i++];
  }

  return result;
}

/**
 * Read and parse an opencode config file, handling JSONC.
 * Returns { data, raw, existed } where raw is the original file content.
 */
function readConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return { data: {}, raw: null, existed: false };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const stripped = stripJsonComments(raw);

  try {
    return { data: JSON.parse(stripped), raw, existed: true };
  } catch (e) {
    err(`Failed to parse ${filePath}: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Write a brand-new config file (no existing content to preserve).
 */
function writeNewConfig(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Add a plugin entry to a config file, preserving comments and formatting.
 * For new files, writes clean JSON. For existing files, does targeted edits.
 */
function addPluginEntry(filePath, raw, entry) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // New file — write clean JSON
  if (raw === null) {
    fs.writeFileSync(filePath, JSON.stringify({ plugin: [entry] }, null, 2) + '\n');
    return;
  }

  // Existing file with plugin array — insert into it
  const pluginArrayRegex = /"plugin"\s*:\s*\[([\s\S]*?)\]/;
  const match = raw.match(pluginArrayRegex);

  if (match) {
    // Parse existing entries from the stripped version to rebuild cleanly
    const stripped = stripJsonComments(raw);
    const data = JSON.parse(stripped);
    const plugins = data.plugin || [];
    plugins.push(entry);
    const formatted = plugins.map((p) => `"${p}"`).join(',\n    ');
    const newContent = raw.replace(pluginArrayRegex, `"plugin": [\n    ${formatted}\n  ]`);
    fs.writeFileSync(filePath, newContent);
    return;
  }

  // Existing file without plugin array — insert after opening {
  const newContent = raw.replace(/(\{)/, `$1\n  "plugin": ["${entry}"],`);
  fs.writeFileSync(filePath, newContent);
}

/**
 * Remove a plugin entry from a config file, preserving comments and formatting.
 */
function removePluginEntry(filePath, raw, plugins) {
  if (plugins.length === 0) {
    // Remove entire plugin key — replace "plugin": [...], with nothing
    const pluginKeyRegex = /\s*"plugin"\s*:\s*\[\s*\]\s*,?/;
    const newContent = raw.replace(pluginKeyRegex, '');
    fs.writeFileSync(filePath, newContent);
    return;
  }

  // Rebuild plugin array with remaining entries
  const pluginArrayRegex = /"plugin"\s*:\s*\[([\s\S]*?)\]/;
  const formatted = plugins.map((p) => `"${p}"`).join(',\n    ');
  const newContent = raw.replace(pluginArrayRegex, `"plugin": [\n    ${formatted}\n  ]`);
  fs.writeFileSync(filePath, newContent);
}

/**
 * Check if the plugin array contains a corvus-ai entry.
 * Matches "corvus-ai" or "corvus-ai@x.y.z".
 */
function findPluginEntry(plugins) {
  if (!Array.isArray(plugins)) return -1;
  return plugins.findIndex(
    (p) => typeof p === 'string' && (p === 'corvus-ai' || p.startsWith('corvus-ai@'))
  );
}

/**
 * Prompt user for confirmation. Returns true if confirmed.
 */
async function confirm(message) {
  if (force) return true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(`  ${message} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer);
}

// ---------------------------------------------------------------------------
// Install flow
// ---------------------------------------------------------------------------
async function install() {
  const targetPath = getTargetPath();
  const targetLabel = globalInstall ? 'global' : 'local';

  process.stdout.write(`\n${BOLD}  Corvus AI ${DIM}— Plugin Installer${RESET}\n`);
  process.stdout.write(`  Target: ${BOLD}${targetPath}${RESET} ${DIM}(${targetLabel})${RESET}\n\n`);

  const { data, raw, existed } = readConfig(targetPath);

  // Check if already installed
  if (Array.isArray(data.plugin) && findPluginEntry(data.plugin) !== -1) {
    ok(`corvus-ai is already in the plugin array.`);
    info('Nothing to do.');
    process.stdout.write('\n');
    process.exit(0);
  }

  // Show what will happen
  if (!existed) {
    info(`File does not exist. Will create: ${targetPath}`);
  }
  info(`Will add "${PLUGIN_ENTRY}" to the plugin array.`);

  if (dryRun) {
    process.stdout.write('\n');
    info('Dry run complete. No files were changed.');
    process.stdout.write('\n');
    process.exit(0);
  }

  // Add plugin entry (preserves comments in existing files)
  addPluginEntry(targetPath, raw, PLUGIN_ENTRY);

  process.stdout.write('\n');
  process.stdout.write(`${GREEN}${BOLD}  Plugin installed!${RESET}\n\n`);
  process.stdout.write(`  Added "${BOLD}${PLUGIN_ENTRY}${RESET}" to ${BOLD}${targetPath}${RESET}\n`);
  process.stdout.write(`\n${BOLD}  Next steps:${RESET}\n`);
  process.stdout.write(`  1. Run ${BOLD}opencode${RESET} in your project directory.\n`);
  process.stdout.write(`  2. Corvus agents, commands, and skills are now available.\n`);
  process.stdout.write(`  3. Start with ${BOLD}@corvus${RESET} for multi-agent orchestration.\n`);
  process.stdout.write(`\n  Docs: https://github.com/NachoFLizaur/corvus\n\n`);
}

// ---------------------------------------------------------------------------
// Uninstall flow
// ---------------------------------------------------------------------------
async function uninstall() {
  const targetPath = getTargetPath();
  const targetLabel = globalInstall ? 'global' : 'local';

  process.stdout.write(`\n${BOLD}  Corvus AI ${DIM}— Plugin Uninstaller${RESET}\n`);
  process.stdout.write(`  Target: ${BOLD}${targetPath}${RESET} ${DIM}(${targetLabel})${RESET}\n\n`);

  const { data, raw, existed } = readConfig(targetPath);

  if (!existed) {
    warn(`File does not exist: ${targetPath}`);
    info('Nothing to uninstall.');
    process.stdout.write('\n');
    process.exit(0);
  }

  const idx = findPluginEntry(data.plugin);
  if (idx === -1) {
    warn(`corvus-ai is not in the plugin array.`);
    info('Nothing to uninstall.');
    process.stdout.write('\n');
    process.exit(0);
  }

  const entry = data.plugin[idx];
  info(`Found plugin entry: "${entry}"`);
  info(`Will remove it from ${targetPath}`);

  if (dryRun) {
    process.stdout.write('\n');
    info('Dry run complete. No files were changed.');
    process.stdout.write('\n');
    process.exit(0);
  }

  if (!(await confirm('Remove corvus-ai from the plugin array?'))) {
    info('Uninstall cancelled.');
    process.stdout.write('\n');
    process.exit(0);
  }

  // Remove entry (preserves comments in existing files)
  const remaining = data.plugin.filter((_, i) => i !== idx);
  removePluginEntry(targetPath, raw, remaining);

  process.stdout.write('\n');
  process.stdout.write(`${GREEN}${BOLD}  Plugin removed!${RESET}\n\n`);
  process.stdout.write(`  Removed "${BOLD}${entry}${RESET}" from ${BOLD}${targetPath}${RESET}\n\n`);
}

// ---------------------------------------------------------------------------
// Migrate flow
// ---------------------------------------------------------------------------
async function migrateFlow() {
  const targetPath = getTargetPath();
  const targetLabel = globalInstall ? 'global' : 'local';
  const configDir = path.join(os.homedir(), '.config', 'opencode');

  process.stdout.write(`\n${BOLD}  Corvus AI ${DIM}— Migration Tool${RESET}\n`);
  process.stdout.write(`  Plugin target: ${BOLD}${targetPath}${RESET} ${DIM}(${targetLabel})${RESET}\n`);
  process.stdout.write(`  Cleanup target: ${BOLD}${configDir}${RESET}\n\n`);

  // --- Scan for manual corvus files ---
  const filesToRemove = [];
  const dirsToRemove = [];

  // Agents
  for (const f of CORVUS_AGENTS) {
    const p = path.join(configDir, 'agent', f);
    if (fs.existsSync(p)) filesToRemove.push(p);
  }

  // Commands
  for (const f of CORVUS_COMMANDS) {
    const p = path.join(configDir, 'command', f);
    if (fs.existsSync(p)) filesToRemove.push(p);
  }

  // Skills (directories)
  for (const s of CORVUS_SKILLS) {
    const p = path.join(configDir, 'skill', s);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      dirsToRemove.push(p);
    }
  }

  // Also check for AGENTS.md in config dir
  const agentsMd = path.join(configDir, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    // Only remove if it looks like a corvus AGENTS.md
    const content = fs.readFileSync(agentsMd, 'utf8');
    if (content.includes('corvus') || content.includes('Corvus')) {
      filesToRemove.push(agentsMd);
    }
  }

  const totalItems = filesToRemove.length + dirsToRemove.length;

  if (totalItems === 0) {
    info('No manual corvus files found in ~/.config/opencode/');
    info('Proceeding with plugin installation...');
    process.stdout.write('\n');
  } else {
    // Display what will be removed
    process.stdout.write(`  ${BOLD}Files to remove:${RESET} ${filesToRemove.length}\n`);
    for (const f of filesToRemove) {
      process.stdout.write(`    ${RED}-${RESET} ${path.relative(configDir, f)}\n`);
    }

    if (dirsToRemove.length > 0) {
      process.stdout.write(`\n  ${BOLD}Directories to remove:${RESET} ${dirsToRemove.length}\n`);
      for (const d of dirsToRemove) {
        process.stdout.write(`    ${RED}-${RESET} ${path.relative(configDir, d)}/\n`);
      }
    }

    process.stdout.write(`\n  ${BOLD}Total:${RESET} ${totalItems} item(s) to remove\n\n`);

    if (dryRun) {
      // Also show what the install step would do
      const { data } = readConfig(targetPath);
      if (Array.isArray(data.plugin) && findPluginEntry(data.plugin) !== -1) {
        info(`Plugin "corvus-ai" is already in ${targetPath}`);
      } else {
        info(`Would add "${PLUGIN_ENTRY}" to ${targetPath}`);
      }
      process.stdout.write('\n');
      info('Dry run complete. No files were changed.');
      process.stdout.write('\n');
      process.exit(0);
    }

    if (!(await confirm('Remove these files and install the plugin?'))) {
      info('Migration cancelled.');
      process.stdout.write('\n');
      process.exit(0);
    }

    process.stdout.write('\n');

    // Remove files
    for (const f of filesToRemove) {
      fs.unlinkSync(f);
      ok(`Removed: ${path.relative(configDir, f)}`);
    }

    // Remove directories
    for (const d of dirsToRemove) {
      fs.rmSync(d, { recursive: true });
      ok(`Removed: ${path.relative(configDir, d)}/`);
    }

    // Clean up empty parent directories
    for (const subdir of ['agent', 'command', 'skill']) {
      const dirPath = path.join(configDir, subdir);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        const entries = fs.readdirSync(dirPath);
        if (entries.length === 0) {
          fs.rmdirSync(dirPath);
          info(`Cleaned up empty directory: ${subdir}/`);
        }
      }
    }

    process.stdout.write('\n');
    ok(`Removed ${totalItems} corvus item(s) from ${configDir}`);
  }

  // --- Now do the install step ---
  process.stdout.write('\n');
  info('Adding plugin entry...');

  const { data, raw, existed } = readConfig(targetPath);

  if (Array.isArray(data.plugin) && findPluginEntry(data.plugin) !== -1) {
    ok(`corvus-ai is already in the plugin array.`);
  } else {
    addPluginEntry(targetPath, raw, PLUGIN_ENTRY);
    ok(`Added "${PLUGIN_ENTRY}" to ${targetPath}`);
  }

  process.stdout.write('\n');
  process.stdout.write(`${GREEN}${BOLD}  Migration complete!${RESET}\n\n`);
  if (totalItems > 0) {
    process.stdout.write(`  Manual files removed: ${BOLD}${totalItems}${RESET}\n`);
  }
  process.stdout.write(`  Plugin config:        ${BOLD}${targetPath}${RESET}\n`);
  process.stdout.write(`\n${BOLD}  Next steps:${RESET}\n`);
  process.stdout.write(`  1. Restart ${BOLD}opencode${RESET} to pick up the plugin.\n`);
  process.stdout.write(`  2. All corvus agents, commands, and skills are now loaded via the plugin.\n`);
  process.stdout.write(`\n  Docs: https://github.com/NachoFLizaur/corvus\n\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (uninstallMode) {
  await uninstall();
} else if (migrate) {
  await migrateFlow();
} else {
  await install();
}
