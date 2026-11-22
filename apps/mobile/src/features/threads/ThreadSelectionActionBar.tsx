import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useGT, useMessages } from "gt-react-native";
import { useMemo, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { Menu } from "../../components/ui/Menu";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { cn } from "../../lib/cn";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import {
  useDeviceType,
  useDuoBottomBarInset,
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { workspaceSearchBottomClearance } from "../layout/workspace/workspace-tabs-state";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import type { BulkThreadActionTargets } from "./threadMultiSelect";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "./threadListV2";

export function ThreadSelectionActionBar(props: {
  readonly visible: boolean;
  readonly targets: BulkThreadActionTargets;
  readonly allVisibleThreadKeys: ReadonlyArray<string>;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly snoozePresetMinute: string;
  readonly onSelectAll: (threadKeys: ReadonlyArray<string>) => void;
  readonly onSnoozeThreads: (
    threads: ReadonlyArray<EnvironmentThreadShell>,
    snoozedUntil: string,
  ) => Promise<number>;
  readonly onUnsnoozeThreads: (threads: ReadonlyArray<EnvironmentThreadShell>) => Promise<number>;
  readonly onSettleThreads: (threads: ReadonlyArray<EnvironmentThreadShell>) => Promise<number>;
  readonly onUnsettleThreads: (threads: ReadonlyArray<EnvironmentThreadShell>) => Promise<number>;
  readonly onMarkThreadsUnread: (threads: ReadonlyArray<EnvironmentThreadShell>) => Promise<number>;
  readonly onDeleteThreads: (
    threads: ReadonlyArray<EnvironmentThreadShell>,
    onConfirmed?: () => void,
  ) => void;
  readonly onExit: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { colorScheme } = useControlTheme();
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const rootMetrics = useNativeLayoutMetrics();
  const workspace = useWorkspaceTabs();
  const deviceType = useDeviceType();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const duoBottomBarInset = useDuoBottomBarInset();
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);

  const {
    selectedThreads,
    snoozableThreads,
    unsnoozableThreads,
    settlableThreads,
    unsettlableThreads,
  } = props.targets;
  const selectedCount = selectedThreads.length;

  const snoozePresets = useMemo(
    () =>
      resolveThreadListV2SnoozePresets(
        {
          secondary: snoozableThreads.length > 0 ? "snooze" : null,
          now: props.snoozePresetMinute,
          presets: props.snoozePresets,
        },
        m,
      ),
    [m, props.snoozePresetMinute, props.snoozePresets, snoozableThreads.length],
  );

  const snoozeMenuActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: gt("Custom…", { $context: "custom snooze time" }) },
    ],
    [gt, snoozePresets],
  );

  const moreMenuActions = useMemo<MenuAction[]>(() => {
    const actions: MenuAction[] = [];
    if (props.allVisibleThreadKeys.length > 0) {
      actions.push({
        id: "select-all",
        title: gt("Select all visible"),
        image: "checkmark.circle",
      });
    }
    if (unsnoozableThreads.length > 0) {
      actions.push({
        id: "unsnooze",
        title: gt("Wake ({count})", { count: unsnoozableThreads.length }),
        image: "clock",
      });
    }
    if (unsettlableThreads.length > 0) {
      actions.push({
        id: "unsettle",
        title: gt("Un-settle ({count})", { count: unsettlableThreads.length }),
        image: "arrow.uturn.backward",
      });
    }
    if (selectedCount > 0) {
      actions.push({
        id: "mark-unread",
        title: gt("Mark unread ({count})", { count: selectedCount }),
        image: "envelope.badge",
      });
      actions.push({
        id: "delete",
        title: gt("Delete ({count})", { count: selectedCount }),
        image: "trash",
        attributes: { destructive: true },
      });
    }
    return actions;
  }, [
    gt,
    props.allVisibleThreadKeys.length,
    selectedCount,
    unsettlableThreads.length,
    unsnoozableThreads.length,
  ]);

  if (!props.visible) return null;

  const horizontalInsets =
    Platform.OS === "ios"
      ? deviceType === "phone"
        ? { left: 16, right: 16 }
        : { left: 12, right: 12 }
      : { left: 12, right: 12 };
  const workspacePadding =
    duoBottomBarInset === undefined
      ? deviceType === "phone" && keyboardHeight === 0
        ? 32
        : 16
      : 8;
  const foldedResting =
    rootMetrics?.hasHinge &&
    rootMetrics.horizontalSizeClass === "compact" &&
    workspace?.state.tabs.threads.searchMode === "resting";
  const bottom =
    Platform.OS === "ios"
      ? foldedResting
        ? Math.max(
            rootMetrics.bottomBarInset ?? rootMetrics.safeArea.bottom + 8,
            keyboardHeight + 8,
          )
        : rootMetrics?.hasHinge && rootMetrics.verticalBarEdge !== "none"
          ? workspaceSearchBottomClearance({
              bottomInset: rootMetrics.safeArea.bottom,
              bottomBarInset: rootMetrics.bottomBarInset,
              keyboardHeight,
            }) -
            16 +
            8
          : Math.max(
              insets.bottom,
              columnMetrics?.safeArea.bottom ?? 0,
              (workspace?.bottomClearance ?? 0) - workspacePadding,
            ) + 8
      : floatingTabsEnabled && keyboardHeight === 0
        ? Math.max(insets.bottom + 12, workspace?.bottomClearance ?? 0)
        : insets.bottom + 12;

  const borderRadius = Platform.OS === "ios" ? 28 : MOBILE_SHAPE.toast;

  const handleSnoozeMenuAction = ({
    nativeEvent,
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    if (nativeEvent.event === "snooze:custom") {
      setCustomSnoozeOpen(true);
      return;
    }
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: nativeEvent.event,
      displayedPresets: snoozePresets,
      now: new Date(),
      presets: props.snoozePresets,
    });
    if (selection._tag === "selected") {
      const targets = snoozableThreads;
      props.onExit();
      void props.onSnoozeThreads(targets, selection.preset.snoozedUntil);
    } else if (selection._tag === "expired") {
      Dialog.alert(
        gt("Could not snooze threads"),
        gt("That snooze time has passed. Choose another time."),
      );
    }
  };

  const handleMoreMenuAction = ({
    nativeEvent,
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    if (nativeEvent.event === "select-all") {
      props.onSelectAll(props.allVisibleThreadKeys);
      return;
    }
    if (nativeEvent.event === "unsnooze") {
      const targets = unsnoozableThreads;
      props.onExit();
      void props.onUnsnoozeThreads(targets);
      return;
    }
    if (nativeEvent.event === "unsettle") {
      const targets = unsettlableThreads;
      props.onExit();
      void props.onUnsettleThreads(targets);
      return;
    }
    if (nativeEvent.event === "mark-unread") {
      const targets = selectedThreads;
      props.onExit();
      void props.onMarkThreadsUnread(targets);
      return;
    }
    if (nativeEvent.event === "delete") {
      props.onDeleteThreads(selectedThreads, props.onExit);
    }
  };

  const canSnooze = snoozableThreads.length > 0;
  const canSettle = settlableThreads.length > 0;

  return (
    <>
      {customSnoozeOpen ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeOpen(false)}
          onSnooze={(snoozedUntil) => {
            const targets = snoozableThreads;
            setCustomSnoozeOpen(false);
            props.onExit();
            void props.onSnoozeThreads(targets, snoozedUntil);
          }}
        />
      ) : null}
      <View
        collapsable={false}
        className="absolute z-[110]"
        style={{ bottom, ...horizontalInsets }}
        pointerEvents="box-none"
      >
        <GlassSurface
          chrome={Platform.OS === "ios" && colorScheme === "dark" ? "none" : undefined}
          tintColor={Platform.OS === "ios" ? null : undefined}
          className={Platform.OS === "ios" ? "bg-transparent px-3 py-2" : "px-3 py-2.5"}
          style={{ borderRadius }}
        >
          <View className="flex-row items-center gap-2">
            <View className="min-w-0 flex-1 pl-1">
              <AppText textRole="footnote" className="font-t3-semibold" numberOfLines={1}>
                {selectedCount > 0
                  ? gt("{count} selected", { count: selectedCount })
                  : gt("Select threads")}
              </AppText>
            </View>

            {canSnooze ? (
              <Menu
                title={gt("Snooze ({count})", { count: snoozableThreads.length })}
                actions={snoozeMenuActions}
                onPressAction={handleSnoozeMenuAction}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("Snooze selected threads")}
                  className="flex-row items-center gap-1.5 rounded-full bg-primary px-3 py-1.5"
                  style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
                >
                  <SymbolView
                    name="clock"
                    size={14}
                    tintColorClassName="accent-primary-foreground"
                  />
                  <AppText textRole="footnote" className="font-t3-semibold text-primary-foreground">
                    {gt("Snooze", { $context: "verb, snooze selected threads" })}
                  </AppText>
                </Pressable>
              </Menu>
            ) : (
              <View className="flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-1.5 opacity-45">
                <SymbolView name="clock" size={14} tintColorClassName="accent-foreground-muted" />
                <AppText textRole="footnote" className="font-t3-medium text-foreground-muted">
                  {gt("Snooze", { $context: "verb, snooze selected threads" })}
                </AppText>
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Settle selected threads")}
              accessibilityState={{ disabled: !canSettle }}
              disabled={!canSettle}
              onPress={() => {
                if (!canSettle) return;
                const targets = settlableThreads;
                props.onExit();
                void props.onSettleThreads(targets);
              }}
              className={cn(
                "flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-1.5",
                !canSettle && "opacity-45",
              )}
              style={({ pressed }) => ({ opacity: canSettle && pressed ? 0.7 : undefined })}
            >
              <SymbolView
                name="checkmark.circle"
                size={14}
                tintColorClassName={canSettle ? "accent-foreground" : "accent-foreground-muted"}
              />
              <AppText
                textRole="footnote"
                className={cn(
                  "font-t3-medium",
                  canSettle ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {gt("Settle", { $context: "verb, settle selected threads" })}
              </AppText>
            </Pressable>

            {moreMenuActions.length > 0 ? (
              <Menu actions={moreMenuActions} onPressAction={handleMoreMenuAction}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("More selection actions")}
                  className="h-8 w-8 items-center justify-center rounded-full bg-subtle"
                  style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
                >
                  <SymbolView name="ellipsis.circle" size={17} tintColorClassName="accent-icon" />
                </Pressable>
              </Menu>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Exit selection mode")}
              onPress={props.onExit}
              className="h-8 w-8 items-center justify-center rounded-full bg-subtle"
              style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
            >
              <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
        </GlassSurface>
      </View>
    </>
  );
}
