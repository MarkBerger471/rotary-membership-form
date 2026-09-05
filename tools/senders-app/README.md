# Rotary Senders.app

Keeps both invite senders running in the background, so `/admin/invite` is the
only thing that has to be touched: pick WhatsApp or LINE, press send, and the
message goes out. Nothing to start in a terminal.

```
./install.sh          # build into ~/Applications, start at login, and start now
```

## The one manual step

macOS grants Accessibility and Screen Recording **per application**, and the
LINE sender needs both - it clicks in the LINE app and reads its window off the
screen. After the first install, tick **Rotary Senders** in both of:

- System Settings → Privacy & Security → **Accessibility**
- System Settings → Privacy & Security → **Screen Recording**

If it is not listed, add it with **+** and pick `~/Applications/Rotary
Senders.app`. Then quit and reopen it (`open -a "Rotary Senders"`) - Screen
Recording only takes effect on a restart.

This is also why the senders are an app bundle rather than a launchd job: a
bare process started by launchd is granted neither, and the LINE sender could
then neither click nor read the screen. That was measured, not assumed.

## The password

The admin password lives in the login keychain, not in this repo and not in a
plist:

```
security add-generic-password -a rotary -s rotary-admin -w '<password>' -U -A
```

Both senders read it from there, so `npm run once` works without typing it too.

## Watching it work

```
tail -f ~/Library/Logs/rotary-line.log        # what the LINE sender is doing
tail -f ~/Library/Logs/rotary-whatsapp.log    # and WhatsApp
tail -f ~/Library/Logs/rotary-senders.log     # starts, stops and restarts
```

Each sender is restarted if it stops - including the deliberate stop each one
makes when its own code changes on disk, which is how an edit takes effect
without anyone having to remember.

## Stopping it

```
osascript -e 'tell application "System Events" to delete login item "Rotary Senders"'
pkill -f "Rotary Senders"
```
