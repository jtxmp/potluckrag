#!/usr/bin/env bash
# Plays the README demo in tmux. Recorded by demo/demo.tape (vhs); can also be
# run by hand from the repo root to watch it live.
#
# Left: alice, on this machine's network. She shares a release runbook.
# Right: bob, in a simulated separate network (scripts/simnet.sh). He shares
# onboarding notes and asks a question only alice's runbook can answer.
# The small top panes run `potluckrag share` and show its log; the bottom
# panes are each member's shell.
#
# Needs Linux, tmux, pasta, and Ollama on 127.0.0.1:11434 with
# nomic-embed-text:v1.5 and llama3.2:3b. Identities, team file and indexes are
# throwaway, created under a temp directory used as each member's HOME.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d /tmp/potluckrag-demo.XXXXXX)
mkdir -p "$W/alice" "$W/bob"
cp -r "$REPO/demo/notes/alice" "$W/alice/notes"
cp -r "$REPO/demo/notes/bob" "$W/bob/notes"
OUTER="tmux -S $W/outer.sock"
INNER="tmux -S $W/inner.sock"
A1=demo:0.0 A2=demo:0.1 B1=b:0.0 B2=b:0.1

# Runs however the script ends, including when vhs closes the terminal.
cleanup () {
  set +e
  [ -n "${PLAYER:-}" ] && kill "$PLAYER" 2>/dev/null
  $INNER kill-server 2>/dev/null
  $OUTER kill-server 2>/dev/null
  rm -rf "$W"
}
trap cleanup EXIT HUP INT TERM

cat > "$W/tmux.conf" <<'EOF'
set -g status off
set -g pane-border-status top
set -g pane-border-format ' #{pane_title} '
set -g pane-border-style fg=colour244
set -g pane-active-border-style fg=colour244
set -g default-terminal screen-256color
EOF

# `share` logs to stderr with ISO timestamps; the demo shortens them to the
# time of day so lines fit the small pane. Nothing else is changed.
for who in alice bob; do
  cat > "$W/$who.rc" <<EOF
export HOME=$W/$who NODE_OPTIONS=--no-warnings
cd $W/$who
PS1='\[\e[1;36m\]$who \$\[\e[0m\] '
potluckrag () {
  if [ "\$1" = share ]; then
    node $REPO/bin/potluckrag.js "\$@" 2>&1 | sed -uE 's/^[0-9-]+T([0-9:]+)\.[0-9]+Z /\1 /'
  else
    node $REPO/bin/potluckrag.js "\$@"
  fi
}
EOF
done

# Each member has their own identity; alice made the team and sent bob team.json.
KEY_B=$(HOME=$W/bob NODE_OPTIONS=--no-warnings node "$REPO/bin/potluckrag.js" id 2>/dev/null)
(
  cd "$W/alice"
  export HOME=$W/alice NODE_OPTIONS=--no-warnings
  node "$REPO/bin/potluckrag.js" team init docs --member alice
  node "$REPO/bin/potluckrag.js" team add bob "$KEY_B"
) >/dev/null 2>&1
cp "$W/alice/team.json" "$W/bob/team.json"

$OUTER -f "$W/tmux.conf" new-session -d -s demo -x 180 -y 46 "bash --rcfile $W/alice.rc"
$OUTER select-pane -t $A1 -T 'alice · potluckrag share (log)'
$OUTER split-window -h -t $A1 \
  "$REPO/scripts/simnet.sh --profile hotspot -- tmux -S $W/inner.sock -f $W/tmux.conf new-session -s b 'bash --rcfile $W/bob.rc' 2>/dev/null"
$OUTER select-pane -t demo:0.1 -T 'bob · simulated separate network: own NAT, +80 ms, 1% loss'
$OUTER split-window -v -t $A1 "bash --rcfile $W/alice.rc"
$OUTER select-pane -t $A2 -T 'alice · home network'

# type <tmux> <pane> <text>: types like a person, then presses Enter.
type () {
  local tm=$1 pane=$2 text=$3 i
  for ((i = 0; i < ${#text}; i++)); do $tm send-keys -t "$pane" -l "${text:i:1}"; sleep 0.025; done
  sleep 0.3
  $tm send-keys -t "$pane" Enter
}
# wait_for <tmux> <pane> <regex>
wait_for () {
  local i
  for i in $(seq 600); do
    $1 capture-pane -p -J -t "$2" | grep -qE "$3" && return 0
    sleep 0.2
  done
  echo "timed out waiting for /$3/ in $2" >&2
  return 1
}

play () {
  for i in $(seq 50); do [ -S "$W/inner.sock" ] && break; sleep 0.1; done
  sleep 0.5
  $INNER split-window -v -t $B1 "bash --rcfile $W/bob.rc"
  # Pane sizes are set after vhs attaches; attaching rescales the layout.
  $OUTER resize-pane -t $A1 -y 7
  $INNER resize-pane -t $B1 -y 6
  $INNER select-pane -t $B1 -T 'bob · potluckrag share (log)'
  $INNER select-pane -t $B2 -T 'bob · laptop'
  sleep 1.5

  type "$OUTER" $A2 'ls notes'
  sleep 0.8
  type "$INNER" $B2 'ls notes'
  sleep 1.2

  type "$OUTER" $A1 'potluckrag share notes --embed-model nomic-embed-text:v1.5'
  type "$INNER" $B1 'potluckrag share notes --embed-model nomic-embed-text:v1.5'
  wait_for "$INNER" $B1 'hello .*member=alice'
  sleep 1

  type "$INNER" $B2 'potluckrag ask "How do we roll back a release?" --chat-model llama3.2:3b -k 4'
  wait_for "$INNER" $B2 'other members? answered'
  sleep 4

  type "$OUTER" $A2 'potluckrag log    # what alice sent, to whom'
  wait_for "$OUTER" $A2 ' bob \('
  sleep 1
  type "$OUTER" $A2 '# bob received runbook passages. The file stays on alice'"'"'s machine'
  sleep 5
  $OUTER kill-server 2>/dev/null || true
}

play &
PLAYER=$!
$OUTER attach -t demo || true
