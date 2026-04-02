#!/bin/bash
#
# Initialize standardized agent directory structure
# Usage: ./agent-structure.sh /path/to/agent-repo agent-name
#

set -e

AGENT_DIR="${1:?Usage: $0 /path/to/agent-repo agent-name}"
AGENT_NAME="${2:?Usage: $0 /path/to/agent-repo agent-name}"

echo "Initializing agent structure for: $AGENT_NAME"
echo "Directory: $AGENT_DIR"

# Create directory structure
mkdir -p "$AGENT_DIR"/{memory,tasks/{queue,active,completed,blocked},sessions,outputs}

# Create HEARTBEAT.md if it doesn't exist
if [ ! -f "$AGENT_DIR/HEARTBEAT.md" ]; then
  cat > "$AGENT_DIR/HEARTBEAT.md" << 'EOF'
# HEARTBEAT

This file is your consciousness checkpoint. Read it every awakening cycle.

## Pending Tasks

<!-- Tasks that need your attention. Remove when done. -->

## Alerts

<!-- Time-sensitive items. Clear after addressing. -->

## Notes

<!-- Anything you want to remember between cycles. -->
EOF
  echo "Created HEARTBEAT.md"
fi

# Create state.json if it doesn't exist
if [ ! -f "$AGENT_DIR/state.json" ]; then
  cat > "$AGENT_DIR/state.json" << EOF
{
  "agentId": "$AGENT_NAME",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "lastAwakeTime": null,
  "messagesThisHour": 0,
  "messagesToday": 0,
  "lastMessageTime": null,
  "lastHumanMessageTime": null,
  "dateKey": "$(date +%Y-%m-%d)",
  "hourKey": "$(date +%Y-%m-%dT%H)"
}
EOF
  echo "Created state.json"
fi

# Create memory/identity.json (never deleted)
if [ ! -f "$AGENT_DIR/memory/identity.json" ]; then
  cat > "$AGENT_DIR/memory/identity.json" << EOF
{
  "name": "$AGENT_NAME",
  "purpose": "Define your core purpose here",
  "values": [],
  "constraints": [],
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  echo "Created memory/identity.json"
fi

# Create memory/goals.json
if [ ! -f "$AGENT_DIR/memory/goals.json" ]; then
  cat > "$AGENT_DIR/memory/goals.json" << 'EOF'
{
  "activeGoals": [],
  "completedGoals": [],
  "updatedAt": null
}
EOF
  echo "Created memory/goals.json"
fi

# Create memory/context.json (prunable)
if [ ! -f "$AGENT_DIR/memory/context.json" ]; then
  cat > "$AGENT_DIR/memory/context.json" << 'EOF'
{
  "recentTopics": [],
  "pendingThoughts": [],
  "lastInteractions": []
}
EOF
  echo "Created memory/context.json"
fi

# Create .gitkeep files for empty directories
touch "$AGENT_DIR/tasks/queue/.gitkeep"
touch "$AGENT_DIR/tasks/active/.gitkeep"
touch "$AGENT_DIR/tasks/completed/.gitkeep"
touch "$AGENT_DIR/tasks/blocked/.gitkeep"
touch "$AGENT_DIR/sessions/.gitkeep"
touch "$AGENT_DIR/outputs/.gitkeep"

echo ""
echo "Agent structure initialized:"
echo ""
find "$AGENT_DIR" -type f | sort
echo ""
echo "Done!"
