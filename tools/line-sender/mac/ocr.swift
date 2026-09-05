import Foundation
import Vision
import AppKit

// Reads the text off a screenshot with Vision.
//
//   ocr FILE            one line per line of text:  x y w h text
//   ocr FILE --words    one line per word:          line x y w h text
//
// Boxes are normalised (0-1) with the origin at the TOP-left, which is what a
// screen coordinate wants - Vision itself reports bottom-left.
//
// The word mode exists for one job: LINE draws a small "open in a new window"
// icon just after the chat title, and Vision reads it as a stray letter on the
// end of the name - "Keep Memo L" one time, "Keep Memo E" the next. Which
// letter it guesses cannot be relied on, but the gap in front of it can: it is
// far wider than the space between two words. Words with their own boxes are
// what makes that measurable.
let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!); exit(1)
}
let wordMode = args.contains("--words")

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.recognitionLanguages = ["en-US", "de-DE", "th-TH"]
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])

let observations = (req.results ?? []).sorted { $0.boundingBox.origin.y > $1.boundingBox.origin.y }

func top(_ b: CGRect) -> Double { Double(1 - b.origin.y - b.height) }

for (index, obs) in observations.enumerated() {
  guard let candidate = obs.topCandidates(1).first else { continue }
  let text = candidate.string
  if !wordMode {
    let b = obs.boundingBox
    print(String(format: "%.4f\t%.4f\t%.4f\t%.4f\t%@",
                 Double(b.origin.x), top(b), Double(b.width), Double(b.height), text))
    continue
  }
  // Walk the recognised string word by word and ask Vision where each one sits.
  var cursor = text.startIndex
  while cursor < text.endIndex {
    guard let wordStart = text[cursor...].firstIndex(where: { !$0.isWhitespace }) else { break }
    let wordEnd = text[wordStart...].firstIndex(where: { $0.isWhitespace }) ?? text.endIndex
    let word = String(text[wordStart..<wordEnd])
    if let box = try? candidate.boundingBox(for: wordStart..<wordEnd)?.boundingBox {
      print(String(format: "%d\t%.4f\t%.4f\t%.4f\t%.4f\t%@",
                   index, Double(box.origin.x), top(box), Double(box.width), Double(box.height), word))
    }
    cursor = wordEnd
  }
}
