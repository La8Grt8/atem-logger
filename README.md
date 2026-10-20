# ATEM Logger

Logs every program switch on a Blackmagic ATEM switcher to an **EDL** for
**DaVinci Resolve, Adobe Premiere Pro, Avid Media Composer or Final Cut Pro**. It's built for switchers without ISO recording (e.g. the Constellation 4K):
record each camera separately (HyperDecks, camera cards), log the cuts with ATEM Logger, then
conform the EDL against the camera files in your edit software to rebuild the live edit.

It runs as a **background service** on a Mac or Windows PC on the same network as the switcher.
It starts when the computer boots, with nobody logged in, and restarts itself if it ever crashes.
You run shows from a web page at **http://localhost:9920**, which you can also open from any phone,
tablet or computer on the network. A **menu-bar / system-tray icon** and an **`atem-logger`
command** start, stop and restart the service, and the app **checks GitHub for updates** and
offers to install them.

- Start/stop logging with a show title and save folder
- Live timecode, program/preview, and the last 12 switches
- Markers: button, Enter, or press **M**. They export as a separate Resolve markers EDL
- Reel name for each input, so the EDL matches your camera filenames
- **Edit software** choice: files made for Resolve, Premiere Pro, Avid or Final Cut Pro (FCPXML built
  from your camera files, with their timecode)
- Download links for finished EDLs
- Captures cuts from any source: the hardware panel, ATEM Software Control, macros, Companion, etc.
- The EDL is saved after every cut, so a crash or power loss never loses the show
- Runs as a system service, controlled from the tray icon or command line
- Built-in update check: one click to install a new release

> ⚠️ Early release. The EDL engine has been used on a real show and conformed in DaVinci
> Resolve, but this standalone app is new. Run a short test before relying on it for a live job.

## Install

You need **Node.js 20 or newer**. The installers will try to install it for you (Homebrew on
Mac, winget on Windows) or open the download page if they can't.

**Get the files.** Either click **Code → Download ZIP** on this page and unzip it somewhere
permanent (e.g. your Documents folder), or:

```
git clone https://github.com/La8Grt8/atem-logger.git
```

Don't delete or move the folder after installing, because the service runs from it. Installing
needs an **administrator account**; you'll be asked for your password once.

A quick start guide for operators is in [`docs/ATEM-Logger-Quick-Start.pdf`](docs/ATEM-Logger-Quick-Start.pdf).

### Mac
Double-click **`Install on Mac.command`** and enter your Mac password when asked.
If macOS says it can't be opened because it's from an unidentified developer, right-click the
file → **Open** → **Open**.

This installs:
- the **service** (`/Library/LaunchDaemons/com.atem-logger.plist`), which runs as your user
  so it can use your drives and settings;
- the **menu-bar icon** (the ◎ next to the clock), which starts at login;
- the **`atem-logger`** command.

Terminal alternative: `bash scripts/install-mac.sh`

> **FileVault:** if FileVault is on, a Mac that restarts (power cut, update) waits at the disk
> unlock screen until someone enters a password. After that, ATEM Logger starts on its own,
> even if nobody logs in.

### Windows
Double-click **`Install on Windows.bat`** and click **Yes** when Windows asks for administrator
rights. If SmartScreen appears, click **More info → Run anyway**.

