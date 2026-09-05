#!/bin/zsh
#
# Builds "Rotary Senders.app" into ~/Applications and starts it at login, so
# both senders are always listening and the Invite page is the only thing that
# has to be touched.
#
# Run it again after changing run-senders.sh - it rebuilds in place and keeps
# the permissions macOS has already granted, because those follow the path.
#
set -e
HERE=${0:A:h}
APP="$HOME/Applications/Rotary Senders.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/run-senders.sh" "$APP/Contents/Resources/run-senders.sh"
chmod +x "$APP/Contents/Resources/run-senders.sh"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# The executable must be a real program, not the script - see launcher.swift.
swiftc -O -o "$APP/Contents/MacOS/run-senders" "$HERE/launcher.swift"
codesign --force --sign - "$APP" >/dev/null

# macOS caches the bundle; touching it makes the new Info.plist take.
touch "$APP"

/usr/bin/osascript >/dev/null <<AS
tell application "System Events"
  if not (exists login item "Rotary Senders") then
    make login item at end with properties {path:"$APP", hidden:true, name:"Rotary Senders"}
  end if
end tell
AS

echo "installed: $APP"
echo "it starts at login, and now."
open "$APP"
