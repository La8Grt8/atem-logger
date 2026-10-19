// ATEM Logger menu-bar app: shows the service state and starts/stops/restarts it.
// Build: tray/mac/build.sh
import Cocoa

let label = "com.atem-logger"
let plistPath = "/Library/LaunchDaemons/\(label).plist"

func servicePort() -> String {
    if let d = NSDictionary(contentsOfFile: plistPath),
       let env = d["EnvironmentVariables"] as? [String: Any], let p = env["PORT"] as? String { return p }
    return "9920"
}

struct Status {
    var running = false          // process alive (launchd)
    var responding = false       // web API answering
    var connected = false
    var model = ""
    var ip = ""
    var logging = false
    var title = ""
    var events = 0
    var markers = 0
    var version = ""
    var updateAvailable = false
    var latest = ""
    var canUpdate = false
    var updateState = "idle"
    var updateMessage = ""
    var releaseUrl = ""
}

let runningTrayVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
/// Version of the tray app now on disk (changes when the app updates itself).
func onDiskTrayVersion() -> String {
    let plist = Bundle.main.bundleURL.appendingPathComponent("Contents/Info.plist")
    return (NSDictionary(contentsOf: plist)?["CFBundleShortVersionString"] as? String) ?? runningTrayVersion
}

final class TrayController: NSObject, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var status = Status()
    var timer: Timer?
    var busy = false
    lazy var port = servicePort()
    var baseURL: String { "http://localhost:\(port)" }

    override init() {
        super.init()
        menu.delegate = self
        item.menu = menu
        item.button?.toolTip = "ATEM Logger"
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // MARK: state

    func launchdRunning() -> Bool {
        let out = run("/bin/launchctl", ["print", "system/\(label)"]).out
        return out.contains("\tpid = ")
    }

    func refresh() {
        let running = launchdRunning()
        guard running, let url = URL(string: baseURL + "/api/status") else {
            apply(Status(running: running)); return
        }
        var req = URLRequest(url: url); req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            var s = Status(running: true)
            if let data = data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                s.responding = true
                if let a = j["atem"] as? [String: Any] {
                    s.connected = a["connected"] as? Bool ?? false
                    s.model = a["model"] as? String ?? ""
                    s.ip = a["ip"] as? String ?? ""
                }
                if let l = j["logging"] as? [String: Any] {
                    s.logging = l["active"] as? Bool ?? false
                    s.title = l["title"] as? String ?? ""
                    s.events = l["events"] as? Int ?? 0
                    s.markers = l["markers"] as? Int ?? 0
                }
                s.version = j["version"] as? String ?? ""
                if let u = j["update"] as? [String: Any] {
                    s.updateAvailable = u["available"] as? Bool ?? false
                    s.latest = u["latest"] as? String ?? ""
                    s.canUpdate = u["canUpdate"] as? Bool ?? false
                    s.updateState = u["state"] as? String ?? "idle"
                    s.updateMessage = u["message"] as? String ?? ""
                    s.releaseUrl = u["releaseUrl"] as? String ?? ""
                }
            }
            DispatchQueue.main.async { self?.apply(s) }
        }.resume()
    }

    func apply(_ s: Status) {
        status = s
        let (symbol, color): (String, NSColor) =
            !s.running ? ("record.circle", .secondaryLabelColor) :
            s.logging ? ("record.circle.fill", .systemRed) :
            s.connected ? ("record.circle", .systemGreen) : ("record.circle", .systemOrange)
        if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "ATEM Logger") {
            let cfg = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium).applying(.init(paletteColors: [color]))
            let tinted = img.withSymbolConfiguration(cfg)
            tinted?.isTemplate = false
            item.button?.image = tinted
        }
        item.button?.title = s.logging ? " \(s.events)" : ""
        item.button?.toolTip = "ATEM Logger — " + summary()
        if menu.numberOfItems > 0 { buildMenu() }   // live-update while open
        // After an app update the tray binary on disk changes: exit so launchd starts the new one.
        if onDiskTrayVersion() != runningTrayVersion { exit(1) }
        maybePromptUpdate()
    }

    // MARK: updates

    var prompting = false
    var laterVersion: String {
        get { UserDefaults.standard.string(forKey: "laterVersion") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "laterVersion") }
    }

    /// Ask once per new version, and never while an EDL is being logged.
    func maybePromptUpdate() {
        let s = status
        guard s.updateAvailable, s.canUpdate, !s.logging, s.updateState == "idle", !prompting, !busy,
              laterVersion != s.latest else { return }
        prompting = true
        DispatchQueue.main.async { self.promptUpdate(); self.prompting = false }
    }

    @objc func promptUpdate() {
        let s = status
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "ATEM Logger \(s.latest) is available"
        a.informativeText = "You have \(s.version). Updating takes about a minute and restarts the logger." +
            (s.logging ? "\n\nStop the EDL first — you can't update while logging." : "")
        a.addButton(withTitle: "Update Now")
        a.addButton(withTitle: "Later")
        if !s.releaseUrl.isEmpty { a.addButton(withTitle: "What's New") }
        let r = a.runModal()
        if r == .alertFirstButtonReturn {
            if s.logging { return }
            installUpdate()
        } else if r == .alertSecondButtonReturn {
            laterVersion = s.latest
        } else if let u = URL(string: s.releaseUrl) {
            laterVersion = s.latest
            NSWorkspace.shared.open(u)
        }
    }

    func installUpdate() {
        guard let url = URL(string: baseURL + "/api/update/install") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = "{}".data(using: .utf8)
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                if let h = resp as? HTTPURLResponse, h.statusCode != 200,
                   let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    self?.alert("Couldn't update ATEM Logger", j["error"] as? String ?? "")
                }
                self?.refresh()
            }
        }.resume()
    }

    func summary() -> String {
        if !status.running { return "Service stopped" }
        if !status.responding { return "Starting…" }
        if status.logging { return "Logging \(status.title)" }
        return status.connected ? "Running · switcher connected" : "Running · switcher not connected"
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) { buildMenu() }

    func info(_ text: String) -> NSMenuItem {
        let i = NSMenuItem(title: text, action: nil, keyEquivalent: ""); i.isEnabled = false; return i
    }

    func action(_ title: String, _ sel: Selector, enabled: Bool = true, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: enabled ? sel : nil, keyEquivalent: key)
        i.target = self; i.isEnabled = enabled; return i
    }

    func buildMenu() {
        menu.removeAllItems()
        let s = status
        menu.addItem(info(busy ? "ATEM Logger — working…" :
                          !s.running ? "ATEM Logger — Stopped" :
                          !s.responding ? "ATEM Logger — Starting…" : "ATEM Logger — Running"))
        if s.running && s.responding {
            menu.addItem(info(s.connected ? "Switcher: \(s.model) (\(s.ip))" : "Switcher: not connected (\(s.ip))"))
            menu.addItem(info(s.logging ? "Logging: \(s.title) · \(s.events) switches · \(s.markers) markers" : "Logging: off"))
        }
        menu.addItem(.separator())
        if s.updateState == "updating" || s.updateState == "restarting" {
            menu.addItem(info(s.updateMessage.isEmpty ? "Updating…" : s.updateMessage))
        } else if s.updateAvailable {
            menu.addItem(action(s.canUpdate ? "Update to \(s.latest)…" : "Version \(s.latest) available", #selector(promptUpdate), enabled: s.canUpdate))
        }
        menu.addItem(action("Open Control Page", #selector(openPage), enabled: s.responding, key: "o"))
        if s.logging { menu.addItem(action("Add Marker", #selector(addMarker), key: "m")) }
        menu.addItem(.separator())
        menu.addItem(action("Start Service", #selector(startService), enabled: !s.running && !busy))
        menu.addItem(action("Stop Service", #selector(stopService), enabled: s.running && !busy))
        menu.addItem(action("Restart Service", #selector(restartService), enabled: s.running && !busy))
        menu.addItem(.separator())
        if !s.version.isEmpty { menu.addItem(info("Version \(s.version)")) }
        menu.addItem(action("Quit Menu Bar Icon", #selector(quit), key: "q"))
    }

    // MARK: actions

    @objc func openPage() { NSWorkspace.shared.open(URL(string: baseURL)!) }

    @objc func addMarker() {
        guard let url = URL(string: baseURL + "/api/marker") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = "{\"note\":\"Marker (menu bar)\"}".data(using: .utf8)
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in DispatchQueue.main.async { self?.refresh() } }.resume()
    }

    @objc func startService() { control(["kickstart", "system/\(label)"]) }
    @objc func restartService() {
        if status.logging && !confirm("Restart while logging?", "The EDL for “\(status.title)” will be finalized. Start a new EDL after the restart to keep logging.") { return }
        post("/api/service/restart") { ok in if !ok { self.control(["kickstart", "-k", "system/\(label)"]) } }
    }
    @objc func stopService() {
        if status.logging && !confirm("Stop while logging?", "The EDL for “\(status.title)” will be finalized and no more cuts will be logged until the service is started again.") { return }
        post("/api/service/stop") { ok in if !ok { self.control(["kill", "SIGTERM", "system/\(label)"]) } }
    }

    /// POSTs to the local service; calls back with whether it accepted.
    func post(_ path: String, _ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: baseURL + path) else { return done(false) }
        busy = true; buildMenu()
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.busy = false; done(ok); self.refresh() }
        }.resume()
    }
    @objc func quit() { exit(0) }   // clean exit: launchd won't relaunch it until next login

    /// Runs `sudo -n launchctl …` (password-free via the rule the installer adds); falls back to an admin prompt.
    func control(_ args: [String]) {
        busy = true; buildMenu()
        DispatchQueue.global().async {
            var r = run("/usr/bin/sudo", ["-n", "/bin/launchctl"] + args)
            if r.code != 0 {
                let cmd = (["/bin/launchctl"] + args).joined(separator: " ")
                r = run("/usr/bin/osascript", ["-e", "do shell script \"\(cmd)\" with administrator privileges"])
            }
            Thread.sleep(forTimeInterval: 1.5)
            DispatchQueue.main.async {
                self.busy = false
                if r.code != 0 && !r.err.contains("-128") { self.alert("Couldn't change the ATEM Logger service", r.err) }
                self.refresh()
            }
        }
    }

    func confirm(_ title: String, _ text: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert(); a.messageText = title; a.informativeText = text
        a.addButton(withTitle: "Continue"); a.addButton(withTitle: "Cancel")
        return a.runModal() == .alertFirstButtonReturn
    }

    func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert(); a.messageText = title; a.informativeText = text; a.runModal()
    }
}

@discardableResult
func run(_ path: String, _ args: [String]) -> (code: Int32, out: String, err: String) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
    let o = Pipe(), e = Pipe(); p.standardOutput = o; p.standardError = e
    do { try p.run() } catch { return (1, "", error.localizedDescription) }
    let od = o.fileHandleForReading.readDataToEndOfFile(), ed = e.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: od, as: UTF8.self), String(decoding: ed, as: UTF8.self))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = TrayController()
app.run()
