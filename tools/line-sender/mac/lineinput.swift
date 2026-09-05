import Foundation
import AppKit
import CoreGraphics

// Clicks and keystrokes for the LINE desktop app.
//
// System Events' `keystroke` and `click` never reach LINE - it accepts them and
// does nothing. Real HID-level CGEvents do, which is what this posts. It is the
// only part of the sender that touches the machine like a person would, so it
// stays deliberately small: click, type, one key, and a permission check.

func click(_ x: Double, _ y: Double) {
  let p = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(120_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  // Held only briefly on purpose. LINE expands its "See more" on the press,
  // and with a long hold the release lands on whatever row has just been drawn
  // under the pointer - which opens that chat.
  usleep(20_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func typeText(_ s: String) {
  for ch in s {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    var u = Array(String(ch).utf16)
    e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
    e?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
    up?.post(tap: .cghidEventTap)
    usleep(12_000)
  }
}

// Wheel events go to whatever is under the pointer, so the pointer is moved
// onto the list first. Negative counts scroll the list downwards.
func scroll(_ x: Double, _ y: Double, _ clicks: Int32) {
  let p = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(120_000)
  let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: clicks, wheel2: 0, wheel3: 0)
  e?.post(tap: .cghidEventTap)
  usleep(120_000)
}

func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
  let d = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
  d?.flags = flags; d?.post(tap: .cghidEventTap)
  usleep(40_000)
  let u = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
  u?.flags = flags; u?.post(tap: .cghidEventTap)
}

let a = CommandLine.arguments
switch a.count > 1 ? a[1] : "" {
case "click":
  guard a.count > 3, let x = Double(a[2]), let y = Double(a[3]) else { exit(2) }
  click(x, y)
case "type":
  guard a.count > 2 else { exit(2) }
  typeText(a[2])
case "key":
  guard a.count > 2, let raw = UInt16(a[2]) else { exit(2) }
  var f: CGEventFlags = []
  if a.count > 3 && a[3].contains("cmd")   { f.insert(.maskCommand) }
  if a.count > 3 && a[3].contains("shift") { f.insert(.maskShift) }
  key(CGKeyCode(raw), f)
case "scroll":
  guard a.count > 4, let x = Double(a[2]), let y = Double(a[3]), let n = Int32(a[4]) else { exit(2) }
  scroll(x, y, n)
case "where":
  let p = NSEvent.mouseLocation
  // NSEvent is bottom-left based; everything else here is top-left.
  let h = (NSScreen.screens.first?.frame.height ?? 0)
  print(String(format: "%.0f %.0f", p.x, h - p.y))
case "trusted":
  print(AXIsProcessTrusted() ? "trusted" : "NOT trusted")
default:
  print("usage: lineinput click x y | type TEXT | key CODE [cmd,shift] | scroll x y CLICKS | where | trusted")
}
