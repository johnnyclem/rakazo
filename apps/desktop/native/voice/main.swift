// System text to speech for reading a message aloud: rakazo-voice <language>. Text arrives as one
// JSON line {"text":"..."} on stdin, then "pause", "resume" or "stop"; stdout is one JSON event per line.

import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ event: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: event),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}

/// `end` is always the last event, so the page never waits on a helper that is gone.
func end(error: String? = nil) -> Never {
  if let error { emit(["type": "error", "error": error]) }
  emit(["type": "end"])
  exit(0)
}

func languageOf(_ identifier: String) -> String {
  identifier.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map {
    $0.lowercased()
  } ?? ""
}

/// Asks once; macOS remembers the answer. Older systems have no Personal Voice to ask for.
func personalVoiceAllowed(_ done: @escaping (Bool) -> Void) {
  guard #available(macOS 14.0, *) else { return done(false) }
  switch AVSpeechSynthesizer.personalVoiceAuthorizationStatus {
  case .authorized: done(true)
  case .notDetermined:
    AVSpeechSynthesizer.requestPersonalVoiceAuthorization { done($0 == .authorized) }
  default: done(false)
  }
}

func isPersonal(_ voice: AVSpeechSynthesisVoice) -> Bool {
  guard #available(macOS 14.0, *) else { return false }
  return voice.voiceTraits.contains(.isPersonalVoice)
}

func isSiri(_ voice: AVSpeechSynthesisVoice) -> Bool {
  (voice.identifier + voice.name).lowercased().contains("siri")
}

/// The user's own Personal Voice, else a Siri voice, else the system default, each in `language`.
func chooseVoice(language: String, personalAllowed: Bool) -> AVSpeechSynthesisVoice? {
  let voices = AVSpeechSynthesisVoice.speechVoices().filter { languageOf($0.language) == language }
  if personalAllowed, let personal = voices.first(where: isPersonal) { return personal }
  let siri = voices.filter { isSiri($0) && !isPersonal($0) }
    .max { $0.quality.rawValue < $1.quality.rawValue }
  return siri ?? AVSpeechSynthesisVoice(language: language)
}

final class Reader: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func speak(_ text: String, voice: AVSpeechSynthesisVoice?) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    synthesizer.speak(utterance)
  }

  func pause() { synthesizer.pauseSpeaking(at: .immediate) }
  func resume() { synthesizer.continueSpeaking() }
  func stop() {
    if !synthesizer.stopSpeaking(at: .immediate) { end() }
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
    emit(["type": "speaking"])
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didPause u: AVSpeechUtterance) {
    emit(["type": "paused"])
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didContinue u: AVSpeechUtterance) {
    emit(["type": "speaking"])
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { end() }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { end() }
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else { end(error: "language-not-supported") }
let language = languageOf(arguments[1])

let reader = Reader()
Thread.detachNewThread {
  while let line = readLine() {
    DispatchQueue.main.async {
      switch line {
      case "pause": reader.pause()
      case "resume": reader.resume()
      case "stop": reader.stop()
      default:
        guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let text = object["text"] as? String, !text.isEmpty
        else { end(error: "invalid-text") }
        personalVoiceAllowed { allowed in
          DispatchQueue.main.async {
            reader.speak(text, voice: chooseVoice(language: language, personalAllowed: allowed))
          }
        }
      }
    }
  }
  DispatchQueue.main.async { reader.stop() }
}
dispatchMain()
