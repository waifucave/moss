#!/bin/bash
# The deb's and the rpm's after-remove script, electron-builder's own for the `moss` link after-install.sh makes and
# the AppArmor profile. electron-builder fills in the executable's and the product's names.
#
# A user's login start (a systemd user unit running moss-core supervise, lane C's) is out of reach here: this runs
# as root, outside every user's session. The unit has to stay inert once its binary is gone (packaging/installer-
# hooks.ts), and `moss autostart remove` removes it for good.

# Only on a real removal. An upgrade runs the old package's script too: the deb's postrm with `upgrade`, and the rpm's
# %postun with 1 after the new package's %post, which would delete the link and the profile the new version just made.
case "${1:-}" in
  remove|purge|0) ;;
  *) exit 0 ;;
esac

CLI='/opt/${sanitizedProductName}/resources/daemon/moss-core'

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'moss' "$CLI"
else
    # Only our own link: the other app's package (MOSS and MOSS Code share the one `moss` command) keeps its.
    if [ "$(readlink '/usr/bin/moss' 2>/dev/null)" = "$CLI" ]; then
        rm -f '/usr/bin/moss'
        # ...and the link goes to the other app's daemon when that one is installed (the same daemon, one release).
        for OTHER in /opt/moss-code/resources/daemon/moss-core /opt/moss/resources/daemon/moss-core; do
            if [ "$OTHER" != "$CLI" ] && [ -x "$OTHER" ]; then ln -sf "$OTHER" '/usr/bin/moss'; break; fi
        done
    fi
fi

# The install marker after-install.sh wrote beside the binary (no package owns it).
rm -f "$(dirname "$CLI")/install.json"

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Unload the profile before deleting it, so it isn't left enforced until the next reboot; not inside a chroot.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
