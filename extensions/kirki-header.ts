import { homedir } from "node:os";
import { sep } from "node:path";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  parseColor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const LOGO = [
  "██╗  ██╗██╗██████╗ ██╗  ██╗██╗",
  "██║ ██╔╝██║██╔══██╗██║ ██╔╝██║",
  "█████╔╝ ██║██████╔╝█████╔╝ ██║",
  "██╔═██╗ ██║██╔══██╗██╔═██╗ ██║",
  "██║  ██╗██║██║  ██║██║  ██╗██║",
  "╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝",
];
const LOGO_WIDTH = Math.max(...LOGO.map(visibleWidth));
const ORANGE = parseColor("#e99963");
const DARK_ORANGE = parseColor("#a94c1c");
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const COMMANDS_FULL = "/model  switch model    /resume  sessions    /help  help";
const COMMANDS_COMPACT = "/model · /resume · /help";
const COMMANDS_SHORT = "/help";
const COMMANDS_FULL_WIDTH = visibleWidth(COMMANDS_FULL);
const COMMANDS_COMPACT_WIDTH = visibleWidth(COMMANDS_COMPACT);

// Metadata is plain text: never allow paths or model names to inject terminal controls.
function clean(text: string): string {
  return stripTerminalSequences(text).replace(CONTROL_CHARS, " ");
}

function directory(cwd: string): string {
  const home = homedir();
  return clean(cwd === home ? "~" : cwd.startsWith(home + sep) ? "~" + cwd.slice(home.length) : cwd);
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

interface HeaderData {
  cwd: string;
  model: string;
}

function renderHeader(width: number, theme: Theme, data: HeaderData): string[] {
  const columns = Math.max(0, Math.min(78, Math.floor(width)));
  const orange = (text: string) => theme.style(text, {
    fg: theme.appearance === "light" ? DARK_ORANGE : ORANGE,
    bold: true,
  });
  const muted = (text: string) => theme.fg("muted", text);
  const border = (text: string) => theme.fg("dim", text);

  // A framed panel is not useful at exceptionally small widths.
  if (columns < 12) return [truncateToWidth(orange("Kirki"), columns, "")];

  const inner = columns - 2;
  const padding = inner >= 36 ? 2 : 1;
  const contentWidth = inner - padding * 2;
  const edge = (left: string, right: string) => border(left + "─".repeat(inner) + right);
  const row = (text = "") => border("│") + " ".repeat(padding)
    + fit(text, contentWidth) + " ".repeat(padding) + border("│");
  const lines = [edge("╭", "╮"), row()];
  const title = orange("Kirki");
  const path = theme.fg("text", data.cwd);
  const model = muted(data.model);
  const version = muted(`v${VERSION}`);

  if (contentWidth >= LOGO_WIDTH + 3 + 24) {
    const details = [title, "", path, model, "", version];
    const detailWidth = contentWidth - LOGO_WIDTH - 3;
    for (let index = 0; index < LOGO.length; index++) {
      lines.push(row(orange(fit(LOGO[index], LOGO_WIDTH)) + "   " + fit(details[index], detailWidth)));
    }
  } else {
    if (contentWidth >= LOGO_WIDTH) {
      for (const line of LOGO) lines.push(row(orange(line)));
      lines.push(row());
    } else {
      lines.push(row(title));
    }
    lines.push(row(path), row(model), row(version));
  }

  lines.push(row(), edge("├", "┤"));
  if (COMMANDS_FULL_WIDTH <= contentWidth) {
    lines.push(row(muted(COMMANDS_FULL)));
  } else if (contentWidth >= COMMANDS_COMPACT_WIDTH) {
    lines.push(row(muted(COMMANDS_COMPACT)));
  } else {
    lines.push(row(muted(COMMANDS_SHORT)));
  }
  lines.push(edge("╰", "╯"));
  return lines;
}

export default function kirkiHeader(pi: ExtensionAPI) {
  let enabled = true;
  let requestRender: (() => void) | undefined;
  let data: HeaderData = { cwd: "", model: "No model selected" };

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !enabled) return;
    data = {
      cwd: directory(ctx.cwd),
      model: ctx.model ? clean(`${ctx.model.id} · ${ctx.model.provider}`) : "No model selected",
    };
    ctx.ui.setHeader((tui, theme) => {
      const refresh = () => tui.requestRender();
      requestRender = refresh;
      let cachedWidth = -1;
      let cachedData: HeaderData | undefined;
      let cachedLines: string[] | undefined;
      return {
        render(width: number) {
          if (cachedLines && cachedWidth === width && cachedData === data) return cachedLines;
          cachedLines = renderHeader(width, theme, data);
          cachedWidth = width;
          cachedData = data;
          return cachedLines;
        },
        // Theme changes invalidate this cache; styling is evaluated in renderHeader.
        invalidate() {
          cachedLines = undefined;
          cachedData = undefined;
        },
        dispose() {
          if (requestRender === refresh) requestRender = undefined;
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("model_select", (event, _ctx) => {
    data = {
      ...data,
      model: clean(`${event.model.id} · ${event.model.provider}`),
    };
    requestRender?.();
  });
  pi.on("session_shutdown", () => { requestRender = undefined; });

  pi.registerCommand("kirki-header", {
    description: "Toggle the Kirki welcome banner (on/off)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const option = args.trim().toLowerCase();
      if (option && option !== "on" && option !== "off") {
        ctx.ui.notify("Usage: /kirki-header [on|off]", "warning");
        return;
      }
      enabled = option ? option === "on" : !enabled;
      if (enabled) install(ctx);
      else ctx.ui.setHeader(undefined);
    },
  });
}
