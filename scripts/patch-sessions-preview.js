/**
 * Patch: Add session preview (last user message) to /sessions command.
 *
 * This patches node_modules/claude-to-im/dist/lib/bridge/bridge-manager.js
 * to show the last user message from each session's JSONL file when
 * listing sessions via the /sessions command in IM.
 *
 * Features:
 * - Shows ALL Claude Code sessions (IM-bound + terminal-created)
 * - Sorted by last activity time (most recent first)
 * - Shows up to 20 sessions
 * - Marks current session with ◀
 * - Shows last user message preview for each session
 * - Shows project directory for terminal sessions
 *
 * Run automatically via postinstall, or manually: node scripts/patch-sessions-preview.js
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, '..', 'node_modules', 'claude-to-im', 'dist', 'lib', 'bridge', 'bridge-manager.js');

if (!existsSync(TARGET)) {
  console.log('[patch-sessions-preview] Target not found, skipping (not yet installed?)');
  process.exit(0);
}

let code = readFileSync(TARGET, 'utf-8');

// ── Guard: skip if already patched ──
if (code.includes('_scanAllSessions')) {
  console.log('[patch-sessions-preview] Already patched, skipping.');
  process.exit(0);
}

// ── 1. Inject helper functions after the last existing import ──
const HELPERS = `
import { readFileSync as _readFileSync, existsSync as _existsSync, readdirSync as _readdirSync, statSync as _statSync } from 'node:fs';
import { join as _join, basename as _basename } from 'node:path';
import { homedir as _homedir } from 'node:os';

function _projectDirToLabel(dirName) {
    // Read cwd from a session JSONL (appears in 'progress' or 'user' lines, ~line 3-5)
    const projectsRoot = _join(_homedir(), '.claude', 'projects');
    try {
        const pdPath = _join(projectsRoot, dirName);
        const entries = require('node:fs').readdirSync(pdPath, { withFileTypes: true });
        for (const f of entries) {
            if (f.isFile() && f.name.endsWith('.jsonl')) {
                const fp = _join(pdPath, f.name);
                const fd = require('node:fs').openSync(fp, 'r');
                const buf = Buffer.alloc(4096);
                const bytesRead = require('node:fs').readSync(fd, buf, 0, 4096, 0);
                require('node:fs').closeSync(fd);
                const head = buf.toString('utf-8', 0, bytesRead);
                for (const line of head.split('\\n').slice(0, 10)) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj.cwd) return obj.cwd.replace(_homedir(), '~');
                    } catch {}
                }
                break;
            }
        }
    } catch {}
    // Fallback: strip home prefix, keep dashes as-is
    const home = _homedir();
    const user = home.replace(/[^a-zA-Z0-9.]/g, '-');
    let label = dirName;
    if (label.startsWith(user)) {
        label = '~/' + label.slice(user.length).replace(/^-/, '');
    }
    return label || dirName;
}

function _cleanPreview(raw, maxLen) {
    let t = raw;
    // Strip [sender: ...] prefix
    t = t.replace(/^\\[sender:\\s*[^\\]]*\\]\\s*/, '');
    // Strip XML/HTML tags
    t = t.replace(/<[^>]*>/g, '');
    // Strip markdown: bold, italic, code, headers, links, images
    t = t.replace(/\\*\\*([^*]*)\\*\\*/g, '$1');
    t = t.replace(/\\*([^*]*)\\*/g, '$1');
    const BT = String.fromCharCode(96);
    t = t.replace(new RegExp(BT + '{1,3}[^' + BT + ']*' + BT + '{1,3}', 'g'), '');
    t = t.replace(/^#{1,6}\\s+/gm, '');
    t = t.replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1');
    t = t.replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, '');
    // Strip markdown list prefixes
    t = t.replace(/^\\s*[-*+]\\s+/gm, '');
    t = t.replace(/^\\s*\\d+\\.\\s+/gm, '');
    // Strip markdown table pipes
    t = t.replace(/\\|/g, ' ');
    // Collapse newlines and whitespace into single spaces
    t = t.replace(/\\n+/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length > maxLen) t = t.slice(0, maxLen) + '\\u2026';
    return t;
}

