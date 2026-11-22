# Teleprompter

An offline teleprompter for Windows, macOS, Linux, iPhone, and iPad. It supports editable document imports, timed scrolling, configurable keyboard and remote controls, independent display flips, and local voice follow in English or Hungarian.

## Open the desktop setup

Desktop downloads are in the release folder.

- **Windows** — Open **Teleprompter-Setup-Windows-x64.exe**. The installer creates a Teleprompter Setup shortcut.
- **Mac with Apple silicon** — Extract **Teleprompter-Setup-macOS-arm64.tar.gz**, move **Teleprompter Setup.app** to Applications, and open it.
- **Intel Mac** — Use **Teleprompter-Setup-macOS-x64.tar.gz** and follow the same steps.
- **Linux on x64** — Extract **Teleprompter-Setup-Linux-x64.zip** and open the **Teleprompter Setup** executable inside the extracted folder. Keep the folder together.

The releases bundle the desktop runtime and the Lightweight and Compact speech models. The setup window starts the local server automatically. Click **Open Teleprompter** to open the app in your browser.

These are local development releases. Windows may show an unknown-publisher prompt. The Mac app has an ad-hoc signature and has not been notarized. macOS may require approval through **System Settings → Privacy & Security → Open Anyway**.

## Install on an iPhone or iPad

1. Open **Teleprompter Setup** on your computer and click **Start phone setup**.
2. Connect the phone to Wi-Fi on the same local network. The computer can use Wi-Fi or Ethernet to the same router. The router can be disconnected from the internet.
3. Scan the QR code with the phone camera and open its local setup link in Safari. If several network adapters appear, select the one connected to your router.
4. Tap **Download the certificate profile**. In **Settings → Profile Downloaded**, install **Teleprompter Local CA**. Then enable it under **Settings → General → About → Certificate Trust Settings**.
5. Return to the setup page, tap **Open Teleprompter in Safari**, and choose **Share → Add to Home Screen**.
6. Launch the Home Screen app while the computer is still reachable. Wait for **Offline ready**, and import or write your script.

For voice follow, choose a model in the app and tap **Prepare on this device** before disconnecting. **Lightweight** is the default on touch devices and uses the least memory. Try it first on older phones such as the iPhone XS. Compact is also included on the computer. The launcher offers downloads and a folder import for additional models. Larger models use more memory and can exceed an older phone’s browser limits. High accuracy requires WebGPU float16 and is checked before copying files.

Preparing saves the model without starting it. **Start listening** loads the engine and opens the microphone. The microphone meter shows whether sound is reaching the app, and **Heard** shows the recognized words even when they do not match the script. Stopping releases the engine’s memory. After an interrupted voice session, the app stays paused and selects Lightweight. English and Hungarian are available in every model. Recognition accuracy depends on the model, microphone, speaker, and recording conditions. Test your script and device before relying on voice follow for a shoot.

Test the installed app before a shoot by closing it completely, turning off Wi-Fi and cellular, and reopening it. Once the app, script, and chosen voice model are saved on the phone, the computer can be switched off for standalone prompting.

The computer generates the local HTTPS certificate. iOS requires the certificate and Home Screen confirmations on each device. If a firewall asks about the launcher’s network access, permit it on the private local network you use for the shoot.

## Working with scripts

Import TXT, Markdown, DOCX, selectable-text PDF, RTF, or HTML. Word and Markdown preserve supported formatting. PDF and RTF import as text. **Save a copy** exports formatted HTML that can be imported again. Keep a backup of your script in Files under **On My iPhone** or **On My iPad**. The app autosaves one working script per browser and address.

Toggle **Edit script** and **Prompter** in the workspace. Space plays or pauses, Up and Down change speed, Left and Right jump paragraphs, and Home and End move to the script boundaries. Plus and Minus change the prompter text size. Hold Left Shift for the slower preset. Open **Settings** to rebind keys and set the temporary speed and wheel step. The wheel adjusts speed over the prompter. Remotes need to send keyboard or wheel events to the focused app.

