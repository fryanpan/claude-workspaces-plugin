// The compiled relay: a Claude Code session's MCP child, in about 10 MB.
//
// It carries bytes between the session and the server's hosted connector at
// `/mcp` and does nothing else: each JSON-RPC line from stdin is POSTed there,
// the answer is written back, and every message on the session's GET stream is
// written to stdout. It is the twin of packages/mcp/src/relay/relay-core.ts,
// which states the rules both follow and why; relay-stdio.test.ts drives both
// through one suite. Change one, change the other.
//
// Never committed as a binary. bin/claude-workspaces-mcp.sh compiles this file
// on the machine it runs on, into a cache keyed by its hash, and runs the node
// relay whenever there is no working build.
//
// Built with `swiftc -O -swift-version 5 -parse-as-library`; macOS 12 or later
// (async URLSession).
import Foundation

let supportedVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]
let retryMaxSeconds = 15.0
let streamIdleSeconds = 45.0

let env = ProcessInfo.processInfo.environment

func present(_ v: String?) -> String? {
  guard let v, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
  return v
}

func log(_ s: String) {
  FileHandle.standardError.write(Data("[relay] \(s)\n".utf8))
}

/// One JSON-RPC message per line on stdout, never interleaved.
let outLock = NSLock()
func writeLine(_ data: Data) {
  var d = data
  while let last = d.last, last == 0x0A || last == 0x0D || last == 0x20 { d.removeLast() }
  if d.contains(0x0A), let obj = try? JSONSerialization.jsonObject(with: d),
    let compact = try? JSONSerialization.data(withJSONObject: obj)
  {
    d = compact
  }
  d.append(0x0A)
  outLock.lock()
  FileHandle.standardOutput.write(d)
  outLock.unlock()
}
func writeJSON(_ obj: Any) {
  if let d = try? JSONSerialization.data(withJSONObject: obj) { writeLine(d) }
}