function _extractLastText(jsonLines, maxLen) {
    for (let i = jsonLines.length - 1; i >= 0; i--) {
        try {
            const obj = JSON.parse(jsonLines[i]);
            if ((obj.type === 'user' || obj.type === 'assistant') && obj.message?.role) {
                const content = obj.message.content;
                let raw = '';
                if (typeof content === 'string') { raw = content; }
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block?.type === 'text' && block.text) { raw = block.text; break; }
                    }
                }
                if (!raw) continue;
                // Skip system/meta content before cleaning
                const firstLine = raw.split('\\n')[0].trim();
                if (/^\\/(clear|compact|help|init|sessions|switch)/.test(firstLine)) continue;
                if (/^\\[.*\\d{4}-\\d{2}-\\d{2}/.test(firstLine) || /^\\[.*GMT/.test(firstLine)) continue;
                if (/^Caveat:|^<system-reminder>|^<command-|^<local-command/.test(firstLine)) continue;
                const cleaned = _cleanPreview(raw, maxLen);
                if (!cleaned) continue;
                return cleaned;
            }
        } catch { continue; }
    }
    return '';
}

function _getSessionPreviewFromFile(jsonlPath, maxLen = 45) {
    try {
        if (!_existsSync(jsonlPath)) return '';
        const fs = require('node:fs');
        const fd = fs.openSync(jsonlPath, 'r');
        const size = fs.fstatSync(fd).size;
        // Read tail (last 64KB) for most recent message
        const tailSize = Math.min(size, 65536);
        const tailBuf = Buffer.alloc(tailSize);
        fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, size - tailSize));
        const tailLines = tailBuf.toString('utf-8').trimEnd().split('\\n');
        let result = _extractLastText(tailLines, maxLen);
        if (!result && size > tailSize) {
            // Fallback: read head (first 16KB) for the initial message
            const headSize = Math.min(size, 16384);
            const headBuf = Buffer.alloc(headSize);
            fs.readSync(fd, headBuf, 0, headSize, 0);
            const headLines = headBuf.toString('utf-8').trimEnd().split('\\n');
            result = _extractLastText(headLines.reverse(), maxLen);
        }
        fs.closeSync(fd);
        return result;
    } catch { }
    return '';
}

