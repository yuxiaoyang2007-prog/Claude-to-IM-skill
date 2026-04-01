#!/usr/bin/env bash
# Patch bridge-manager to add /restart in-chat command.
# Run after npm install/update, then rebuild: npm run build
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$SKILL_DIR/node_modules/claude-to-im/dist/lib/bridge/bridge-manager.js"

if grep -q 'Restarting bridge' "$TARGET" 2>/dev/null; then
  echo "Already patched: $TARGET"
  exit 0
fi

python3 - "$TARGET" << 'PYEOF'
import sys

target = sys.argv[1]
with open(target, 'r') as f:
    content = f.read()

# ── 1. Add /restart case before /help ──────────────────────────────────────
OLD_HELP_CASE = "        case '/help':\n            response = ["
NEW_RESTART_CASE = """\
        case '/restart': {
            // Graceful restart: reply first, then exit so launchd restarts the daemon.
            await deliver(adapter, {
                address: msg.address,
                text: 'Restarting bridge...',
                parseMode: 'plain',
                replyToMessageId: msg.messageId,
            });
            setTimeout(() => process.exit(0), 500);
            return;
        }
        case '/help':
            response = ["""

if OLD_HELP_CASE not in content:
    print("ERROR: Could not find '/help' case anchor. bridge-manager.js may have changed.", file=sys.stderr)
    sys.exit(1)
content = content.replace(OLD_HELP_CASE, NEW_RESTART_CASE, 1)

# ── 2. Add /restart to /start command list ─────────────────────────────────
OLD_START_HELP_LINE = "                '/help - Show this help',\n            ].join('\\n');\n            break;\n        case '/new':"
NEW_START_HELP_LINE = "                '/restart - Restart the bridge daemon',\n                '/help - Show this help',\n            ].join('\\n');\n            break;\n        case '/new':"

if OLD_START_HELP_LINE not in content:
    print("WARNING: Could not update /start command list (anchor not found). Skipping.", file=sys.stderr)
else:
    content = content.replace(OLD_START_HELP_LINE, NEW_START_HELP_LINE, 1)

# ── 3. Add /restart to /help command list ──────────────────────────────────
OLD_HELP_HELP_LINE = "                '/help - Show this help',\n            ].join('\\n');\n            break;\n        default:"
NEW_HELP_HELP_LINE = "                '/restart - Restart the bridge daemon',\n                '/help - Show this help',\n            ].join('\\n');\n            break;\n        default:"

if OLD_HELP_HELP_LINE not in content:
    print("WARNING: Could not update /help command list (anchor not found). Skipping.", file=sys.stderr)
else:
    content = content.replace(OLD_HELP_HELP_LINE, NEW_HELP_HELP_LINE, 1)

with open(target, 'w') as f:
    f.write(content)

print("Patched successfully.")
PYEOF

echo "Now rebuild: cd '$SKILL_DIR' && npm run build"
