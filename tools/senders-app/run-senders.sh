#!/bin/zsh
#
# Keeps both invite senders running, so the Invite page is the only thing Mark
# has to touch: pick WhatsApp or LINE, press send, and the message goes.
#
# This is the executable inside "Rotary Senders.app". It has to be an app
# bundle rather than a launchd job: macOS grants Accessibility and Screen
# Recording to an application, and a bare process started by launchd is granted
# neither - the LINE sender could then neither click nor read the screen.
#
# Both senders are restarted if they stop, including the deliberate stop each
# one makes when its own code changes on disk. That is what makes an edit take
# effect on its own instead of waiting for someone to remember.
#
NODE=/opt/homebrew/bin/node
ROOT=/Users/markberger/Projects/Rotary/tools
LOGS=$HOME/Library/Logs
SUP=$LOGS/rotary-senders.log

exec >>$SUP 2>&1
say() { print -r -- "[$(date '+%d %b %H:%M:%S')] $*" }

notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1
}

# The admin password lives in the login keychain, not in this file and not in a
# plist. Put it there once with:
#   security add-generic-password -a rotary -s rotary-admin -w '<password>' -U -A
PW=$(/usr/bin/security find-generic-password -s rotary-admin -w 2>/dev/null)
if [[ -z "$PW" ]]; then
  say "no admin password in the keychain - nothing can be sent"
  notify "Rotary senders" "No admin password in the keychain. See tools/senders-app/README.md."
  exit 1
fi

keep_running() {   # name  directory  logfile
  local name=$1 dir=$2 log=$3
  while true; do
    say "starting the $name sender"
    (cd "$dir" && ADMIN_PASSWORD="$PW" "$NODE" send.js --watch >>"$log" 2>&1)
    say "the $name sender stopped (exit $?), starting it again in 20s"
    sleep 20
  done
}

say "----- Rotary senders up (pid $$) -----"
keep_running whatsapp "$ROOT/whatsapp-sender" "$LOGS/rotary-whatsapp.log" &
keep_running line     "$ROOT/line-sender"     "$LOGS/rotary-line.log" &
wait
