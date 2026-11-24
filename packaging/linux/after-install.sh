#!/bin/bash
# The deb's and the rpm's after-install script. electron-builder fills in the executable's and the product's names
# (every dollar-brace macro here must be one it knows, or the build fails).
# It does what electron-builder's own does (the Chromium sandbox helper, the MIME and desktop databases, and the
# AppArmor profile Ubuntu needs for Electron's sandbox, spec §4), except for one thing: `moss` on the PATH is
# the daemon's command line, `resources/daemon/moss-core`, as on macOS. The app itself starts from its desktop entry.
#
# It never turns on login start: it runs as root, outside every user's session. The app does that at its first
# launch (spec §3.1, packaging/installer-hooks.ts).

CLI='/opt/${sanitizedProductName}/resources/daemon/moss-core'

if type update-alternatives >/dev/null 2>&1; then
    # Remove a previous link that doesn't use update-alternatives
    if [ -L '/usr/bin/moss' -a -e '/usr/bin/moss' -a "`readlink '/usr/bin/moss'`" != '/etc/alternatives/moss' ]; then
        rm -f '/usr/bin/moss'
    fi
    update-alternatives --install '/usr/bin/moss' 'moss' "$CLI" 100 || { [ -e '/usr/bin/moss' ] || ln -sf "$CLI" '/usr/bin/moss'; }
else
    # Never over another package's link: MOSS and MOSS Code are two packages, each with this script, and `moss` is one command
    # (the same daemon in both, one release). The first to install owns the plain link; removing it leaves the other's.
    [ -e '/usr/bin/moss' ] || ln -sf "$CLI" '/usr/bin/moss'
fi

# The install marker (packages/core/src/update/install-marker.ts): this daemon updates through apt or dnf, never
# itself. A user's home is out of reach here (root, outside every session), so it sits beside the binary, where the
# daemon reads it first.
printf '{"kind":"package"}\n' > "$(dirname "$CLI")/install.json" || true

# The SUID Chromium sandbox helper only where the kernel has no working user namespaces. MOSS also carries MOSS Code's app as
# the background host (resources/host/, apps/moss/scripts/host-helper.mjs), with a sandbox helper of its own.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    SANDBOX_MODE=4755
else
    SANDBOX_MODE=0755
fi
for SANDBOX in '/opt/${sanitizedProductName}/chrome-sandbox' '/opt/${sanitizedProductName}/resources/host/chrome-sandbox'; do
    [ -f "$SANDBOX" ] && { chmod "$SANDBOX_MODE" "$SANDBOX" || true; }
done

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# The AppArmor profile (Ubuntu 24.04 and later restrict unprivileged user namespaces, which Electron's sandbox
# needs). Installed only where this AppArmor can parse it (abi/4.0), and loaded only outside a chroot.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # A profile that parses can still fail to load (a nested container): the package installs regardless.
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" || true
    fi
  else
    echo "Skipping the AppArmor profile: this AppArmor can't parse it"
  fi
fi
