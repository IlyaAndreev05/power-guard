import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const UPOWER_INTERFACE = 'org.freedesktop.UPower';
const LOGIN1_NAME = 'org.freedesktop.login1';
const LOGIN1_PATH = '/org/freedesktop/login1';
const LOGIN1_INTERFACE = 'org.freedesktop.login1.Manager';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const ACTION_KEY = 'lid-action';

const ACTIONS = [
    {id: 'ignore', label: 'Do nothing'},
    {id: 'lock', label: 'Lock screen'},
    {id: 'suspend', label: 'Sleep / Suspend', capability: 'CanSuspend', method: 'Suspend'},
    {id: 'hibernate', label: 'Hibernate', capability: 'CanHibernate', method: 'Hibernate'},
    {id: 'hybrid-sleep', label: 'Hybrid sleep', capability: 'CanHybridSleep', method: 'HybridSleep'},
    {id: 'suspend-then-hibernate', label: 'Suspend then hibernate', capability: 'CanSuspendThenHibernate', method: 'SuspendThenHibernate'},
    {id: 'power-off', label: 'Power off', capability: 'CanPowerOff', method: 'PowerOff'},
    {id: 'reboot', label: 'Reboot', capability: 'CanReboot', method: 'Reboot'},
];

function unpack(value) {
    return value instanceof GLib.Variant ? value.deepUnpack() : value;
}

function propertyValue(properties, name) {
    if (!properties || !(name in properties))
        return undefined;
    return unpack(properties[name]);
}

function capabilitySupported(value) {
    return value === true || value === 'yes' || value === 'challenge';
}

const LidService = GObject.registerClass({
    Signals: {
        'state-changed': {},
    },
}, class LidService extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._bus = null;
        this._signalId = 0;
        this._inhibitorFd = -1;
        this._inhibitorReady = false;
        this._inhibitorFdList = null;
        this._settings.connectObject(`changed::${ACTION_KEY}`, () => {
            if (!this._inhibitorReady)
                return;
            const selectedAction = this.selectedAction;
            this._activeAction = this.isSupported(selectedAction) ? selectedAction : 'ignore';
            this.emit('state-changed');
        }, this);
        this._activeAction = null;
        this._lastLidClosed = null;
        this._capabilities = {};
        this._hasLid = false;

        try {
            this._bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            const present = this._getProperty(UPOWER_NAME, UPOWER_PATH,
                UPOWER_INTERFACE, 'LidIsPresent');
            this._hasLid = present === true;
            if (!this._hasLid)
                return;

            for (const action of ACTIONS) {
                if (!action.capability)
                    continue;
                try {
                    this._capabilities[action.id] = this._queryCapability(action.capability);
                } catch (error) {
                    logError(error, `Unable to query ${action.capability}`);
                    this._capabilities[action.id] = false;
                }
            }
        } catch (error) {
            logError(error, 'Unable to inspect lid or login1 capabilities');
            this._hasLid = false;
        }
    }

    get hasLid() {
        return this._hasLid;
    }

    get capabilities() {
        return this._capabilities;
    }

    get selectedAction() {
        const value = this._settings.get_string(ACTION_KEY);
        return ACTIONS.some(action => action.id === value) ? value : 'ignore';
    }

    get activeAction() {
        return this._activeAction;
    }

    get inhibitorReady() {
        return this._inhibitorReady;
    }

    get subtitle() {
        if (!this._inhibitorReady)
            return 'Unavailable (lid handling unchanged)';
        return this._labelFor(this._activeAction ?? 'ignore');
    }

    isSupported(actionId) {
        const action = ACTIONS.find(candidate => candidate.id === actionId);
        return Boolean(action && (!action.capability || this._capabilities[actionId]));
    }

    start() {
        if (!this._hasLid || !this._bus)
            return;

        try {
            this._lastLidClosed = this._getProperty(LOGIN1_NAME, LOGIN1_PATH,
                LOGIN1_INTERFACE, 'LidClosed') === true;
            this._signalId = this._bus.signal_subscribe(
                LOGIN1_NAME,
                PROPERTIES_INTERFACE,
                'PropertiesChanged',
                LOGIN1_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _interface, _signal, parameters) =>
                    this._propertiesChanged(parameters));
        } catch (error) {
            logError(error, 'Unable to subscribe to login1 lid state');
            this._lastLidClosed = null;
        }

        try {
            const reply = this._bus.call_with_unix_fd_list_sync(
                LOGIN1_NAME,
                LOGIN1_PATH,
                LOGIN1_INTERFACE,
                'Inhibit',
                new GLib.Variant('(ssss)', [
                    'handle-lid-switch',
                    'Lid Action',
                    'Apply the selected lid-close policy',
                    'block',
                ]),
                new GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                5000,
                null,
                null);
            const handle = unpack(reply[0])[0];
            this._inhibitorFdList = reply[1];
            this._inhibitorFd = this._inhibitorFdList.get(handle);
            this._inhibitorReady = this._inhibitorFd >= 0;
        } catch (error) {
            logError(error, 'Unable to acquire lid-switch inhibitor');
            this._inhibitorReady = false;
        }

        if (this._inhibitorReady) {
            const storedAction = this.selectedAction;
            const restore = this._settings.get_boolean('restore-state');
            this._activeAction = restore && this.isSupported(storedAction) ? storedAction : 'ignore';
        }
        this.emit('state-changed');
    }

    selectAction(actionId) {
        if (!this.isSupported(actionId))
            return;
        this._settings.set_string(ACTION_KEY, actionId);
    }

    stop() {
        if (this._signalId && this._bus) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
        this._settings.disconnectObject(this);
        this._closeInhibitor();
        this._activeAction = null;
        this._bus = null;
    }

    _closeInhibitor() {
        if (this._inhibitorFd >= 0) {
            try {
                GLib.close(this._inhibitorFd);
            } catch (error) {
                logError(error, 'Unable to close lid-switch inhibitor');
            }
        }
        this._inhibitorFd = -1;
        this._inhibitorFdList = null;
        this._inhibitorReady = false;
    }

    _getProperty(busName, objectPath, interfaceName, propertyName) {
        const reply = this._bus.call_sync(
            busName,
            objectPath,
            PROPERTIES_INTERFACE,
            'Get',
            new GLib.Variant('(ss)', [interfaceName, propertyName]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            3000,
            null);
        return unpack(unpack(reply)[0]);
    }

    _queryCapability(methodName) {
        const reply = this._bus.call_sync(
            LOGIN1_NAME,
            LOGIN1_PATH,
            LOGIN1_INTERFACE,
            methodName,
            null,
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            3000,
            null);
        return capabilitySupported(unpack(reply)[0]);
    }

    _propertiesChanged(parameters) {
        try {
            const [interfaceName, changed] = unpack(parameters);
            if (interfaceName !== LOGIN1_INTERFACE || !changed || !('LidClosed' in changed))
                return;
            const lidClosed = propertyValue(changed, 'LidClosed') === true;
            const wasClosed = this._lastLidClosed === true;
            this._lastLidClosed = lidClosed;
            if (!wasClosed && lidClosed)
                this._runAction();
        } catch (error) {
            logError(error, 'Unable to process login1 lid state');
        }
    }

    _runAction() {
        if (!this._inhibitorReady || !this._activeAction || this._activeAction === 'ignore')
            return;
        if (this._activeAction === 'lock') {
            try {
                Main.screenShield.lock(false);
            } catch (error) {
                logError(error, 'Unable to lock the current GNOME session');
            }
            return;
        }

        const action = ACTIONS.find(candidate => candidate.id === this._activeAction);
        if (!action?.method)
            return;
        try {
            this._bus.call(
                LOGIN1_NAME,
                LOGIN1_PATH,
                LOGIN1_INTERFACE,
                action.method,
                new GLib.Variant('(b)', [true]),
                null,
                Gio.DBusCallFlags.NONE,
                5000,
                null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch (error) {
                        logError(error, `Unable to execute lid action ${action.id}`);
                    }
                });
        } catch (error) {
            logError(error, `Unable to request lid action ${action.id}`);
        }
    }

    _labelFor(actionId) {
        return ACTIONS.find(action => action.id === actionId)?.label ?? 'Do nothing';
    }
});

