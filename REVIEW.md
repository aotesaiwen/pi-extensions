# Publication review

This repository preserves the installed extension source; publication did not refactor its behavior. Documentation, ignore rules, and a test harness were added or adjusted separately.

## Checks performed

- Reviewed the six extensions and their supporting profiles/snippets.
- Copied source and documentation using an allowlist, excluding credentials, dependencies, hidden browser profiles, and runtime artifacts.
- Ran the existing regression suite: **41 passed, 0 failed** on Node.js 22.22.0/Linux.
- Loaded all six entry points with the Pi 1.3.0 extension loader: **6 loaded, 0 load errors**. This verifies registration/import compatibility, not every interactive lifecycle path.
- No hardcoded credentials or user-specific absolute paths were found in the reviewed extension source.

The native Node test harness uses the legacy TUI dependency. Pi itself aliases legacy package imports to its current packages, so the regression suite and loader smoke test provide different, limited kinds of coverage. Browser, snippet, and header behavior are not covered by the included automated suite.

## Known issues and limitations

These are review findings, not claims that every edge case has been reproduced end-to-end.

### Browser session privacy

`browser_network` captures request/response headers and returns unfiltered entries in tool-result `details`. Even without verbose model-facing output, sensitive authorization/cookie/API-key headers can enter saved Pi session data or exports. Verbose output can also disclose them to the model provider. Treat browser-enabled sessions and exports as sensitive. A future fix should redact both text and structured details by default with explicit opt-in for sensitive headers.

### Browser teardown

Closing the browser runs outside the tool-operation queue. Already-queued work can potentially relaunch it after disabling. Tool cancellation signals are not handled, and closing does not clear captured console/network buffers. Queue invalidation, serialized shutdown, and buffer clearing need regression coverage. Enable-state restoration also uses all session entries rather than only the active branch.

### Terminal and RPC behavior

- Prompt snippets have section labels/scroll indicators that are not consistently truncated to very narrow terminal widths.
- The question tool checks `hasUI` before using custom terminal components, although RPC UI does not support those components.
- Question components wrap an editor without forwarding focus, which can affect cursor/IME behavior.
- Question cancellation covers queued/pre-aborted requests, not subsequent cancellation of an active dialog.

### Web search portability and error handling

The credential-directory calculation uses URL `.pathname` rather than `fileURLToPath`, which can fail for paths containing escaped characters or Windows drive paths. Upstream error bodies are not guaranteed to redact a credential echoed by the upstream service; the existing test does not simulate that case.

### Subagent trust model

Child processes inherit the environment and disable parent extensions. Consequently, parent extension-based permission guards are not inherited. Project `.pi/agents` profiles can override bundled profiles and their tools. Context separation is not a sandbox: use trusted profiles and separate working directories where appropriate.

## Publication safeguards

The repository ignores credential files, browser profiles, dependency directories, and common runtime artifacts. This does not replace review before committing: custom profile/state paths and saved session exports can still contain secrets. No private authentication or runtime state is intentionally distributed here.