**Start presenting** fills the current screen. Use **Back to workspace** or Escape to return. With your desktop displays set to Extend, choose **Second monitor**, move the new window to the extended display, and select Full screen there. The original window remains the operator. The second monitor has its own flip controls and accepts the workspace shortcuts. On an iPad or iPhone that mirrors HDMI, the external display mirrors the presentation.

**Live English (streaming)** has three follow styles. **Word match** moves after the recognizer finds a match in the script. Set **Word lead** to 0 to cue the last matched word, 1 for the next word, or up to 6 words ahead. **Predictive (v0.5.3)** uses your recent pace to anticipate one word between matches. **Paced (v0.5.4)** leads through the script using your speaking pace. All three share the same offline model. Prepare it once while connected to Teleprompter Setup. To follow by line, turn off **Highlight words** under **Reading guide and text layout**. Hungarian uses the Whisper models. The footer shows the running app version and opens the offline update status.

Enable **Continuous voice scrolling** under **Reading guide and text layout** to glide between lines during voice follow. The scroll adjusts to matched words and slows to a stop when you pause. Set **Voice offset** to **+1** to bring the next line to the guide, or **0** to stay with the matched line. Raise **Scroll smoothing** for longer ramps and a slower coast to a stop.

Timed scrolling uses pixels per second so the current screen scrolls at the same visual speed in the preview and presentation. Tap full-screen text to play or pause, or drag to move through the script and pause timed playback. Under **Reading guide and text layout**, change text size, left and right margins, masking, and guide position and size against the live preview.

On the device that runs the script, select **Connect displays → Operator → Start pairing**. On the device that will show it, open Teleprompter, choose **Connect displays → Display**, and enter the displayed code. Each device shows its role during the session. On iPhone and iPad you can enter the code directly in the Home Screen app. Both devices must use the same desktop setup over a local network. The optional browser setup link and QR code help if the display still needs to install the certificate. Playback controls on the display also control the session. Keep phone setup running until you finish.

To update, install the new desktop release and open the phone app while connected to that computer over local Wi-Fi. When **Update available** appears, open it and select **Use updated app** after finishing your take. If an older version only says Offline ready, close and reopen it once more after the server has supplied the update. The app never automatically reloads during a take. Scripts and settings stay under the same browser address. Prepare Lightweight once in the updated phone app before testing offline.

The browser address identifies where scripts and offline files are stored. Use the same local address when returning to the app. Export scripts before moving to a new computer or address.

## Build from source

With Node.js 22.12 or newer, run these commands from the project folder.

    npm install
    npm run build

Then prepare the bundled speech models once for packaging. The English streaming model is included when it has been prepared before running the build.

    npm run prepare:voice -- base
    npm run prepare:voice -- tiny
    npm run prepare:streaming
    npm run build

From the desktop folder, install the launcher dependencies and run it.

    npm install
    npm start

Build a Windows installer from the desktop folder with **npm run package:windows**. Native Mac builds use **npm run package:mac**, and native Linux builds use **npm run package:linux**.

The desktop folder also provides **npm run archive -- linux-x64 mac-arm64 mac-x64**. Cross-building Mac archives requires a working signing environment. On Windows, set **TELEPROMPTER_WSL_DISTRIBUTION** to an installed Linux distribution and **TELEPROMPTER_RCODESIGN** to a checksum-verified Linux rcodesign executable. The archive helper uses that environment to sign the app locally and preserve its Unix permissions and framework links. On a Mac it uses the system codesign command.

For browser-only development, **npm start** serves the app at **http://localhost:4173**. The existing **npm run setup:lan** and **npm run lan** commands remain available for local HTTPS setup.

Run **npm test** to check speech matching, certificate reuse, local phone setup, and server recovery after a port conflict.
