// Arianna's helper for the notifications of macOS (D-128): a menu bar app
// with no Dock icon that reads the notices of the core on loopback
// (GET /api/notifications/stream) and shows them in the name of Arianna.
// A notice is a kind and a conversation id, never a title or a text: the
// sentences are fixed here, the same as the chat's (apps/hud/src/lib/notices.ts).
import AppKit
import UserNotifications

let sentences: [String: (title: String, body: String)] = [
  "reply": ("Arianna ha risposto", "Clicca per aprire la conversazione."),
  "approval": ("Arianna aspetta una tua decisione", "Clicca per vedere cosa approvare."),
  "failure": ("Un lavoro è fallito", "Clicca per vedere cosa è successo."),
  "reminder": ("Arianna ha un promemoria", "Clicca per aprire la segretaria."),
]

/** Only a lowercase UUID leads into the chat: anything else opens its home. */
func isConversationId(_ value: String) -> Bool {
  value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
}

/** The address of the core and of the chat, written by `pnpm notifier:build` from [server] of arianna.toml. */
func configuredURL(_ key: String) -> URL? {
  guard let text = Bundle.main.object(forInfoDictionaryKey: key) as? String, let url = URL(string: text) else { return nil }
  // Loopback only: the helper never talks to another machine.
  guard url.scheme == "http", ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "") else { return nil }
  return url
}

/** The stream of notices: events sent by the server, read as they come; reconnects after a pause. */
final class NoticeStream: NSObject, URLSessionDataDelegate {
  private let url: URL
  private let onNotice: (String, String?) -> Void
  private let onState: (String) -> Void
  /** Bytes until an event ends: a character is never cut between two pieces. */
  private var buffer = Data()
  /** Seconds before the next try: doubles up to a minute, back to 5 once connected. */
  private var delay: Double = 5
  private var session: URLSession?
  private var task: URLSessionDataTask?

  init(url: URL, onNotice: @escaping (String, String?) -> Void, onState: @escaping (String) -> Void) {
    self.url = url
    self.onNotice = onNotice
    self.onState = onState
  }

  func start() {
    let configuration = URLSessionConfiguration.ephemeral
    // The core sends a comment every 25 seconds: two minutes of silence is a dead connection.
    configuration.timeoutIntervalForRequest = 120
    configuration.timeoutIntervalForResource = .infinity
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    connect()
  }

  private func connect() {
    var request = URLRequest(url: url)
    request.setValue("1", forHTTPHeaderField: "x-arianna-helper")
    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
    buffer = Data()
    task = session?.dataTask(with: request)
    task?.resume()
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 200 { delay = 5 }
    onState(status == 200 ? "Collegata al core" : status == 429 ? "Troppi aiutanti collegati al core" : "Non collegata al core")
    completionHandler(status == 200 ? .allow : .cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    buffer.append(data)
    // A buffer that never ends an event is not a stream of the core.
    if buffer.count > 64 * 1024 {
      dataTask.cancel()
      return
    }
    let separator = Data("\n\n".utf8)
    while let end = buffer.range(of: separator) {
      let block = String(decoding: buffer.subdata(in: buffer.startIndex..<end.lowerBound), as: UTF8.self)
      buffer.removeSubrange(buffer.startIndex..<end.upperBound)
      handle(block)
    }
  }

  private func handle(_ block: String) {
    var event = ""
    var data = ""
    for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
      if line.hasPrefix("event: ") { event = String(line.dropFirst(7)) }
      if line.hasPrefix("data: ") { data = String(line.dropFirst(6)) }
    }
    guard event == "notice", let json = data.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
      let kind = object["kind"] as? String, sentences[kind] != nil
    else { return }
    let conversation = object["conversationId"] as? String
    onNotice(kind, conversation.flatMap { isConversationId($0) ? $0 : nil })
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if (task.response as? HTTPURLResponse)?.statusCode != 429 { onState("Non collegata al core") }
    // The core restarted or is off: try again in a while, a little later each time.
    let wait = delay
    delay = min(delay * 2, 60)
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
  }
}

final class Helper: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private var item: NSStatusItem?
  private let state = NSMenuItem(title: "Non collegata al core", action: nil, keyEquivalent: "")
  private var stream: NoticeStream?
  private var chat: URL?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.image = NSImage(systemSymbolName: "bell", accessibilityDescription: "Arianna")
    let menu = NSMenu()
    state.isEnabled = false
    menu.addItem(state)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Prova una notifica", action: #selector(trial), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Apri Arianna", action: #selector(openChat), keyEquivalent: ""))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Esci", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    for entry in menu.items where entry.action != nil && entry.action != #selector(NSApplication.terminate(_:)) { entry.target = self }
    item.menu = menu
    self.item = item

    guard let server = configuredURL("AriannaServer") else {
      state.title = "Indirizzo del core non valido: rifai pnpm notifier:build"
      return
    }
    chat = configuredURL("AriannaChat") ?? server
    stream = NoticeStream(
      url: server.appendingPathComponent("api/notifications/stream"),
      onNotice: { [weak self] kind, conversation in self?.show(kind: kind, conversation: conversation) },
      onState: { [weak self] text in self?.state.title = text })
    stream?.start()
  }

  private func address(of conversation: String?) -> URL? {
    guard let chat else { return nil }
    guard let conversation else { return chat }
    return chat.appendingPathComponent("c").appendingPathComponent(conversation)
  }

  func show(kind: String, conversation: String?) {
    guard let sentence = sentences[kind] else { return }
    let content = UNMutableNotificationContent()
    content.title = sentence.title
    content.body = sentence.body
    content.sound = .default
    if let url = address(of: conversation) { content.userInfo = ["url": url.absoluteString] }
    // The same kind about the same conversation replaces the one before, as in the chat.
    let request = UNNotificationRequest(identifier: "arianna-\(kind)-\(conversation ?? "home")", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }

  @objc func trial() { show(kind: "reply", conversation: nil) }

  @objc func openChat() {
    if let chat { NSWorkspace.shared.open(chat) }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    // Only an address this app wrote, on loopback, is opened.
    if let text = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: text),
      let chat, url.scheme == chat.scheme, url.host == chat.host, url.port == chat.port
    {
      NSWorkspace.shared.open(url)
    }
    completionHandler()
  }
}

let app = NSApplication.shared
let helper = Helper()
app.delegate = helper
app.setActivationPolicy(.accessory)
app.run()
