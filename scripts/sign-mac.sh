#!/bin/sh
set -eu
archive="$1"
output="$2"
signer="$3"
base="${4:-/tmp}"
base="$(realpath "$base")"
work="$(mktemp -d "$base/teleprompter-mac.XXXXXX")"
case "$work" in "$base"/teleprompter-mac.*) ;; *) exit 1 ;; esac
resolved="$(realpath "$work")"
test "$resolved" = "$work"
trap 'rm -rf "$work"' EXIT
unzip -q "$archive" -d "$work"
bundle="$work/Teleprompter Setup.app"
cat > "$work/entitlements.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
EOF
if test "$signer" = codesign; then
  codesign --force --deep --sign - --entitlements "$work/entitlements.plist" "$bundle"
  codesign --verify --deep --strict "$bundle"
else
  "$signer" sign --timestamp-url none --entitlements-xml-file "main:$work/entitlements.plist" "$bundle"
  "$signer" print-signature-info "$bundle/Contents/MacOS/Electron" > "$work/signature.txt"
  test -s "$work/signature.txt"
fi
tar -czf "$output" -C "$work" 'Teleprompter Setup.app' 'Read me.txt'