function _scanAllSessions(boundSdkIds, limit = 20) {
    const projectsRoot = _join(_homedir(), '.claude', 'projects');
    if (!_existsSync(projectsRoot)) return [];
    const results = [];
    try {
        const projectDirs = _readdirSync(projectsRoot, { withFileTypes: true })
            .filter(d => d.isDirectory());
        for (const pd of projectDirs) {
            const pdPath = _join(projectsRoot, pd.name);
            let entries;
            try { entries = _readdirSync(pdPath, { withFileTypes: true }); } catch { continue; }
            for (const f of entries) {
                if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
                const sessionId = f.name.replace('.jsonl', '');
                if (boundSdkIds.has(sessionId)) continue; // already in IM bindings
                const fullPath = _join(pdPath, f.name);
                try {
                    const st = _statSync(fullPath);
                    results.push({
                        sdkSessionId: sessionId,
                        projectDir: pd.name,
                        filePath: fullPath,
                        mtime: st.mtimeMs,
                        source: 'terminal'
                    });
                } catch { continue; }
            }
        }
    } catch { }
    // Sort by mtime desc and take top N
    results.sort((a, b) => b.mtime - a.mtime);
    return results.slice(0, limit);
}
`;

// Insert after the validators import line
const ANCHOR_IMPORT = "from './security/validators.js';";
const importIdx = code.indexOf(ANCHOR_IMPORT);
if (importIdx === -1) {
  console.error('[patch-sessions-preview] Could not find anchor import. Bridge manager format may have changed.');
  process.exit(1);
}
const insertPos = importIdx + ANCHOR_IMPORT.length;
code = code.slice(0, insertPos) + '\n' + HELPERS + code.slice(insertPos);

// ── 2. Replace the /sessions case ──
const OLD_SESSIONS = `case '/sessions': {
            const bindings = router.listBindings(adapter.channelType);
            if (bindings.length === 0) {
                response = 'No sessions found.';
            }
            else {
                const lines = ['<b>Sessions:</b>', ''];
                for (const b of bindings.slice(0, 10)) {
                    const active = b.active ? 'active' : 'inactive';
                    lines.push(\`<code>\${b.codepilotSessionId.slice(0, 8)}...</code> [\${active}] \${escapeHtml(b.workingDirectory || '~')}\`);
                }
                response = lines.join('\\n');
            }
            break;
        }`;

const NEW_SESSIONS = `case '/sessions': {
            const bindings = router.listBindings(adapter.channelType);
            const currentBinding = router.resolve(msg.address);

            // Collect IM-bound sessions with mtime from JSONL
            const boundSdkIds = new Set();
            const allEntries = [];
            for (const b of bindings) {
                if (b.sdkSessionId) boundSdkIds.add(b.sdkSessionId);
                let mtime = 0;
                if (b.sdkSessionId) {
                    try {
                        const pDir = (b.workingDirectory || '~').replace(/[^a-zA-Z0-9.]/g, '-');
                        const jp = require('node:path').join(require('node:os').homedir(), '.claude', 'projects', pDir, b.sdkSessionId + '.jsonl');
                        mtime = require('node:fs').statSync(jp).mtimeMs;
                    } catch {}
                }
                if (!mtime && b.updatedAt) mtime = new Date(b.updatedAt).getTime();
                if (!mtime && b.createdAt) mtime = new Date(b.createdAt).getTime();
                allEntries.push({ type: 'im', binding: b, mtime });
            }

            // Scan terminal sessions (exclude already-bound ones)
            const termSessions = _scanAllSessions(boundSdkIds, 20);
            for (const ts of termSessions) {
                allEntries.push({ type: 'terminal', ...ts });
            }

            // Sort all by mtime desc
            allEntries.sort((a, b) => b.mtime - a.mtime);
            const shown = allEntries.slice(0, 15);

            if (shown.length === 0) {
                response = 'No sessions found.';
            } else {
                const lines = ['<b>Sessions:</b>', ''];
                for (let i = 0; i < shown.length; i++) {
                    const e = shown[i];
                    if (e.type === 'im') {
                        const b = e.binding;
                        const isCurrent = currentBinding && b.codepilotSessionId === currentBinding.codepilotSessionId;
                        const marker = isCurrent ? ' \\u25C0' : '';
                        const id = (b.sdkSessionId || b.codepilotSessionId).slice(0, 8);
                        const pDir = (b.workingDirectory || '~').replace(/[^a-zA-Z0-9.]/g, '-');
                        const jp = require('node:path').join(require('node:os').homedir(), '.claude', 'projects', pDir, (b.sdkSessionId || '') + '.jsonl');
                        const preview = _getSessionPreviewFromFile(jp);
                        const previewLine = preview ? \`\\n    \\uD83D\\uDCAC \${escapeHtml(preview)}\` : '';
                        lines.push(\`<b>\${i + 1}.</b> <code>\${id}</code> [IM]\${marker}\${previewLine}\`);
                    } else {
                        const id = e.sdkSessionId.slice(0, 8);
                        const preview = _getSessionPreviewFromFile(e.filePath);
                        const previewLine = preview ? \`\\n    \\uD83D\\uDCAC \${escapeHtml(preview)}\` : '';
                        lines.push(\`<b>\${i + 1}.</b> <code>\${id}</code> [CLI]\${previewLine}\`);
                    }
                }
                lines.push('');
                lines.push('/switch &lt;n&gt; to switch (IM sessions only)');
                response = lines.join('\\n');
            }
            break;
        }`;

if (!code.includes(OLD_SESSIONS)) {
  if (code.includes('_scanAllSessions')) {
    console.log('[patch-sessions-preview] /sessions handler already patched.');
  } else {
    console.error('[patch-sessions-preview] Could not find /sessions handler to replace. Format may have changed.');
    process.exit(1);
  }
} else {
  code = code.replace(OLD_SESSIONS, NEW_SESSIONS);
}

writeFileSync(TARGET, code, 'utf-8');
console.log('[patch-sessions-preview] Patched successfully.');
