# LINE sender

Delivers the invites queued on `/admin/invite` with **LINE** chosen as the
channel, through the LINE app on Mark's Mac. The WhatsApp half of the queue is
delivered by `../whatsapp-sender`; neither one touches the other's messages.

```
cd tools/line-sender
ADMIN_PASSWORD=... npm run dry     # print what would go out, send nothing
ADMIN_PASSWORD=... npm run once    # send what is queued, then stop
ADMIN_PASSWORD=... npm start       # stay open and send as things are queued
```

## Before the first run

1. **LINE** installed, logged in, and its window open on the desktop.
2. Two permissions, both granted to the **terminal app** you run this in
   (System Settings → Privacy & Security):
   - **Accessibility** — to bring LINE forward and read its window.
   - **Screen Recording** — to read the screen. macOS only applies this after
     the terminal is quit and reopened.
3. **Xcode command line tools** (`xcode-select --install`) — the two small Swift
   helpers in `mac/` are built into `bin/` on the first run.

While it runs it owns the keyboard and the mouse. Leave the machine alone.

## Why it is built this way

LINE has no linked-device protocol for a personal account, so nothing here talks
to LINE's servers - it drives the app, which to LINE is Mark typing. The cost is
that the app tells us nothing back: its accessibility tree has the search box and
nothing else - no chat title, no message box, no readable rows.

So it reads the app off the screen, and refuses to type until it is sure:

| Check | If it fails |
| --- | --- |
| LINE is the front application | the run stops - a click would land in another window |
| exactly one chat under "Chats" is named exactly the guest's LINE name | that guest is skipped |
| the chat that opened is titled with that name | that guest is skipped, nothing typed |
| the message box is empty | that guest is skipped - a draft of Mark's is left alone |
| the message box is empty again after Enter | reported as not sent |

On WhatsApp the number is checked against the account itself. Here the only proof
of who is on the other side is the name on the screen, so all of these fail
closed: no message is better than a personal invitation to a stranger.

**The LINE name on the guest record must match the chat title exactly** - it is
what the sender searches for and what it checks against. Set it on
`/admin/guests`.

## What it is not

It is driving a user interface, so it is more fragile than the WhatsApp sender:
a LINE update that moves the search box or renames "Enter a message" breaks it,
and the Mac has to be awake with LINE in front. When it breaks it stops; it does
not carry on guessing.