/// Unreserved characters, the set encodeURIComponent leaves alone.
let unreserved = CharacterSet(
  charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

/// Whether every UTF-8 byte is printable ASCII. Read as bytes because String
/// comparison is canonical: a decomposed "ü" must stay decomposed.
func printableASCII(_ s: String) -> Bool { s.utf8.allSatisfy { $0 >= 0x20 && $0 <= 0x7E } }

/// The working directory's bytes, as getcwd(3) gives them and process.cwd()
/// reads them in the node relay.
func currentDirectory() -> String {
  guard let p = getcwd(nil, 0) else { return FileManager.default.currentDirectoryPath }
  defer { free(p) }
  return String(cString: p)
}

/// The headers connector/identity.ts reads, from the environment the stdio child read.
/// A header carries bytes: URLSession sends a value as Latin-1, folding a
/// decomposed "ü" and dropping what Latin-1 cannot hold. So when any value is
/// not printable ASCII, every value but the plugin root is percent-encoded as
/// UTF-8 under `x-cw-identity-encoding: percent`, as relay-wire.ts does.
func identityHeaders() -> [String: String] {
  var h = ["x-cw-cwd": currentDirectory()]
  if let a = present(env["CW_AGENT_NAME"]) { h["x-cw-agent"] = a }
  if let a = present(env["FEEDBACK_AGENT_NAME"]) { h["x-cw-agent-legacy"] = a }
  if let w = present(env["CW_WORKSPACE_ID"]) ?? present(env["FEEDBACK_WORKSPACE_ID"]) {
    h["x-cw-workspace"] = w.trimmingCharacters(in: .whitespaces)
  }
  if !h.values.allSatisfy(printableASCII) {
    for (k, v) in h { h[k] = v.addingPercentEncoding(withAllowedCharacters: unreserved) ?? v }
    h["x-cw-identity-encoding"] = "percent"
  }
  if let v = present(env["CW_RELAY_PLUGIN_VERSION"]) {
    h["x-cw-plugin-root"] = "/" + v.trimmingCharacters(in: .whitespaces)
  }
  return h
}

/// The server's base URL, resolved per request as http-client.ts does.
func baseURL() -> String? {
  if let o = present(env["CW_BASE_URL"]) ?? present(env["FEEDBACK_BASE_URL"]) {
    var s = o
    while s.hasSuffix("/") { s.removeLast() }
    return s
  }
  let home = env["HOME"] ?? NSHomeDirectory()
  for dir in ["claude-workspaces", "live-feedback"] {
    let path = "\(home)/.claude/\(dir)/server.json"
    guard FileManager.default.fileExists(atPath: path) else { continue }
    guard let d = FileManager.default.contents(atPath: path),
      let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
      let port = j["port"] as? Int, port > 0
    else { return nil }
    return "http://127.0.0.1:\(port)"
  }
  return nil
}

func parseObject(_ d: Data) -> [String: Any]? {
  (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}

func refusalText(_ status: Int, _ body: Data) -> String {
  let j = parseObject(body)
  let message = (j?["message"] as? String) ?? String(decoding: body.prefix(300), as: UTF8.self)
  let error = (j?["error"] as? String).map { " \($0)" } ?? ""
  return "the claude-workspaces server refused this session (\(status)\(error)): \(message)"
}

enum Posted {
  case answer(status: Int, body: Data, sid: String?)
  case unreachable(mayHaveRun: Bool)
}

func makeSession() -> URLSession {
  let cfg = URLSessionConfiguration.ephemeral
  cfg.timeoutIntervalForRequest = 3600
  cfg.timeoutIntervalForResource = 30 * 24 * 3600
  cfg.urlCache = nil
  cfg.httpCookieStorage = nil
  cfg.httpShouldSetCookies = false
  cfg.connectionProxyDictionary = [:]
  cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
  return URLSession(configuration: cfg)
}

actor Relay {
  let http = makeSession()
  let identity = identityHeaders()
  let named: Bool
  let version: String
  let initWait: Double

  var token: String?
  var sid: String?
  var initRequest: Data?
  var initAnswer = Data()
  var clientInitialized = false
  var lastReason = "the claude-workspaces server has not answered yet"
  var lastEventId: String?
  var streamGen = 0
  var streamTask: Task<Void, Never>?
  var opening: Task<Bool, Never>?
  var reconnecting = false
  var closed = false
  var toolCalls = 0
  var held: [Data] = []

  init() {
    named = identity["x-cw-agent"] != nil || identity["x-cw-agent-legacy"] != nil
    version = identity["x-cw-plugin-root"].map { String($0.dropFirst()) } ?? "0.0.0"
    initWait = Double(env["CW_RELAY_INIT_WAIT_MS"] ?? "").map { $0 / 1000 } ?? 10
  }

  func request(_ path: String, method: String, withSession: Bool) -> URLRequest? {
    guard let base = baseURL() else {
      lastReason = "no claude-workspaces server was found (no discovery file, no CW_BASE_URL)"
      return nil
    }
    guard let url = URL(string: base + path) else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.setValue("application/json, text/event-stream", forHTTPHeaderField: "accept")
    for (k, v) in identity { req.setValue(v, forHTTPHeaderField: k) }
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    if withSession, let sid { req.setValue(sid, forHTTPHeaderField: "mcp-session-id") }
    return req
  }

  func mint() async {
    guard named, token == nil, var req = request("/api/agent-token", method: "GET", withSession: false)
    else { return }
    req.setValue(nil, forHTTPHeaderField: "authorization")
    do {
      let (d, r) = try await http.data(for: req)
      let status = (r as? HTTPURLResponse)?.statusCode ?? 0
      if status == 200, let t = parseObject(d)?["token"] as? String, !t.isEmpty {
        token = t
      } else {
        lastReason = refusalText(status, d)
        log("agent token: \(lastReason)")
      }
    } catch {
      lastReason = "the claude-workspaces server is unreachable"
    }
  }

  func post(_ body: Data, withSession: Bool) async -> Posted {
    guard var req = request("/mcp", method: "POST", withSession: withSession) else {
      return .unreachable(mayHaveRun: false)
    }
    req.httpBody = body
    do {
      let (d, r) = try await http.data(for: req)
      let h = r as? HTTPURLResponse
      return .answer(
        status: h?.statusCode ?? 0, body: d, sid: h?.value(forHTTPHeaderField: "mcp-session-id"))
    } catch {
      lastReason = "the claude-workspaces server is unreachable"
      let code = (error as? URLError)?.code
      let neverSent = code == .cannotConnectToHost || code == .cannotFindHost
      return .unreachable(mayHaveRun: !neverSent)
    }
  }

  func stopStream() {
    streamGen += 1
    streamTask?.cancel()
    streamTask = nil
  }

  func dropSession() {
    sid = nil
    stopStream()
  }

  /// Initialize upstream with the client's own request. Single flight.
  func openUpstream() async -> Bool {
    if let opening { return await opening.value }
    let t = Task { await self.attemptOpen() }
    opening = t
    let ok = await t.value
    opening = nil
    return ok
  }

  func attemptOpen() async -> Bool {
    guard let initRequest else { return false }
    await mint()
    var r = await post(initRequest, withSession: false)
    if case .answer(let status, _, _) = r, status == 401 || status == 403, named {
      token = nil
      await mint()
      r = await post(initRequest, withSession: false)
    }
    guard case .answer(let status, let body, let newSid) = r else { return false }
    guard status == 200, let newSid else {
      lastReason = refusalText(status, body)
      return false
    }
    sid = newSid
    initAnswer = body
    if clientInitialized {
      _ = await post(
        Data(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.utf8), withSession: true)
      startStream()
    }
    return true
  }

  func reconnectInBackground() {
    if reconnecting || closed { return }
    reconnecting = true
    // Isolated to this actor, like every Task started inside it.
    Task {
      var delay = 1.0
      while !closed, sid == nil {
        try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
        delay = min(delay * 2, retryMaxSeconds)
        if await openUpstream() { announceConnected() }
      }
      reconnecting = false
    }
  }
  func announceConnected() {
    log("connected to the claude-workspaces server")
    if clientInitialized {
      writeJSON(["jsonrpc": "2.0", "method": "notifications/tools/list_changed"])
    }
  }

  func deliver(_ d: Data, gen: Int) {
    guard gen == streamGen else { return }
    if toolCalls > 0 { held.append(d) } else { writeLine(d) }
  }
  func setLastEventId(_ id: String, gen: Int) { if gen == streamGen { lastEventId = id } }
  func isCurrent(_ gen: Int) -> Bool { !closed && gen == streamGen && sid != nil }

  func startStream() {
    stopStream()
    let gen = streamGen
    streamTask = Task { await self.runStream(gen) }
  }

  func runStream(_ gen: Int) async {
    var delay = 1.0
    while isCurrent(gen), !Task.isCancelled {
      if var req = request("/mcp", method: "GET", withSession: true) {
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        if let lastEventId { req.setValue(lastEventId, forHTTPHeaderField: "last-event-id") }
        // Between bytes, not in total: the server writes `:ka` every 15s.
        req.timeoutInterval = streamIdleSeconds
        do {
          let (bytes, r) = try await http.bytes(for: req)
          let status = (r as? HTTPURLResponse)?.statusCode ?? 0
          if status == 200 {
            delay = 1.0
            try await readEvents(bytes, gen)
          } else if [400, 401, 403, 404].contains(status) {
            // The server no longer knows this session, or no longer takes this token.
            if status != 404 { token = nil }
            dropSession()
            if !(await openUpstream()) { reconnectInBackground() }
            return
          }
        } catch {
          // Cancelled, reset, idle past the window, or refused: redial below.
        }
      }
      if !isCurrent(gen) || Task.isCancelled { return }
      try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
      delay = min(delay * 2, retryMaxSeconds)
    }
  }

  func readEvents(_ bytes: URLSession.AsyncBytes, _ gen: Int) async throws {
    var line = [UInt8]()
    var data: [String] = []
    var id: String?
    for try await byte in bytes {
      if byte != 0x0A {
        line.append(byte)
        continue
      }
      if line.last == 0x0D { line.removeLast() }
      let text = String(decoding: line, as: UTF8.self)
      line.removeAll(keepingCapacity: true)
      if text.isEmpty {
        if let id { setLastEventId(id, gen: gen) }
        if !data.isEmpty { deliver(Data(data.joined(separator: "\n").utf8), gen: gen) }
        data = []
        id = nil
      } else if text.hasPrefix("data:") {
        var v = text.dropFirst(5)
        if v.first == " " { v = v.dropFirst() }
        data.append(String(v))
      } else if text.hasPrefix("id:") {
        id = text.dropFirst(3).trimmingCharacters(in: .whitespaces)
      }
      if !isCurrent(gen) { return }
    }
  }

  func unavailable(_ msg: [String: Any], _ reason: String) -> [String: Any] {
    let id = msg["id"] ?? NSNull()
    switch msg["method"] as? String {
    case "tools/list": return ["jsonrpc": "2.0", "id": id, "result": ["tools": []]]
    case "ping": return ["jsonrpc": "2.0", "id": id, "result": [String: Any]()]
    case "tools/call":
      let text = "claude-workspaces relay: \(reason). It keeps retrying; call the tool again shortly."
      return [
        "jsonrpc": "2.0", "id": id,
        "result": ["content": [["type": "text", "text": text]], "isError": true],
      ]
    default:
      return ["jsonrpc": "2.0", "id": id, "error": ["code": -32603, "message": reason]]
    }
  }

  func localInitialize(_ msg: [String: Any]) -> [String: Any] {
    let asked = (msg["params"] as? [String: Any])?["protocolVersion"] as? String
    let proto = asked.flatMap { supportedVersions.contains($0) ? $0 : nil } ?? supportedVersions[0]
    return [
      "jsonrpc": "2.0", "id": msg["id"] ?? NSNull(),
      "result": [
        "protocolVersion": proto,
        "capabilities": ["tools": ["listChanged": true], "experimental": ["claude/channel": [:]]],
        "serverInfo": ["name": "claude-workspaces", "version": version],
        "instructions":
          "The claude-workspaces server did not answer when this session started (\(lastReason)). Its tools appear here once it does.",
      ],
    ]
  }

  func onInitialize(_ msg: [String: Any], _ line: Data) async {
    initRequest = line
    let deadline = Date().addingTimeInterval(initWait)
    var delay = 0.25
    while true {
      if await openUpstream() {
        writeLine(initAnswer)
        return
      }
      if Date().addingTimeInterval(delay) > deadline { break }
      try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
      delay = min(delay * 2, 2)
    }
    log("answering initialize locally: \(lastReason)")
    writeJSON(localInitialize(msg))
    reconnectInBackground()
  }

  /// POST a message on the session; nil when it needs no answer.
  func forward(_ msg: [String: Any], _ line: Data) async -> Data? {
    let wantsAnswer = msg["method"] is String && msg["id"] != nil
    let answer: ([String: Any]) -> Data? = { obj in
      wantsAnswer ? try? JSONSerialization.data(withJSONObject: obj) : nil
    }
    for attempt in 0..<3 {
      if sid == nil, !(await openUpstream()) { break }
      switch await post(line, withSession: true) {
      case .unreachable(let mayHaveRun):
        if mayHaveRun {
          return answer(unavailable(msg, "the connection to the claude-workspaces server dropped mid-request, so the call may or may not have run"))
        }
        try? await Task.sleep(nanoseconds: UInt64(500_000_000 * (attempt + 1)))
        continue
      case .answer(let status, let body, _):
        if status == 404 || ((status == 401 || status == 403) && named) {
          if status != 404 { token = nil }
          dropSession()
          continue
        }
        let trimmed = body.filter { $0 != 0x20 && $0 != 0x0A && $0 != 0x0D }
        if status == 202 || trimmed.isEmpty { return nil }
        let obj = try? JSONSerialization.jsonObject(with: body)
        if let o = obj as? [String: Any], o["jsonrpc"] as? String == "2.0" { return body }
        if obj is [Any] { return body }
        return answer(unavailable(msg, refusalText(status, body)))
      }
    }
    if sid == nil { reconnectInBackground() }
    return answer(unavailable(msg, lastReason))
  }

  func beginCall() { toolCalls += 1 }
  func endCall() {
    toolCalls -= 1
    while toolCalls == 0, !held.isEmpty { writeLine(held.removeFirst()) }
  }

  func handle(_ line: Data) async {
    guard let obj = try? JSONSerialization.jsonObject(with: line) else {
      writeJSON(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "Parse error"]])
      return
    }
    guard let msg = obj as? [String: Any] else {
      if let a = await forward([:], line) { writeLine(a) }
      return
    }
    let method = msg["method"] as? String
    if method == "initialize" { return await onInitialize(msg, line) }
    if method == "notifications/initialized" {
      clientInitialized = true
      if sid != nil {
        _ = await post(line, withSession: true)
        startStream()
      }
      return
    }
    let isCall = method == "tools/call"
    if isCall { beginCall() }
    if let a = await forward(msg, line) { writeLine(a) }
    if isCall { endCall() }
  }

  func close() async {
    closed = true
    stopStream()
    guard sid != nil, var req = request("/mcp", method: "DELETE", withSession: true) else { return }
    req.timeoutInterval = 1
    _ = try? await http.data(for: req)
  }
}

@main
struct Main {
  static func main() async {
    if CommandLine.arguments.contains("--self-test") {
      // The launcher runs this before trusting a cached build: it proves the
      // binary and every library it links still load on this machine.
      _ = makeSession()
      print("ok")
      return
    }
    signal(SIGPIPE, SIG_IGN)
    let relay = Relay()
    log("compiled relay started")
    do {
      for try await line in FileHandle.standardInput.bytes.lines {
        let data = Data(line.utf8)
        if data.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { continue }
        Task { await relay.handle(data) }
      }
    } catch {
      log("stdin failed: \(error)")
    }
    await relay.close()
    exit(0)
  }
}
