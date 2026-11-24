import { msg, T, useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import type { ToolCallVisibility, WorkLogScrollHeight } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { EXPAND_THINKING_BY_DEFAULT } from "../../../../persistence/mobile-preferences";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

const TOOL_CALL_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: ToolCallVisibility;
  readonly label: string;
}> = [
  { value: "showAll", label: msg("Show all") },
  { value: "hideSuccessful", label: msg("Hide successful") },
  { value: "hideAll", label: msg("Hide all") },
  { value: "zen", label: msg("Zen", { $context: "tool call visibility: only final answers" }) },
];

const WORK_LOG_SCROLL_HEIGHT_OPTIONS: ReadonlyArray<{
  readonly value: WorkLogScrollHeight;
  readonly label: string;
}> = [
  { value: "default", label: msg("Default") },
  { value: "tall", label: msg("Tall") },
  { value: "full", label: msg("Full (no scroll box)") },
];

export function ToolCallsAppearanceSection() {
  const gt = useGT();
  const m = useMessages();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const selected = loaded ? (preferences.value.toolCallVisibility ?? "showAll") : null;
  const expandThinkingByDefault = loaded
    ? (preferences.value.expandThinkingByDefault ?? EXPAND_THINKING_BY_DEFAULT)
    : false;
  const expandToolCallsByDefault = loaded
    ? (preferences.value.expandToolCallsByDefault ?? false)
    : false;
  const workLogScrollHeight = loaded ? (preferences.value.workLogScrollHeight ?? "default") : null;

  return (
    <View className="gap-4">
      <View className="gap-2">
        <SettingsSection title={gt("Tool calls in chat")}>
          {TOOL_CALL_VISIBILITY_OPTIONS.map((option, index) => (
            <ListChoiceRow
              key={option.value}
              label={m(option.label)}
              selected={selected === option.value}
              separated={index > 0}
              disabled={selected === null}
              onPress={() => {
                void savePreferences({ toolCallVisibility: option.value });
              }}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          <T>
            Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen
            shows only final answers. Approvals, questions, and errors always show.
          </T>
        </Text>
      </View>

      <View className="gap-2">
        <SettingsSection title={gt("Default expansion")}>
          <SettingsSwitchRow
            label={gt("Expand thinking by default")}
            subtitle={gt("Open agent thinking and reasoning traces automatically")}
            value={expandThinkingByDefault}
            disabled={!loaded}
            onValueChange={(value) => {
              void savePreferences({ expandThinkingByDefault: value });
            }}
          />
          <SettingsSwitchRow
            label={gt("Expand tool calls by default")}
            subtitle={gt("Open tool call groups and completed turn summaries automatically")}
            value={expandToolCallsByDefault}
            disabled={!loaded}
            onValueChange={(value) => {
              void savePreferences({ expandToolCallsByDefault: value });
            }}
          />
        </SettingsSection>
      </View>

      <View className="gap-2">
        <SettingsSection title={gt("Activity scroll box height")}>
          {WORK_LOG_SCROLL_HEIGHT_OPTIONS.map((option, index) => (
            <ListChoiceRow
              key={option.value}
              label={m(option.label)}
              selected={workLogScrollHeight === option.value}
              separated={index > 0}
              disabled={workLogScrollHeight === null}
              onPress={() => {
                void savePreferences({ workLogScrollHeight: option.value });
              }}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          <T>
            Control how tall expanded thinking and tool call scroll boxes grow. Choose Full to read
            thinking and tool activity inline without an inner scroll box.
          </T>
        </Text>
      </View>
    </View>
  );
}
