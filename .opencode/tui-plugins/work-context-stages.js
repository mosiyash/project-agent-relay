// TUI integration stays in the installed package; do not copy src/ or tools.
import { createSignal } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import plugin from "opencode-work-context/tui";

export default {
  ...plugin,
  async tui(api, options) {
    return plugin.tui(api, {
      ...options,
      runtime: { createSignal, jsx },
    });
  },
};
