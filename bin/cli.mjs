#!/usr/bin/env node

// Corvus AI — Plugin Installer for OpenCode
// Usage: npx corvus-ai [--v2] [--global] [--force] [--uninstall] [--migrate] [--dry-run] [--help]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

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

// OpenCode v2 resolves each entry of the plural "plugins" array as its own npm
// specifier, so the v2 entry is pinned to the version of the package running this
// installer (`npx corvus-ai@beta --v2` pins the beta). A floating tag could resolve
// to a release without v2 support.
const OWN_VERSION = readOwnVersion();
const V2_PLUGIN_ENTRY = OWN_VERSION ? `corvus-ai@${OWN_VERSION}` : PLUGIN_ENTRY;

function readOwnVersion() {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

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
let v2Flag = false;
// Resolved once in main(): true when the OpenCode v2 config layout is the target.
let v2Mode = false;

const args = process.argv.slice(2);

for (const arg of args) {
  switch (arg) {
    case '--global':
      globalInstall = true;
      break;
    case '--v2':
      v2Flag = true;
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
  ${BOLD}--v2${RESET}           Install for OpenCode v2: add corvus-ai to the "plugins" array in
                 $XDG_CONFIG_HOME/opencode/opencode.json (default ~/.config/opencode).
                 Offered automatically when only an "opencode2" binary is on your PATH.
                 Run it as "npx corvus-ai@beta --v2" while v2 ships on the "beta"
                 dist-tag; "latest" has no --v2 flag. Drop "@beta" once v2 is latest.
  ${BOLD}--global${RESET}       Target ~/.config/opencode/opencode.json instead of local
                 (implied by --v2, which always targets the global v2 config)
  ${BOLD}--uninstall${RESET}    Remove corvus-ai from all discovered config files and clean up cached packages
  ${BOLD}--migrate${RESET}      Remove manual corvus files from ~/.config/opencode/ and add plugin
  ${BOLD}--force${RESET}        Skip confirmation prompts
  ${BOLD}--dry-run${RESET}      Preview changes without modifying anything
  ${BOLD}--help, -h${RESET}     Show this help message

${BOLD}Examples:${RESET}
  npx corvus-ai                       Install plugin locally
  npx corvus-ai --global              Install plugin globally
  npx corvus-ai@beta --v2             Install plugin for OpenCode v2
  npx corvus-ai@beta --v2 --uninstall Remove plugin from the v2 config
  npx corvus-ai --migrate             Migrate from manual files to plugin
  npx corvus-ai --uninstall           Remove plugin entry
  npx corvus-ai --dry-run             Preview what would change
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the target config path.
 * Checks for existing files in OpenCode's discovery order,
 * and creates opencode.jsonc in .opencode/ (local) or ~/.config/opencode/ (global).
 * In v2 mode the target is always the XDG-resolved global v2 config.
 */
function getTargetPath() {
  if (v2Mode) return getV2TargetPath();

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

// ---------------------------------------------------------------------------
// OpenCode v2 helpers
// ---------------------------------------------------------------------------

/** Config files OpenCode v2 reads (the legacy `config.json` name is v1-only). */
const V2_CONFIG_FILES = ['opencode.jsonc', 'opencode.json'];

/** True when the config dir comes from an explicit XDG_CONFIG_HOME (the `oc2` alias case). */
function hasCustomXdgConfigHome() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return typeof xdg === 'string' && xdg.trim().length > 0;
}

/**
 * The global config directory OpenCode v2 reads: $XDG_CONFIG_HOME/opencode,
 * falling back to ~/.config/opencode when XDG_CONFIG_HOME is unset or empty.
 */
function getV2ConfigDir() {
  const base = hasCustomXdgConfigHome()
    ? process.env.XDG_CONFIG_HOME.trim()
    : path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

/** The cache dir OpenCode v2 installs plugin packages under: $XDG_CACHE_HOME or ~/.cache. */
function getXdgCacheHome() {
  const xdg = process.env.XDG_CACHE_HOME;
  return typeof xdg === 'string' && xdg.trim().length > 0
    ? xdg.trim()
    : path.join(os.homedir(), '.cache');
}

/** Existing v2 config file in load order, else the file to create (opencode.json). */
function getV2TargetPath() {
  const dir = getV2ConfigDir();
  for (const file of V2_CONFIG_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, 'opencode.json');
}

/** True when `name` resolves to an executable file on PATH. */
function isOnPath(name) {
  const candidates =
    process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const p = path.join(dir, candidate);
      try {
        if (!fs.statSync(p).isFile()) continue;
        if (process.platform === 'win32') return true;
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

/** Confirmation defaulting to yes; auto-accepts when non-interactive or --force. */
async function confirmDefaultYes(message) {
  if (force || !process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  ${message} [Y/n] `);
  rl.close();
  return !/^n(o)?$/i.test(answer.trim());
}

/**
 * Decide whether to use the v2 config layout.
 * `--v2` is explicit. Without it, only an unambiguous host (opencode2 present and no
 * v1 opencode) offers v2 — when both hosts exist the v1 path stays the default so a
 * bare `npx corvus-ai` never writes to a config the user did not ask for.
 */
async function resolveV2Mode() {
  if (v2Flag) return true;
  if (!isOnPath('opencode2')) return false;

  process.stdout.write('\n');
  if (isOnPath('opencode')) {
    info('Detected both "opencode" (v1) and "opencode2" (v2) on your PATH.');
    info('Using the v1 config layout (singular "plugin" key).');
    info('For OpenCode v2 instead, re-run with: npx corvus-ai@beta --v2');
    info('"@beta" is required while v2 ships on the beta dist-tag ("latest" has no --v2).');
    return false;
  }

  info('Detected "opencode2" (v2) on your PATH and no v1 "opencode" binary.');
  info(`v2 config: ${getV2TargetPath()}`);
  if (await confirmDefaultYes('Install for OpenCode v2?')) return true;

  info('Continuing with the OpenCode v1 config layout (singular "plugin" key).');
  return false;
}

/** Render a `"plugins": [...]` key using the same shape the v1 writer produces. */
function renderPluginsArray(entries) {
  if (entries.length === 0) return '"plugins": []';
  const formatted = entries.map((e) => JSON.stringify(e)).join(',\n    ');
  return `"plugins": [\n    ${formatted}\n  ]`;
}

const PLUGINS_ARRAY_REGEX = /"plugins"\s*:\s*\[[\s\S]*?\]/;

/** The v2 `plugins` array, or [] when the key is absent. */
function readPluginsArray(data, filePath) {
  if (data.plugins === undefined) return [];
  if (!Array.isArray(data.plugins)) {
    err(`"plugins" in ${filePath} is not an array.`);
    err('OpenCode v2 expects "plugins": ["corvus-ai@1.2.3"]. Fix the key manually, then re-run.');
    process.exit(1);
  }
  return data.plugins;
}

/**
 * Replace every corvus entry with a single pinned entry, in place.
 * Appends when no corvus entry exists. Other entries keep their order.
 */
function withSingleCorvusEntry(entries, entry) {
  const result = [];
  let replaced = false;
  for (const e of entries) {
    if (!isCorvusEntry(e)) {
      result.push(e);
      continue;
    }
    if (!replaced) {
      result.push(entry);
      replaced = true;
    }
  }
  if (!replaced) result.push(entry);
  return result;
}

/**
 * Write text only if it still parses as JSON(C). The comment-preserving edits below
 * are textual, so a hand-formatted config could defeat them — refuse rather than
 * corrupt the user's file.
 */
function writeV2Text(filePath, text, manualHint) {
  try {
    JSON.parse(stripJsonComments(text));
  } catch (e) {
    err(`Refusing to edit ${filePath}: the change would produce invalid JSON (${e.message}).`);
    err(manualHint);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

/**
 * Write the v2 `plugins` array, preserving comments, unknown keys, and any singular
 * v1 `plugin` key (this path never reads or writes `data.plugin`).
 */
function writePluginsArray(filePath, raw, data, entries) {
  const manualHint = `Add ${JSON.stringify(V2_PLUGIN_ENTRY)} to the "plugins" array in ${filePath} manually.`;

  // New file — write clean JSON
  if (raw === null) {
    writeNewConfig(filePath, { plugins: entries });
    return;
  }

  // Existing "plugins" array — rebuild it
  if (PLUGINS_ARRAY_REGEX.test(raw)) {
    writeV2Text(
      filePath,
      raw.replace(PLUGINS_ARRAY_REGEX, () => renderPluginsArray(entries)),
      manualHint
    );
    return;
  }

  // No "plugins" key — insert after the opening brace (no trailing comma when the
  // object has no other keys, which would be invalid JSON)
  const rendered = renderPluginsArray(entries);
  const hasOtherKeys = Object.keys(data).length > 0;
  writeV2Text(
    filePath,
    raw.replace(/\{/, () => (hasOtherKeys ? `{\n  ${rendered},` : `{\n  ${rendered}\n`)),
    manualHint
  );
}

/**
 * Remove corvus entries from the v2 `plugins` array, dropping the key entirely when
 * nothing else remains. Never touches a singular v1 `plugin` key.
 */
function removeFromPluginsArray(filePath, raw, remaining) {
  const manualHint = `Remove the corvus-ai entry from the "plugins" array in ${filePath} manually.`;

  if (remaining.length > 0) {
    writeV2Text(
      filePath,
      raw.replace(PLUGINS_ARRAY_REGEX, () => renderPluginsArray(remaining)),
      manualHint
    );
    return;
  }

  // Drop the whole key, taking the neighbouring comma with it
  const keyRegex = /(,?)\s*"plugins"\s*:\s*\[[\s\S]*?\](\s*,)?/;
  const withoutKey = raw.replace(keyRegex, (_m, lead, trail) => (trail ? lead : ''));
  try {
    JSON.parse(stripJsonComments(withoutKey));
    fs.writeFileSync(filePath, withoutKey);
    return;
  } catch {
    // Formatting defeated the key removal — leave a valid empty array instead
    writeV2Text(filePath, raw.replace(PLUGINS_ARRAY_REGEX, () => '"plugins": []'), manualHint);
  }
}

/** What a v2 write would do to the `plugins` array of an already-read config. */
function planV2Entry(data, filePath) {
  const existing = readPluginsArray(data, filePath);
  const corvus = existing.filter(isCorvusEntry);
  return {
    existing,
    corvus,
    upToDate: corvus.length === 1 && corvus[0] === V2_PLUGIN_ENTRY,
  };
}

/** Preview line for a planned v2 write (dry runs). */
function infoV2Plan(plan, filePath) {
  if (plan.upToDate) {
    info(`Plugin "${V2_PLUGIN_ENTRY}" is already in the plugins array of ${filePath}`);
  } else if (plan.corvus.length > 0) {
    info(
      `Would replace ${plan.corvus.map((e) => `"${e}"`).join(', ')} with "${V2_PLUGIN_ENTRY}" in the plugins array of ${filePath}`
    );
  } else {
    info(`Would add "${V2_PLUGIN_ENTRY}" to the plugins array of ${filePath}`);
  }
}

/**
 * Report a singular v1 `plugin` key without ever modifying it (requirement: the
 * installer must not migrate it). OpenCode v2 concatenates the legacy key onto
 * `plugins` (core/src/config/normalize.ts), so a corvus entry in both keys lands
 * twice in the resolved plugin list.
 */
function noteV1PluginKey(data, filePath, hint) {
  if (!('plugin' in data)) return;
  const entries = Array.isArray(data.plugin) ? data.plugin : [];
  const idx = findPluginEntry(entries);
  warn(`${filePath} also has a v1 "plugin" key — left untouched.`);
  info('OpenCode v2 merges the legacy "plugin" key into "plugins" on load.');
  if (idx !== -1) {
    warn(`It lists "${entries[idx]}", which v2 folds into its resolved "plugins" list as well.`);
    info(`${hint} The installer never edits the "plugin" key.`);
  }
}

/**
 * Find all config files whose `key` array contains corvus-ai by walking up from cwd,
 * mirroring OpenCode's findUp discovery logic, then checking the global config dir.
 * Returns array of file paths.
 */
function findConfigsWithCorvus(key, globalDir, globalFiles) {
  const found = [];
  let current = process.cwd();

  while (true) {
    // Check opencode.jsonc and opencode.json at this level
    for (const file of ['opencode.jsonc', 'opencode.json']) {
      const p = path.join(current, file);
      if (fs.existsSync(p)) {
        const { data } = readConfig(p);
        if (findPluginEntry(data[key]) !== -1) found.push(p);
      }
    }
    // Check .opencode/ directory at this level
    for (const file of ['opencode.jsonc', 'opencode.json']) {
      const p = path.join(current, '.opencode', file);
      if (fs.existsSync(p)) {
        const { data } = readConfig(p);
        if (findPluginEntry(data[key]) !== -1) found.push(p);
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Also check global config
  for (const file of globalFiles) {
    const p = path.join(globalDir, file);
    if (fs.existsSync(p)) {
      const { data } = readConfig(p);
      if (findPluginEntry(data[key]) !== -1) found.push(p);
    }
  }

  // Deduplicate (in case global dir was already visited during walk-up)
  return [...new Set(found)];
}

/** v1 discovery: the singular `plugin` key, including the legacy `config.json` name. */
function findAllConfigsWithCorvus() {
  return findConfigsWithCorvus('plugin', path.join(os.homedir(), '.config', 'opencode'), [
    'opencode.jsonc',
    'opencode.json',
    'config.json',
  ]);
}

/** v2 discovery: the plural `plugins` key, rooted at the XDG-resolved config dir. */
function findAllConfigsWithCorvusV2(key = 'plugins') {
  return findConfigsWithCorvus(key, getV2ConfigDir(), V2_CONFIG_FILES);
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
    // Remove entire plugin key — match the array with its current contents
    const pluginKeyRegex = /\s*"plugin"\s*:\s*\[[\s\S]*?\]\s*,?/;
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
 * Check if a plugin array entry is corvus-ai.
 * Matches "corvus-ai" or "corvus-ai@x.y.z".
 */
function isCorvusEntry(entry) {
  return typeof entry === 'string' && (entry === 'corvus-ai' || entry.startsWith('corvus-ai@'));
}

/**
 * Check if the plugin array contains a corvus-ai entry.
 * Matches "corvus-ai" or "corvus-ai@x.y.z".
 */
function findPluginEntry(plugins) {
  if (!Array.isArray(plugins)) return -1;
  return plugins.findIndex(isCorvusEntry);
}

/**
 * Remove corvus-ai from a directory's package.json dependencies and node_modules.
 * Returns an array of actions taken (for display).
 */
function cleanupNodeModules(dir) {
  const actions = [];

  // Remove from package.json
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.dependencies && pkg.dependencies['corvus-ai']) {
        delete pkg.dependencies['corvus-ai'];
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        actions.push(`Removed corvus-ai from ${pkgPath}`);
      }
    } catch {}
  }

  // Remove node_modules/corvus-ai
  const modPath = path.join(dir, 'node_modules', 'corvus-ai');
  if (fs.existsSync(modPath)) {
    fs.rmSync(modPath, { recursive: true });
    actions.push(`Removed ${modPath}`);
  }

  return actions;
}

/**
 * Walk up from `start` to filesystem root, looking for node_modules/corvus-ai.
 * Returns array of directories (not the node_modules path) where it was found.
 * Skips directories in the `exclude` set.
 */
function findStaleNodeModules(start, exclude) {
  const found = [];
  let current = path.resolve(start);
  while (true) {
    if (!exclude.has(current)) {
      const modPath = path.join(current, 'node_modules', 'corvus-ai');
      if (fs.existsSync(modPath)) {
        found.push(current);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
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
  if (v2Mode) return installV2();

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
// Install flow (OpenCode v2)
// ---------------------------------------------------------------------------

/** Header shared by the v2 flows: target file and where the config dir came from. */
function printV2Header(title, targetPath) {
  process.stdout.write(`\n${BOLD}  Corvus AI ${DIM}— ${title} (OpenCode v2)${RESET}\n`);
  process.stdout.write(`  Target: ${BOLD}${targetPath}${RESET} ${DIM}(global v2)${RESET}\n`);
  if (hasCustomXdgConfigHome()) {
    process.stdout.write(
      `  Config dir from ${BOLD}$XDG_CONFIG_HOME${RESET}=${BOLD}${process.env.XDG_CONFIG_HOME.trim()}${RESET}\n`
    );
  }
  process.stdout.write('\n');
}

/** Closing tip for users whose v2 host runs with a custom config dir (e.g. an `oc2` alias). */
function printV2XdgTip() {
  if (hasCustomXdgConfigHome()) return;
  process.stdout.write(
    `\n${DIM}  Launching v2 with a custom config dir (e.g. an "oc2" alias)? Target it with:${RESET}\n`
  );
  process.stdout.write(
    `    ${BOLD}XDG_CONFIG_HOME="$HOME/.config/opencode2" npx corvus-ai@beta --v2${RESET}\n`
  );
}

async function installV2() {
  const targetPath = getTargetPath();
  printV2Header('Plugin Installer', targetPath);

  const { data, raw, existed } = readConfig(targetPath);
  const existing = readPluginsArray(data, targetPath);
  const corvus = existing.filter(isCorvusEntry);

  // Status: report the plural key, plus the singular v1 key when both are present
  if (existing.length > 0) {
    info(`Current "plugins": ${existing.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  noteV1PluginKey(data, targetPath, 'Remove it once you no longer run OpenCode v1.');

  // Already pinned to this exact version, and no duplicate corvus entries
  if (corvus.length === 1 && corvus[0] === V2_PLUGIN_ENTRY) {
    ok(`"${V2_PLUGIN_ENTRY}" is already in the plugins array.`);
    info('Nothing to do.');
    process.stdout.write('\n');
    process.exit(0);
  }

  // Show what will happen
  if (!existed) {
    info(`File does not exist. Will create: ${targetPath}`);
  }
  if (corvus.length === 0) {
    info(`Will add "${V2_PLUGIN_ENTRY}" to the plugins array.`);
  } else {
    info(
      `Will replace ${corvus.map((e) => `"${e}"`).join(', ')} with "${V2_PLUGIN_ENTRY}" in the plugins array.`
    );
  }

  if (dryRun) {
    process.stdout.write('\n');
    info('Dry run complete. No files were changed.');
    process.stdout.write('\n');
    process.exit(0);
  }

  const entries = withSingleCorvusEntry(existing, V2_PLUGIN_ENTRY);
  writePluginsArray(targetPath, raw, data, entries);

  process.stdout.write('\n');
  process.stdout.write(`${GREEN}${BOLD}  Plugin installed for OpenCode v2!${RESET}\n\n`);
  process.stdout.write(`  Config: ${BOLD}${targetPath}${RESET}\n`);
  if (corvus.length === 0) {
    process.stdout.write(
      `  Added:  ${BOLD}"${V2_PLUGIN_ENTRY}"${RESET} to the ${BOLD}"plugins"${RESET} array\n`
    );
  } else {
    process.stdout.write(
      `  Updated: ${corvus.map((e) => `"${e}"`).join(', ')} → ${BOLD}"${V2_PLUGIN_ENTRY}"${RESET} in the ${BOLD}"plugins"${RESET} array\n`
    );
  }
  process.stdout.write(`\n${BOLD}  Next steps:${RESET}\n`);
  process.stdout.write(`  1. Restart ${BOLD}opencode2${RESET} to load the plugin.\n`);
  process.stdout.write(`  2. Corvus agents, commands, and skills are now available.\n`);
  process.stdout.write(`  3. Start with ${BOLD}@corvus${RESET} for multi-agent orchestration.\n`);
  printV2XdgTip();
  process.stdout.write(`\n  Docs: https://github.com/NachoFLizaur/corvus\n\n`);
}

// ---------------------------------------------------------------------------
// Uninstall flow
// ---------------------------------------------------------------------------
async function uninstall() {
  const label = v2Mode ? 'Plugin Uninstaller (OpenCode v2)' : 'Plugin Uninstaller';
  process.stdout.write(`\n${BOLD}  Corvus AI ${DIM}— ${label}${RESET}\n\n`);

  // Find all config files that reference corvus-ai
  const configFiles = v2Mode ? findAllConfigsWithCorvusV2() : findAllConfigsWithCorvus();

  if (configFiles.length === 0) {
    warn(
      v2Mode
        ? 'corvus-ai was not found in any OpenCode v2 "plugins" array.'
        : 'corvus-ai was not found in any OpenCode config file.'
    );
    info('Searched project configs (walking up from cwd), .opencode/ directories, and global config.');
    process.stdout.write('\n');
  } else {
    info(`Found corvus-ai in ${configFiles.length} config file(s):`);
    for (const f of configFiles) {
      process.stdout.write(`    ${BOLD}${f}${RESET}\n`);
    }
    process.stdout.write('\n');
  }

  // Preview cleanup targets
  const cacheDir = v2Mode ? path.join(getXdgCacheHome(), 'opencode') : path.join(os.homedir(), '.cache', 'opencode');
  const localDir = path.join(process.cwd(), '.opencode');
  const globalDir = v2Mode ? getV2ConfigDir() : path.join(os.homedir(), '.config', 'opencode');
  const cleanupDirs = [cacheDir, localDir, globalDir];

  if (dryRun) {
    for (const dir of cleanupDirs) {
      const pkgPath = path.join(dir, 'package.json');
      const modPath = path.join(dir, 'node_modules', 'corvus-ai');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.dependencies?.['corvus-ai']) {
            info(`Would remove corvus-ai from ${pkgPath}`);
          }
        } catch {}
      }
      if (fs.existsSync(modPath)) {
        info(`Would remove ${modPath}`);
      }
    }

    const cleaned = new Set(cleanupDirs.map((d) => path.resolve(d)));
    const stale = findStaleNodeModules(process.cwd(), cleaned);
    if (stale.length > 0) {
      for (const dir of stale) {
        warn(`Would warn about stale: ${path.join(dir, 'node_modules', 'corvus-ai')}`);
      }
    }

    process.stdout.write('\n');
    info('Dry run complete. No files were changed.');
    process.stdout.write('\n');
    process.exit(0);
  }

  if (configFiles.length === 0) {
    // No config entries, but still proceed to clean up cached packages
  } else {
    if (!(await confirm('Remove corvus-ai from all config files and clean up cached packages?'))) {
      info('Uninstall cancelled.');
      process.stdout.write('\n');
      process.exit(0);
    }

    // Remove config entries
    for (const filePath of configFiles) {
      const { data, raw } = readConfig(filePath);

      if (v2Mode) {
        // v2: only corvus entries in the plural "plugins" array; the singular v1
        // "plugin" key is reported but never modified.
        const existing = readPluginsArray(data, filePath);
        const removed = existing.filter(isCorvusEntry);
        if (removed.length === 0) continue;
        const remaining = existing.filter((e) => !isCorvusEntry(e));
        removeFromPluginsArray(filePath, raw, remaining);
        ok(`Removed ${removed.map((e) => `"${e}"`).join(', ')} from ${filePath}`);
        noteV1PluginKey(data, filePath, 'Remove it from "plugin" yourself to fully drop corvus.');
        continue;
      }

      const idx = findPluginEntry(data.plugin);
      if (idx === -1) continue;
      const entry = data.plugin[idx];
      const remaining = data.plugin.filter((_, i) => i !== idx);
      removePluginEntry(filePath, raw, remaining);
      ok(`Removed "${entry}" from ${filePath}`);
    }
  }

  // v2: point out corvus entries left in a singular "plugin" key we never edit
  if (v2Mode) {
    const v1Leftovers = findAllConfigsWithCorvusV2('plugin').filter(
      (f) => !configFiles.includes(f)
    );
    for (const filePath of v1Leftovers) {
      warn(`corvus-ai is still listed under the v1 "plugin" key in ${filePath}.`);
      info('The installer never edits that key — remove the entry manually if you want it gone.');
    }
  }

  // --- Clean up cached/installed packages ---
  const allActions = [];
  for (const dir of cleanupDirs) {
    if (!fs.existsSync(dir)) continue;
    allActions.push(...cleanupNodeModules(dir));
  }

  for (const action of allActions) {
    ok(action);
  }

  // --- Warn about stale node_modules in ancestor directories ---
  const cleaned = new Set(cleanupDirs.map((d) => path.resolve(d)));
  const stale = findStaleNodeModules(process.cwd(), cleaned);
  if (stale.length > 0) {
    process.stdout.write('\n');
    warn('corvus-ai was also found in node_modules at:');
    for (const dir of stale) {
      process.stdout.write(`    ${YELLOW}${path.join(dir, 'node_modules', 'corvus-ai')}${RESET}\n`);
    }
    process.stdout.write('\n');
    info('These are outside OpenCode\'s managed directories.');
    info('To fully remove, run:');
    for (const dir of stale) {
      process.stdout.write(`    ${BOLD}rm -rf ${path.join(dir, 'node_modules', 'corvus-ai')}${RESET}\n`);
    }
  }

  process.stdout.write('\n');
  process.stdout.write(`${GREEN}${BOLD}  Plugin removed!${RESET}\n\n`);
}

// ---------------------------------------------------------------------------
// Migrate flow
// ---------------------------------------------------------------------------
async function migrateFlow() {
  const targetPath = getTargetPath();
  const targetLabel = v2Mode ? 'global v2' : globalInstall ? 'global' : 'local';
  // In v2 mode a manual install lives under the XDG-resolved v2 config dir
  const configDir = v2Mode ? getV2ConfigDir() : path.join(os.homedir(), '.config', 'opencode');
  const configDirLabel = v2Mode ? configDir : '~/.config/opencode/';

  process.stdout.write(`\n${BOLD}  Corvus AI ${DIM}— Migration Tool${v2Mode ? ' (OpenCode v2)' : ''}${RESET}\n`);
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
    info(`No manual corvus files found in ${configDirLabel}`);
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
      if (v2Mode) {
        infoV2Plan(planV2Entry(data, targetPath), targetPath);
        noteV1PluginKey(data, targetPath, 'Remove it once you no longer run OpenCode v1.');
      } else if (Array.isArray(data.plugin) && findPluginEntry(data.plugin) !== -1) {
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

  if (v2Mode) {
    const plan = planV2Entry(data, targetPath);
    noteV1PluginKey(data, targetPath, 'Remove it once you no longer run OpenCode v1.');

    // Only reachable in a dry run when there was nothing to remove above; the v2 path
    // must not write in that case (the v1 path keeps its existing behavior here).
    if (dryRun) {
      infoV2Plan(plan, targetPath);
      process.stdout.write('\n');
      info('Dry run complete. No files were changed.');
      process.stdout.write('\n');
      process.exit(0);
    }

    if (plan.upToDate) {
      ok(`"${V2_PLUGIN_ENTRY}" is already in the plugins array.`);
    } else {
      writePluginsArray(targetPath, raw, data, withSingleCorvusEntry(plan.existing, V2_PLUGIN_ENTRY));
      if (plan.corvus.length > 0) {
        ok(
          `Replaced ${plan.corvus.map((e) => `"${e}"`).join(', ')} with "${V2_PLUGIN_ENTRY}" in ${targetPath}`
        );
      } else {
        ok(`Added "${V2_PLUGIN_ENTRY}" to the plugins array in ${targetPath}`);
      }
    }
  } else if (Array.isArray(data.plugin) && findPluginEntry(data.plugin) !== -1) {
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
  process.stdout.write(`  1. Restart ${BOLD}${v2Mode ? 'opencode2' : 'opencode'}${RESET} to pick up the plugin.\n`);
  process.stdout.write(`  2. All corvus agents, commands, and skills are now loaded via the plugin.\n`);
  if (v2Mode) printV2XdgTip();
  process.stdout.write(`\n  Docs: https://github.com/NachoFLizaur/corvus\n\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
v2Mode = await resolveV2Mode();

if (v2Mode) {
  if (globalInstall) {
    info('--v2 always targets the global v2 config, so --global is implied (no-op).');
  }
  if (!OWN_VERSION) {
    warn(
      `Could not read this package's version; using "${V2_PLUGIN_ENTRY}". Pin an explicit version in "plugins" if v2 support is missing.`
    );
  }
}

if (uninstallMode) {
  await uninstall();
} else if (migrate) {
  await migrateFlow();
} else {
  await install();
}
