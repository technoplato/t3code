import { threadKey } from "@t3tools/client-runtime/state/entities";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { HistoryIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { cn } from "../../lib/utils";
import {
  useAnyEnvironmentHiding,
  useHiddenThreadKeys,
  useProjects,
  useQuietThreadShells,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  EMPTY_THREAD_NAVIGATION_HISTORY,
  resolveThreadHistoryRows,
  THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
  ThreadNavigationHistory,
} from "../../threadNavigationHistory";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironmentLookups } from "../CommandPaletteLookups";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ThreadHistoryMenuButton({ onBackdrop }: { onBackdrop: boolean }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const label = gt("History", { $context: "button that lists recently opened threads" });
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label={label}
                  className={cn(
                    "[-webkit-app-region:no-drag]",
                    onBackdrop && "relative top-auto translate-y-0",
                  )}
                  size="icon-sm"
                  variant={onBackdrop ? "media-navigation" : "ghost"}
                />
              }
            />
          }
        >
          <HistoryIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      {/* The popup unmounts while closed, so a closed header reads no history and no threads. */}
      <MenuPopup align="start" className="w-72">
        <ThreadHistoryMenuContent />
      </MenuPopup>
    </Menu>
  );
}

function ThreadHistoryMenuContent() {
  const navigate = useNavigate();
  const [history] = useLocalStorage(
    THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
    EMPTY_THREAD_NAVIGATION_HISTORY,
    ThreadNavigationHistory,
  );
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const rows = resolveThreadHistoryRows({
    history,
    shells: useQuietThreadShells(),
    hiddenThreadKeys: useHiddenThreadKeys(),
    hidingAnywhere: useAnyEnvironmentHiding(),
    currentThread: useThreadRouteRef(),
  });

  if (rows.length === 0) {
    return (
      <div className="px-2 py-1.5 text-muted-foreground text-xs">
        <T>No thread history yet</T>
      </div>
    );
  }

  return rows.map((row) => {
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === row.environmentId && candidate.id === row.projectId,
      ) ?? null;
    const context = [
      project?.title,
      // One environment needs no naming.
      environments.length > 1 ? projectEnvironmentLocationById.get(row.environmentId)?.label : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <MenuItem
        key={threadKey(row)}
        onClick={() =>
          void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(row) })
        }
      >
        {project ? (
          <ProjectFavicon project={project} className="size-4 shrink-0" />
        ) : (
          <MessageSquareIcon aria-hidden />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <MenuItemLabel>{row.title}</MenuItemLabel>
          {context ? (
            <span className="truncate text-muted-foreground text-xs">{context}</span>
          ) : null}
        </span>
      </MenuItem>
    );
  });
}
