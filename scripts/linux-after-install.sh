#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/muse' -a -e '/usr/bin/muse' -a "`readlink '/usr/bin/muse'`" != '/etc/alternatives/muse' ]; then
        rm -f '/usr/bin/muse'
    fi
    update-alternatives --install '/usr/bin/muse' 'muse' '/opt/Muse/muse' 100 || ln -sf '/opt/Muse/muse' '/usr/bin/muse'
else
    ln -sf '/opt/Muse/muse' '/usr/bin/muse'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/Muse/chrome-sandbox' || true
else
    chmod 0755 '/opt/Muse/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# 关键：更新 GTK 图标缓存，确保安装后 Ubuntu/GNOME 应用中心、Dock 栏与桌面即时刷新最新图标
if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

# Install apparmor profile. (Ubuntu 24+)
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/Muse/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/muse'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
