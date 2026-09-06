# LINE sender

Delivers what is queued for **LINE** through the LINE app on Mark's Mac. The
WhatsApp half is delivered by `../whatsapp-sender`; neither one touches the
other's messages.

Two things are queued for it:

- **Meeting invitations**, from `/admin/invite` with LINE chosen as the channel.
- **Board votes**, from `/admin/membership` - whenever an application arrives
  and a board member has LINE ticked on the Recipients tab. The message carries
  the same Approve and Reject links as the email, so a vote cast from LINE lands
  in the application log exactly as one cast from the email does.

Board votes go out first: an application has a fourteen-day clock on it, an
invitation does not.

```
cd tools/line-sender
ADMIN_PASSWORD=... npm run dry     # print what would go out, send nothing
ADMIN_PASSWORD=... npm run once    # send what is queued, then stop
ADMIN_PASSWORD=... npm start       # stay open and send as things are queued

npm run find -- "Andy"             # would this LINE name find one chat, and only one?
```

`npm run find` does everything a send does up to the moment before it opens the
chat, and sends nothing. Worth running on a name you have just typed in: a name
that matches nothing, or matches two chats, is the one thing that stops a guest
being reachable.

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
| the whole "Chats" section can be read - expanding "See more" and scrolling as needed | that guest is skipped |
| exactly one chat in it is named exactly the guest's LINE name | that guest is skipped |
| the chat that opened is titled with that name | that guest is skipped, nothing typed |
| the message box is empty | that guest is skipped - a draft of Mark's is left alone |
| the message box is empty again after Enter | reported as not sent |

On WhatsApp the number is checked against the account itself. Here the only proof
of who is on the other side is the name on the screen, so all of these fail
closed: no message is better than a personal invitation to a stranger.

**The LINE name on the guest record must match the chat title exactly** - it is
what the sender searches for and what it checks against. Set it on
`/admin/guests`, and check it with `npm run find`.

## The chat list is longer than the window

LINE answers a search with the first five chats and hides the rest behind
"See more", and even expanded the list scrolls. So one screen is never the
answer: the sender reads a screen, expands or scrolls, and reads again, until
it reaches the "Messages" section or the list stops moving. Only then does it
decide, because a second chat with the same name three screens further down is
exactly the thing that must not be missed.

Two rows are told apart by the line or two underneath them - the last message
and when it was sent - so reading the same row twice while scrolling is not
mistaken for two chats with one name.

The title above the chat is read word by word, because LINE puts the contact's
picture in front of the name and an "open in a new window" icon behind it, and
OCR reads that icon as a different letter almost every time. The name has to be
the title exactly, either with that last word or without it - which is why a
chat called "Andy S" is never accepted for a guest called "Andy".

Expanding "See more" can incidentally open whichever chat re-draws under the
pointer. That marks it read, and nothing else: no chat is ever typed into until
its title has been checked.

## When it will not start

It stops with a plain sentence rather than a stack trace, and none of these
lose a queued message - they all leave it to go out later:

| It says | What to do |
| --- | --- |
| LINE is logged out | log in on the LINE app - a full quit signs it out |
| LINE is not running | open it |
| LINE is running but has no window open | click LINE in the Dock |
| LINE will not come to the front | leave the Mac alone for a moment |
| LINE's window cannot be read off the screen | give the terminal Screen Recording, then quit and reopen it |

`npm start` treats all of these as "try again in a minute" and keeps watching.
It does not need a chat to be open, or LINE to be in front, when you start it -
it brings LINE forward itself when there is something to send.

## What it is not

It is driving a user interface, so it is more fragile than the WhatsApp sender:
a LINE update that moves the search box or renames "Enter a message" breaks it,
and the Mac has to be awake with LINE in front. When it breaks it stops; it does
not carry on guessing.
