import type { WorkLogScrollHeight } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolveReasoningMaxHeightCss,
  setCustomWorkLogScrollHeightPx,
  useCustomWorkLogScrollHeightPx,
} from "./workLogScrollHeight";

const GroupedRows = createContext(false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
};

function WorkLogLine({ icon, label, trailing, wrapLabel }: RowContent) {
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
        wrapLabel ? "items-start" : "items-center",
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon ? (
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 flex-1 text-secondary-label",
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
  );
}

export function WorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
    </button>
  );
}

/** Div disclosure permits selectable detail and nested actions. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const className = useRowClassName(rowProps.onClick !== undefined);
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
      {children}
    </div>
  );
}

const LIVE_EDGE_PX = 4;

export function WorkLogResizeHandle({
  getTargetElement,
  offsetPx = 0,
  className,
}: {
  getTargetElement: () => HTMLElement | null;
  offsetPx?: number;
  className?: string;
}) {
  const gt = useGT();
  const dragRef = useRef<{ pointerId: number; startY: number; startBaseHeight: number } | null>(
    null,
  );
  const label = gt("Drag to resize · Double-click to reset");

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const target = getTargetElement();
    if (!target) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startBaseHeight: Math.max(0, target.getBoundingClientRect().height - offsetPx),
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    setCustomWorkLogScrollHeightPx(drag.startBaseHeight + (event.clientY - drag.startY));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={label}
            data-work-log-resize-handle
            className={cn(
              "group/resize flex h-3 w-full cursor-ns-resize touch-none items-center justify-center select-none",
              className,
            )}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setCustomWorkLogScrollHeightPx(null);
            }}
          />
        }
      >
        <span className="h-0.5 w-10 rounded-full bg-border/60 transition-colors group-hover/resize:bg-muted-foreground/70" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
  scrollHeight = "default",
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";
  followLive?: boolean;
  scrollHeight?: WorkLogScrollHeight;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  const customHeightPx = useCustomWorkLogScrollHeightPx();
  const textMaxHeight =
    kind === "text" ? resolveReasoningMaxHeightCss(scrollHeight, customHeightPx) : undefined;
  const isCappedText = kind === "text" && textMaxHeight !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the scroller's scrollTop to the bottom after each commit while following live output
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && isCappedText && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        ref={scrollerRef}
        onScroll={
          isCappedText
            ? (event) => {
                const { scrollHeight: totalHeight, scrollTop, clientHeight } = event.currentTarget;
                atLiveEdgeRef.current = totalHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
              }
            : undefined
        }
        style={textMaxHeight ? { maxHeight: textMaxHeight } : undefined}
        className={cn(
          "cursor-auto",
          kind === "text"
            ? isCappedText
              ? "ms-7 flex flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
              : "ms-7 flex flex-col gap-3 px-0.5 py-1 select-text"
            : kind === "panel"
              ? "mt-0.5 mb-1.5 pb-2"
              : "mt-1",
        )}
      >
        {children}
      </div>
      {isCappedText ? (
        <WorkLogResizeHandle getTargetElement={() => scrollerRef.current} className="ms-7 w-auto" />
      ) : null}
    </div>
  );
}
