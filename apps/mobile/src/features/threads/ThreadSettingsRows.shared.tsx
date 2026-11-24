import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import type { ModelOption } from "../../lib/modelOptions";
import type { QuotaTone } from "@t3tools/client-runtime/provider-quota-remaining";

/** A quota line as a row shows it: short text, the whole line for VoiceOver, and how loud. */
export type QuotaBadge = {
  readonly short: string;
  readonly full: string;
  readonly tone: QuotaTone;
  readonly stale: boolean;
};

/** Short quota text; stale readings get a clock and dim, spent ones read red. */
export function QuotaBadgeText(props: { readonly quota: QuotaBadge }) {
  const { quota } = props;
  return (
    <View className={cn("flex-row items-center gap-0.5", quota.stale && "opacity-60")}>
      {quota.stale ? (
        <SymbolView
          name="clock"
          size={10}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn(
          "text-2xs font-t3-medium text-foreground-muted",
          quota.tone === "exhausted" && "text-danger-foreground",
          quota.tone === "low" && "text-warning-foreground",
        )}
        numberOfLines={1}
      >
        {quota.short}
      </Text>
    </View>
  );
}

export type ModelRowProps = {
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isFavorite: boolean;
  readonly favoritesLoaded: boolean;
  readonly onToggleFavorite: () => void;
  readonly onToggleHidden?: () => void;
  readonly hiddenUpdatePending?: boolean;
  /** Only for a model its login meters apart, such as Fable's own week. */
  readonly quota?: QuotaBadge | undefined;
  readonly isFirst: boolean;
  readonly isLast: boolean;
};

export type ChoiceRowProps = {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly isLast: boolean;
};

type RowSelectionProps = {
  readonly leadingSelection?: ReactNode;
  readonly trailingSelection?: ReactNode;
  readonly minimumHeight?: number;
};

export function ModelRowContent(
  props: ModelRowProps &
    RowSelectionProps & {
      readonly labelNumberOfLines: number;
      readonly selectedClassName?: string;
    },
) {
  const gt = useGT();
  return (
    <View
      style={props.minimumHeight === undefined ? undefined : { minHeight: props.minimumHeight }}
      className={cn(
        "mx-4 min-h-[44px] flex-row items-center gap-2 bg-grouped-card px-4 android:min-h-[48px]",
        props.selectedClassName,
        props.isFirst && "rounded-t-2xl",
        props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
      )}
    >
      <Pressable
        accessibilityLabel={[props.option.label, props.option.subtitle, props.quota?.full]
          .filter(Boolean)
          .join(", ")}
        accessibilityRole="radio"
        accessibilityState={{
          checked: props.selected,
          disabled: props.option.isUnavailable === true || props.option.isHidden === true,
        }}
        className="min-h-[44px] min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70 android:min-h-[48px]"
        disabled={props.option.isUnavailable || props.option.isHidden}
        onPress={props.onPress}
      >
        {props.leadingSelection}
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Text
              className="min-w-0 shrink text-base font-t3-medium text-foreground"
              numberOfLines={props.labelNumberOfLines}
            >
              {props.option.label}
            </Text>
            {props.option.isDefault ? (
              <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
                <Text className="text-3xs font-t3-bold text-foreground-muted">
                  {gt("Default", { $context: "badge on the default model" })}
                </Text>
              </View>
            ) : null}
            {props.option.isLegacy ? (
              <View className="rounded-md bg-subtle px-1.5 py-0.5">
                <Text className="text-3xs font-t3-bold text-foreground-muted">
                  {gt("Legacy", { $context: "badge on an older model" })}
                </Text>
              </View>
            ) : null}
            {props.option.isHidden ? (
              <Text className="text-xs text-foreground-muted">
                {gt("Hidden", { $context: "model is hidden from the picker" })}
              </Text>
            ) : null}
            {props.option.isUnavailable ? (
              <Text className="text-xs text-foreground">
                {gt("Unavailable", { $context: "model cannot be used" })}
              </Text>
            ) : null}
          </View>
          {props.option.subtitle ? (
            <Text
              className="text-xs text-foreground-muted"
              numberOfLines={props.labelNumberOfLines}
            >
              {props.option.subtitle}
            </Text>
          ) : null}
        </View>
        {props.quota ? <QuotaBadgeText quota={props.quota} /> : null}
        {props.trailingSelection}
      </Pressable>
      {props.onToggleHidden ? (
        <Pressable
          accessibilityLabel={
            props.option.isHidden
              ? gt("Show model: {provider}, {model}", {
                  provider: props.option.providerLabel,
                  model: props.option.label,
                })
              : gt("Hide model: {provider}, {model}", {
                  provider: props.option.providerLabel,
                  model: props.option.label,
                })
          }
          accessibilityRole="button"
          accessibilityState={{ disabled: props.hiddenUpdatePending === true }}
          className="min-h-[44px] min-w-[44px] items-center justify-center android:min-h-[48px] android:min-w-[48px]"
          disabled={props.hiddenUpdatePending}
          onPress={props.onToggleHidden}
        >
          <SymbolView
            name={props.option.isHidden ? "eye.slash" : "eye"}
            size={18}
            tintColorClassName={props.option.isHidden ? "accent-icon-subtle" : "accent-icon"}
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel={
          props.isFavorite
            ? gt("Remove from favorites: {provider}, {model}", {
                provider: props.option.providerLabel,
                model: props.option.label,
              })
            : gt("Add to favorites: {provider}, {model}", {
                provider: props.option.providerLabel,
                model: props.option.label,
              })
        }
        accessibilityRole="button"
        accessibilityState={{ disabled: !props.favoritesLoaded, selected: props.isFavorite }}
        className="min-h-[44px] min-w-[44px] items-center justify-center android:min-h-[48px] android:min-w-[48px]"
        disabled={!props.favoritesLoaded}
        onPress={props.onToggleFavorite}
      >
        <SymbolView
          name={props.isFavorite ? "star.fill" : "star"}
          size={18}
          tintColorClassName={props.isFavorite ? "accent-icon" : "accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

export function ChoiceRowContent(props: ChoiceRowProps & RowSelectionProps) {
  return (
    <Pressable
      accessibilityLabel={props.description ? `${props.label}. ${props.description}` : props.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={props.minimumHeight === undefined ? undefined : { minHeight: props.minimumHeight }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      {props.leadingSelection}
      <View className={cn("min-w-0 flex-1 gap-0.5", props.disabled && "opacity-50")}>
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-5 text-foreground-muted">{props.description}</Text>
        ) : null}
      </View>
      {props.trailingSelection}
    </Pressable>
  );
}
