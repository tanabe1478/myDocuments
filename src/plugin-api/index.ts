/**
 * 部品（プラグイン）の公開 API（v0）。部品は、このフォルダ（src/plugin-api/）の index だけを import する。
 * 設計の経緯と R1 で決めた細部は docs/decision-005-plugin-architecture.md。
 */
export { PLUGIN_API_VERSION } from './version';
export { AFTER_COMPOSITION_MS, ownsCaretScroll, skipCaretFollow } from './conventions';
export { frontmatterEndLine } from './frontmatter';
export { isBlankLine } from './lines';
export {
  HOST_APPEARANCE_ORDER,
  SETTINGS_PLACEMENTS,
  SETTINGS_PLACEMENT_KINDS,
  type ActionPlugin,
  type CheckboxSettingsItem,
  type CommandContext,
  type CommandRegistration,
  type EditorExtensionEnvironment,
  type EditorExtensionRegistration,
  type HostServices,
  type IsolatedCommandInfo,
  type IsolatedPluginHost,
  type IsolatedPluginListener,
  type Plugin,
  type PluginContext,
  type PluginManifest,
  type PluginTier,
  type RadioOption,
  type RadioSettingsItem,
  type SettingDefinition,
  type SettingHandle,
  type SettingsItemKind,
  type SettingsItemRegistration,
  type SettingsPlacement,
  type TextKind,
} from './types';
export { matchesShortcut, parseShortcut, type KeyEventLike, type ParsedShortcut } from './shortcut';
export {
  createPluginRegistry,
  type PluginRecord,
  type PluginRegistry,
  type PluginRegistryOptions,
  type PluginStatus,
  type RegisteredCommand,
  type RegisteredCheckboxItem,
  type RegisteredItemAt,
  type RegisteredEditorExtension,
  type RegisteredRadioItem,
  type RegisteredSettingsItem,
} from './registry';
