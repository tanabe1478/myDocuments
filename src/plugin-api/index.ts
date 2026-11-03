/**
 * 部品（プラグイン）の公開 API（v0）。部品は、このフォルダ（src/plugin-api/）の index だけを import する。
 * 設計の経緯と R1 で決めた細部は docs/decision-005-plugin-architecture.md。
 */
export { PLUGIN_API_VERSION } from './version';
export { ownsCaretScroll, skipCaretFollow } from './conventions';
export {
  SETTINGS_PLACEMENTS,
  type CommandContext,
  type CommandRegistration,
  type EditorExtensionRegistration,
  type Plugin,
  type PluginContext,
  type PluginManifest,
  type PluginTier,
  type SettingDefinition,
  type SettingHandle,
  type SettingsItemRegistration,
  type SettingsPlacement,
} from './types';
export { matchesShortcut, parseShortcut, type KeyEventLike, type ParsedShortcut } from './shortcut';
export {
  createPluginRegistry,
  type PluginRecord,
  type PluginRegistry,
  type PluginRegistryOptions,
  type PluginStatus,
  type RegisteredCommand,
  type RegisteredEditorExtension,
  type RegisteredSettingsItem,
} from './registry';
