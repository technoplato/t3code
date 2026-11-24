import type { ProviderQuotaLine } from "@t3tools/contracts";
import type { QuotaTone } from "@t3tools/client-runtime/provider-quota-remaining";
import { formatQuotaLine, type QuotaLineCopy } from "@t3tools/shared/usageLimitsCopy";
import { HistoryIcon } from "lucide-react";
import { useMessages } from "gt-react";
import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Epoch ms advancing each wall-clock minute, so countdowns and staleness stay current. */
export function useQuotaNow(): number {
  return Date.parse(`${useNowMinute()}:00Z`);
}

export function useQuotaCopy(): (line: ProviderQuotaLine, now: number) => QuotaLineCopy {
  const m = useMessages();
  return (line, now) => formatQuotaLine(line, now, m);
}

const fillClass = (remainingPercent: number) =>
  remainingPercent <= 10
    ? "bg-destructive"
    : remainingPercent <= 25
      ? "bg-warning"
      : "bg-foreground/45";

/**
 * A 2px meter along the bottom of a rail button. It is absolutely placed, so readings arriving
 * never move the rail; an unknown reading is a short muted dash.
 */
export function QuotaRailMeter(props: { readonly line: ProviderQuotaLine }) {
  const { line } = props;
  if (line._tag === "Unknown") {
    return (
      <span
        aria-hidden
        data-model-picker-quota="unknown"
        className="pointer-events-none absolute bottom-0.5 left-1/2 h-0.5 w-1.5 -translate-x-1/2 rounded-full bg-muted-foreground/35"
      />
    );
  }
  return (
    <span
      aria-hidden
      data-model-picker-quota={line._tag === "Exhausted" ? "exhausted" : "remaining"}
      data-model-picker-quota-stale={line.stale || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-foreground/10",
        line.stale && "opacity-40",
      )}
    >
      {line._tag === "Exhausted" ? (
        <span className="block h-full w-full rounded-full bg-destructive/70" />
      ) : (
        <span
          className={cn("block h-full rounded-full", fillClass(line.remainingPercent))}
          style={{ width: `${line.remainingPercent}%` }}
        />
      )}
    </span>
  );
}

/** "14% left" beside a model its login meters apart; the tooltip carries the window and reset. */
export function QuotaRowLabel(props: {
  readonly short: string;
  readonly full: string;
  readonly tone: QuotaTone;
  readonly stale: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-model-picker-model-quota={props.tone}
            className={cn(
              "flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground",
              props.tone === "exhausted" && "text-destructive-foreground",
              props.tone === "low" && "text-warning-foreground",
              props.stale && "opacity-60",
            )}
          >
            {props.stale ? <HistoryIcon className="size-3" aria-hidden /> : null}
            <span aria-hidden>{props.short}</span>
            <span className="sr-only">{props.full}</span>
          </span>
        }
      />
      <TooltipPopup side="top" align="center">
        {props.full}
      </TooltipPopup>
    </Tooltip>
  );
}
