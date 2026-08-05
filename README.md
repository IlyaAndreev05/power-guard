# Power Guard

Power Guard is a standalone GNOME Shell Quick Settings extension for choosing what happens when a laptop lid closes.

Suggested GitHub description:

> GNOME Shell Quick Settings menu for choosing what happens when a laptop lid closes.

## How it works

Power Guard adds one dropdown item named **Lid Action** to Quick Settings. Its subtitle shows the action currently used by this session, and the selected menu entry has a checkmark. The default is **Do nothing** (`ignore`), which prevents logind's normal lid action without doing anything else.

Available actions are shown when supported by the system:

- Do nothing
- Lock screen
- Sleep / Suspend
- Hibernate
- Hybrid sleep
- Suspend then hibernate
- Power off
- Reboot

The capability values reported by `org.freedesktop.login1.Manager` determine whether the sleep, hibernate, power, and reboot entries are shown. A stored action that becomes unsupported is not executed; the session safely falls back to Do nothing without changing the stored setting.

**Lock screen** locks only the current GNOME session through GNOME Shell's screen shield. It does not suspend the machine and leaves applications running. The other power actions are requested from the system `org.freedesktop.login1.Manager` service.

Power Guard is independent of [Caffeine](https://github.com/eonpatapon/gnome-shell-extension-caffeine). It does not fork, modify, or depend on Caffeine, and it does not implement timers, fullscreen or MPRIS handling, idle inhibition, or power-key policies.

## Lid detection and permissions

The extension checks `org.freedesktop.UPower`'s `LidIsPresent` property. On a desktop or another system without a lid, it stays quiet: no Quick Settings item is created and no inhibitor is acquired.

On a laptop, Power Guard acquires a system D-Bus `login1.Manager.Inhibit("handle-lid-switch", ...)` inhibitor while enabled. This keeps logind from simultaneously applying its own lid policy. The returned Unix file descriptor is held for the lifetime of the extension and released when it is disabled. Power Guard never edits `/etc/systemd/logind.conf`, uses `sudo`, or runs `systemctl` for the main policy. If the inhibitor cannot be acquired, the item reports that lid handling is unavailable and no policy is claimed as active.

The extension observes `login1.Manager.LidClosed` and acts only on a false-to-true transition. Starting while the lid is already closed does not immediately run an action. D-Bus failures are handled without crashing GNOME Shell.

System policy and permissions can still reject a requested action. Hibernate and hybrid sleep may be unavailable even when the hardware appears to support them; unsupported capabilities are hidden from the menu.

## Persistence and preferences

The selected action is stored in GSettings and persists across reboot by default. The preferences window contains **Restore selected lid action on login** (enabled by default):

- Enabled: restore the stored action when the extension starts.
- Disabled: start this session with Do nothing while preserving the stored selection.

Selecting an action from Quick Settings updates the stored GSettings value. No custom state file is used.

## Installation

For a local installation, compile the schema and pack the extension:

```sh
glib-compile-schemas schemas
gnome-extensions pack . --force
```

Install the generated `power-guard@ilya.shell-extension.zip` using GNOME Extensions or copy the extension directory to:

```text
~/.local/share/gnome-shell/extensions/power-guard@ilya/
```

Then enable it with GNOME Extensions or:

```sh
gnome-extensions enable power-guard@ilya
```

The package targets GNOME Shell 50 and uses the GNOME 45+ JavaScript module APIs.

## Development and testing

Targeted checks used during development:

```sh
glib-compile-schemas schemas
node --check extension.js
node --check prefs.js
gnome-extensions pack . --force
```

A real laptop-lid test is still required to verify hardware UPower detection, the login1 inhibitor lifecycle, false-to-true transition behavior, lock-versus-suspend behavior, and the policy permissions available on a particular installation. Desktop/no-lid behavior and D-Bus error paths should also be checked in a GNOME Shell session.

## Limitations

- This is a per-user GNOME Shell policy and depends on system logind permissions.
- Hibernate, hybrid sleep, and other actions are available only when login1 reports the corresponding capability.
- The action runs only for a detected close transition; it is intentionally not run immediately for a lid that was already closed when the extension starts.
- The extension does not make system-wide logind configuration changes.
- No timer, fullscreen, MPRIS, idle-inhibition, or power-key functionality is included.
