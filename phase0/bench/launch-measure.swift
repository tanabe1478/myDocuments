// Launches an app binary, then prints milliseconds until the process owns an on-screen
// window taller than 100px (CGWindowList; no Accessibility permission needed).
// Usage: launch-measure <binary> <timeoutSec> [args...]
// Output (one line, JSON): {"pid":N,"windowVisibleMs":X} or {"pid":N,"windowVisibleMs":null}
// The app is left running; the caller samples memory and kills it.
import Foundation
import CoreGraphics

let argv = CommandLine.arguments
guard argv.count >= 3 else { FileHandle.standardError.write("usage\n".data(using: .utf8)!); exit(2) }
let proc = Process()
proc.executableURL = URL(fileURLWithPath: argv[1])
proc.arguments = Array(argv.dropFirst(3))
proc.standardOutput = FileHandle.nullDevice
proc.standardError = FileHandle.nullDevice
let timeout = Double(argv[2]) ?? 30
let t0 = DispatchTime.now()
try proc.run()
let pid = proc.processIdentifier
var shown: Double? = nil
while Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e9 < timeout {
  if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
    for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
      if let b = w[kCGWindowBounds as String] as? [String: Any], let h = b["Height"] as? Double, h > 100 {
        shown = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
      }
    }
  }
  if shown != nil { break }
  usleep(2000)
}
print("{\"pid\":\(pid),\"windowVisibleMs\":\(shown.map { String(format: "%.1f", $0) } ?? "null")}")
fflush(stdout)