const LidActionToggle = GObject.registerClass(class LidActionToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, service) {
        super._init({
            title: 'Lid Action',
            toggleMode: false,
        });
        this._extension = extension;
        this._service = service;
        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);
        this._items = new Map();
        this.gicon = Gio.ThemedIcon.new('system-shutdown-symbolic');
        this._rebuildMenu();
        this._syncMenu();
        service.connectObject('state-changed', () => this._syncMenu(), this);
        this.connect('destroy', () => {
            service.disconnectObject(this);
            this._items.clear();
        });
    }

    _rebuildMenu() {
        this._itemsSection.removeAll();
        this._items.clear();
        for (const action of ACTIONS) {
            if (!this._service.isSupported(action.id))
                continue;
            const item = new PopupMenu.PopupMenuItem(action.label);
            item.connectObject('activate', () => this._service.selectAction(action.id), this);
            this._itemsSection.addMenuItem(item);
            this._items.set(action.id, item);
        }
    }

    _syncMenu() {
        this.menu.setHeader('system-shutdown-symbolic', 'Lid Action', this._service.subtitle);
        const selectedAction = this._service.selectedAction;
        const canShowSelection = this._service.inhibitorReady;
        for (const [actionId, item] of this._items)
            item.setOrnament(canShowSelection && actionId === selectedAction
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
    }
});

const LidActionIndicator = GObject.registerClass(class LidActionIndicator extends QuickSettings.SystemIndicator {
    _init(extension, service) {
        super._init();
        this._toggle = new LidActionToggle(extension, service);
        this.quickSettingsItems.push(this._toggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export default class PowerGuardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new LidService(this._settings);
        if (!this._service.hasLid) {
            this._service.stop();
            this._service = null;
            return;
        }
        this._indicator = new LidActionIndicator(this, this._service);
        this._service.start();
    }

    disable() {
        this._service?.stop();
        this._indicator?.destroy();
        this._indicator = null;
        this._service = null;
        this._settings = null;
    }
}
