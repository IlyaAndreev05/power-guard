import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PowerGuardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Behavior',
        });
        const restoreRow = new Adw.SwitchRow({
            title: 'Restore selected lid action on login',
            subtitle: 'When disabled, this session starts with Do nothing while retaining the selected action.',
        });
        settings.bind('restore-state', restoreRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(restoreRow);
        page.add(group);
        window.add(page);
    }
}