This installs:
- the **"ATEM Logger" Windows Service**, which starts automatically at boot (it uses the
  [WinSW](https://github.com/winsw/winsw) service wrapper, downloaded and checksum-verified
  during install);
- the **tray icon**, which starts at sign-in for every user;
- the **`atem-logger`** command;
- a firewall rule for the control page.

> The service runs as the Windows *Local System* account, so it can't see mapped network drive
> letters. To save EDLs on a NAS, use the share's full path, e.g. `\\nas\projects\EDL`.

The installer opens the control page when it's done.

### Docker (ZimaBoard/CasaOS, Synology, Unraid, Linux, NAS)

A ready-made image for Intel/AMD and ARM is published at
**`ghcr.io/la8grt8/atem-logger`**, so you don't have to build anything.

**Quick start** (change the IP and the EDL folder):

```
docker run -d --name atem-logger --restart unless-stopped \
  -p 9920:9920 \
  -e ATEM_IP=192.168.11.240 -e TZ=America/Toronto \
  -v ./atem-logger/data:/data \
  -v ./atem-logger/edl:/edl \
  ghcr.io/la8grt8/atem-logger:latest
```

**Docker Compose:** download [`docker-compose.yml`](docker-compose.yml), edit the IP, time
zone and EDL folder, then run:

```
docker compose up -d
```

**CasaOS (ZimaBoard):** App Store → **Custom Install** → **Import**, paste the contents of
`docker-compose.yml`, adjust the EDL folder path, and install.

Then open **http://&lt;docker-host-ip&gt;:9920**.

- EDLs are written to the `/edl` volume. Map it to a NAS or SMB share to have them land
  straight in your project storage, or download them from the control page.
- Settings persist in the `/data` volume.
- Set `TZ` to your time zone, or file timestamps and the "computer clock" timecode will be in UTC.
- The container needs to reach the switcher on **UDP 9910**.
- Update: `docker compose pull && docker compose up -d`.
- Tags: `latest` (main branch), version tags such as `1.0.0` and `1.0`, and `sha-xxxxxxx`.

To build the image yourself instead, run `docker build -t atem-logger .` in this folder, or
use `build: .` in the compose file.

## Controlling the service

**Menu-bar / tray icon.** Its color shows the state at a glance: grey = service stopped,
orange = running but no switcher, green = ready, red = logging. Click it for:

- switcher and logging status
- **Open Control Page**, plus **Add Marker** while logging
- **Start / Stop / Restart Service**, which asks first if an EDL is being logged
- **Update to x.y.z…** when an update is available
- **Quit**, which removes the icon only; the service keeps running

**Command line** (Terminal on Mac, any new terminal window on Windows):

| Command | What it does |
|---|---|
| `atem-logger status` | Running/stopped, switcher connection, logging state |
| `atem-logger start` | Start the service |
| `atem-logger stop` | Stop it. Any EDL in progress is finalized first. It stays stopped until you start it or the computer reboots |
| `atem-logger restart` | Restart it |
| `atem-logger open` | Open the control page |
| `atem-logger logs` | Follow the log |
| `atem-logger disable` / `enable` | Don't start / do start at boot (asks for an admin password) |

On a Mac, admins can start, stop and restart without a password. On Windows, any signed-in user
can. If the service ever crashes, it restarts itself within a few seconds.

## Updates

The app checks GitHub for a new release when it starts and every 6 hours. When one is
available:

- the control page shows a banner: **Update now / What's new / Later**;
- the menu-bar / tray icon asks once: **Update Now / Later**.

Updating downloads the release, rebuilds, and restarts the service, which takes about a minute.
It's **blocked while an EDL is being logged**, so an update can never interrupt a show. You
can also check by hand under **Switcher & timecode settings → Check for updates**.

Docker installs update by pulling the new image instead (see below).

## First run

1. Open **http://localhost:9920**.
2. Open **Switcher & timecode settings**, enter your ATEM's IP address, and click **Save settings**.
   The header turns green when it connects.
3. Under **Reel names**, set the reel for each camera input (e.g. CAM1, CAM2, CAM3) and save.
4. Enter a title and save folder, choose your **Edit software**, then click **Start EDL**. Click
   **Stop EDL** when the show ends. See [Edit software](#edit-software) for importing into your app.

## Conforming in DaVinci Resolve

1. **Project Settings → Master Settings**: set the timeline frame rate to match the show
   (e.g. 29.97, drop-frame) before importing media.
2. **Project Settings → General Options → Conform Options**: tick **Assist using reel names
   from the: Source clip filename**.
3. Rename each camera file to its reel name (`CAM1.mov`, `CAM2.mov`…) and import them.
4. **File → Import → Timeline**, pick the `.edl`, and untick *Automatically import source clips*.
5. To bring in markers, right-click the timeline in the Media Pool → **Timelines → Import →
   Timeline Markers from EDL**, and pick the `_markers.edl`.

Timecode must match: the EDL's source timecode comes from the switcher's clock (or the
computer's clock, if you choose that), so the camera files need the same time-of-day timecode,
e.g. jam-synced with Tentacle Sync or fed from the same generator as the switcher.

## Edit software

Pick your edit software on the control page (**Edit software**, under the save folder). Every
show gets a CMX 3600 EDL plus a `.json` log; what else you get depends on the choice:

| Edit software | Files | Markers |
|---|---|---|
| **DaVinci Resolve** | `.edl` | `_markers.edl` (Resolve marker EDL) |
| **Premiere Pro** | `.edl` with clip names = reel names (for Link Media) | `_markers.csv` list (Premiere can't import marker files) |
| **Avid Media Composer** | `.edl` (tape names = reel names) | `_markers.txt` (Avid marker list) |
| **Final Cut Pro** | `.fcpxml` built from the camera files, plus `.edl` | inside the FCPXML, on the clips |

**DaVinci Resolve:** see [Conforming in DaVinci Resolve](#conforming-in-davinci-resolve).

**Premiere Pro:** File ▸ Import ▸ choose the `.edl` and pick a sequence preset that matches the
show. Premiere builds the sequence from offline clips named CAM1, CAM2… Select them in the bin,
right-click ▸ **Link Media**, keep *File Name* ticked and untick *File Extension*, then point it at
`CAM1.mov`. The others link from the same folders. The `_markers.csv` lists each marker's timeline
timecode and note.

**Avid Media Composer:** File ▸ Import the `.edl` (or use EDL Manager) to get a sequence of offline
clips whose **Tape** names are CAM1, CAM2… Link your camera files, give them the same Tape names, and
relink the sequence (Clip ▸ Relink, by tape name and timecode). To bring in markers, open the
Markers window, Fast Menu ▸ **Import Markers**, and choose the `_markers.txt`.

**Final Cut Pro** can't import EDLs, so the logger writes an **FCPXML** instead. It finds the camera
files named after the reels (`CAM1.mov`, `CAM2.mov`… anywhere under the folder above the EDL folder,
or a folder you choose), reads each file's start timecode, and describes the cut with those files.
This happens automatically when you stop an EDL. If the camera files aren't on the drive yet, use
**EDL files ▸ Build Final Cut XML** later. In Final Cut: File ▸ Import ▸ XML, choose the
`.fcpxml`, and you get a new event and project already linked to the camera files, with the
markers on the clips. QuickTime (`.mov`) and MP4 camera files with a timecode track are supported.

> The Resolve workflow is tested on real shows. The Premiere and Avid EDLs follow the standard
> CMX 3600 format those apps import. The FCPXML has been checked by importing it into Resolve, which
> linked all the camera files at the right timecode, but it hasn't yet been opened in Final Cut
> itself. Try a short test show in your app first.

## Settings

| Setting | Where | Default |
|---|---|---|
| Switcher IP | page → Switcher & timecode settings | 192.168.11.240 |
| M/E bus logged | same | M/E 1 |
| Timecode source | same | Switcher timecode |
| Timeline start TC | same | 01:00:00:00 |
| Edit software | main panel | DaVinci Resolve |
| Camera files folder (Final Cut) | EDL files ▸ Final Cut Pro XML | folder above the EDL folder |
| Save folder | main panel | `~/Movies/ATEM EDLs` (Mac), `%USERPROFILE%\Videos\ATEM EDLs` (Windows) |
| Port | `PORT` environment variable when installing (Docker: change the left side of `9920:9920`) | 9920 |

Settings are stored in `~/.atem-logger/settings.json` (Mac) or `%USERPROFILE%\.atem-logger\settings.json` (Windows).

## Update / uninstall

- **Update:** use the update prompt (see [Updates](#updates)), or replace the folder / `git pull`
  and run the installer again.
- **Uninstall:** double-click `Uninstall on Mac.command` or `Uninstall on Windows.bat`, then
  delete the folder. This removes the service, tray icon and command, and keeps your settings.
- **Log file:** `~/.atem-logger/logger.log` (Mac), `%USERPROFILE%\.atem-logger\atem-logger-service.out.log` (Windows).

## Network

The app talks to the switcher on **UDP 9910**, the same port ATEM Software Control uses. If
the computer and switcher are on different subnets/VLANs, allow UDP 9910 between them. The
control page uses **TCP 9920**.

Several apps can connect to the ATEM at once, so ATEM Logger runs alongside ATEM Software
Control, Companion, etc.

## Development

```
npm ci --include=dev --ignore-scripts
npm run build
npm start        # runs in the foreground
npm test         # simulated-switcher test of the EDL engine
node test/platforms-test.mjs [camera-folder]   # one simulated show per edit platform (+ FCPXML)
```

The EDL engine (`src/edl-logger.ts`) is shared with
[claude-atem-mcp](https://github.com/La8Grt8/claude-atem-mcp), which adds AI control of the
switcher via the Model Context Protocol.

## Releasing a new version

1. Bump `version` in `package.json`.
2. Only if the menu-bar app changed: bump `CFBundleShortVersionString` in `tray/mac/Info.plist`, run
   `bash tray/mac/build.sh` on a Mac with Xcode Command Line Tools, and commit the rebuilt
   `tray/mac/ATEM Logger.app` (installed icons restart themselves when it changes).
3. Push, then push a tag `vX.Y.Z` (`git tag v1.2.0 && git push origin v1.2.0`). Installed copies see it within
   6 hours. Optionally add a GitHub Release for the tag; its notes are linked from the update prompt. The
   Docker image is built automatically.

## License

MIT. See [LICENSE](LICENSE).
