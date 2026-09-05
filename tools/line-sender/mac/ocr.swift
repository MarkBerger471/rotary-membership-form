import Foundation
import Vision
import AppKit

// Reads the text off a screenshot with Vision, one line per observation:
//   x<TAB>y<TAB>w<TAB>h<TAB>text
// The box is normalised (0-1) with the origin at the TOP-left, which is what a
// screen coordinate wants - Vision itself reports bottom-left.
let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!); exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.recognitionLanguages = ["en-US", "de-DE", "th-TH"]
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
let obs = (req.results ?? []).compactMap { o -> (CGRect, String)? in
  guard let t = o.topCandidates(1).first else { return nil }
  return (o.boundingBox, t.string)
}
for (b, s) in obs.sorted(by: { $0.0.origin.y > $1.0.origin.y }) {
  print(String(format: "%.4f\t%.4f\t%.4f\t%.4f\t%@",
               b.origin.x, 1 - b.origin.y - b.height, b.width, b.height, s))
}
