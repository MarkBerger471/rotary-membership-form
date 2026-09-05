import Foundation

// The main executable of an app bundle has to be a real program: macOS refuses
// to launch one whose executable is a shell script (it fails with a bare
// LaunchServices error and no explanation). This is that program, and all it
// does is hand over to the script sitting beside it in Resources.
//
// The bundle matters because Accessibility and Screen Recording are granted to
// an *application*. Run the same script from a launchd job and it is granted
// neither, and the LINE sender can then neither click nor read the screen.

let exe = URL(fileURLWithPath: CommandLine.arguments[0])
let script = exe
  .deletingLastPathComponent()          // Contents/MacOS
  .deletingLastPathComponent()          // Contents
  .appendingPathComponent("Resources/run-senders.sh")
  .path

var args: [UnsafeMutablePointer<CChar>?] = [strdup("zsh"), strdup(script), nil]
execv("/bin/zsh", &args)

FileHandle.standardError.write("could not start \(script)\n".data(using: .utf8)!)
exit(1)
