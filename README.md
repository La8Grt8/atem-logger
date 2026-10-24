# ATEM Logger

Logs every program switch on a Blackmagic ATEM switcher to a **CMX 3600 EDL** for
DaVinci Resolve. It's built for switchers without ISO recording (e.g. the Constellation 4K):
record each camera separately (HyperDecks, camera cards), log the cuts with ATEM Logger, then
conform the EDL against the camera files in Resolve to rebuild the live edit.

It runs quietly in the background on a Mac or Windows PC on the same network as the switcher,
and you control it from a web page at **http://localhost:9920**. You can also open it from any
phone, tablet or computer on the network.

- Start/stop logging with a show title and save folder
- Live timecode, program/preview, and the last 12 switches
- Markers: button, Enter, or press **M**. They export as a separate Resolve markers EDL
- Reel name for each input, so the EDL matches your camera filenames
- Download links for finished EDLs
- Captures cuts from any source: the hardware panel, ATEM Software Control, macros, Companion, etc.
- The EDL is saved after every cut, so a crash or power loss never loses the show
- **Tentacle Sync jam**: plug Tentacle Sync timecode boxes into the logger computer by USB and
  they're set to the same timecode the EDL uses, so camera files conform. See below.

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

Don't delete or move the folder after installing, because the app runs from it.

### Mac
Double-click **`Install on Mac.command`**.
If macOS says it can't be opened because it's from an unidentified developer, right-click the
file → **Open** → **Open**. If macOS asks to let "node" find devices on your local network,
click **Allow**, since the app needs that to reach the switcher.

Terminal alternative: `bash scripts/install-mac.sh`

### Windows
Double-click **`Install on Windows.bat`**.
If Windows SmartScreen appears, click **More info → Run anyway**. If Windows Firewall asks about
Node.js, tick **Private networks** and click **Allow**. To skip that prompt, run the installer as
administrator, which adds the firewall rule for you.

The installer opens the control page when it's done. From then on, ATEM Logger starts on its own
when you log in.

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

## First run

1. Open **http://localhost:9920**.
2. Open **Switcher & timecode settings**, enter your ATEM's IP address, and click **Save settings**.
   The header turns green when it connects.
3. Under **Reel names**, set the reel for each camera input (e.g. CAM1, CAM2, CAM3) and save.
4. Enter a title and save folder, then click **Start EDL**. Click **Stop EDL** when the show ends.

## Tentacle Sync: jam cameras to the EDL timecode

> ⚠️ Untested on real hardware. The USB protocol was reverse-engineered from Tentacle's own
> Tentacle Setup 3.00 app. Do a test jam and check it before relying on it for a show.

The EDL only conforms if the camera files carry the same timecode as the logger. If your
cameras get timecode from **Tentacle Sync** boxes (Sync, Sync E, Track E), the **Tentacle Sync**
panel sets them for you:

1. **Quit Tentacle Setup** if it's open. It holds the same USB connection.
2. Plug a Tentacle into the logger computer with a USB cable and switch it on.
3. With **Auto-jam when plugged in** on (the default), it's jammed within a couple of seconds.
   Otherwise press **Jam Tentacles**. Wait for **✓ in sync**.
4. Unplug it, mount it on the camera, and do the next one.

Each jam sets the Tentacle's frame rate to match the switcher, sends the timecode on a frame
boundary, reads it back and corrects once if it landed a frame off. **Check** reads every
plugged-in Tentacle and shows how far it has drifted, without changing anything.

The timecode comes from the **Timecode source** setting, the same one the EDL uses: the
switcher's timecode, or this computer's clock. 50p and 59.94p switchers are jammed at 25 and
29.97 because Tentacles run timecode at up to 30 fps.

- **Mac:** works with the normal install.
- **Windows:** the Tentacle needs a WinUSB driver, which Tentacle's own Windows software
  normally installs. Not yet tested.
- **Docker:** USB isn't passed into the container, so the panel shows no Tentacles. Jam from a
  Mac or PC install instead.

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

## Settings

| Setting | Where | Default |
|---|---|---|
| Switcher IP | page → Switcher & timecode settings | 192.168.11.240 |
| M/E bus logged | same | M/E 1 |
| Timecode source | same | Switcher timecode |
| Timeline start TC | same | 01:00:00:00 |
| Save folder | main panel | `~/Movies/ATEM EDLs` (Mac), `%USERPROFILE%\Videos\ATEM EDLs` (Windows) |
| Port | `PORT` environment variable when installing (Docker: change the left side of `9920:9920`) | 9920 |

Settings are stored in `~/.atem-logger/settings.json` (Mac) or `%USERPROFILE%\.atem-logger\settings.json` (Windows).

## Update / uninstall

- **Update:** replace the folder with the new download (or `git pull`), then run the installer again.
- **Uninstall:** double-click `Uninstall on Mac.command` or `Uninstall on Windows.bat`, then delete the folder.
- **Log file:** `~/.atem-logger/logger.log` (Mac), `%USERPROFILE%\.atem-logger\logger.log` (Windows).

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
```

The EDL engine (`src/edl-logger.ts`) is shared with
[claude-atem-mcp](https://github.com/La8Grt8/claude-atem-mcp), which adds AI control of the
switcher via the Model Context Protocol.

## License

MIT. See [LICENSE](LICENSE).
