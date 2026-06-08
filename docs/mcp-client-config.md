# MCP Client Configuration

Build the server before configuring a client:

```powershell
npm install
npm run build
```

Use this stdio configuration shape:

```json
{
  "mcpServers": {
    "code-cartographer-mcp": {
      "command": "node",
      "args": ["D:\\_dev\\code-cartographer-mcp\\dist\\index.js"]
    }
  }
}
```

> Status: the server registers all 19 tools and they are implemented end-to-end (see [`STATUS.md`](STATUS.md)). The build/config snippet above is correct and usable.

The server registers these tools (intended purposes). All are codebase-only; the analysis tools require an initialized map:

| Tool | Purpose |
|---|---|
| `check_init_state` | Check whether `.code-cartographer-mcp/context-map.json` exists and whether it is fresh. |
| `init_codebase` | Build the baseline static map for a repository. |
| `get_context_summary` | Return a compact summary of the saved map. |
| `analyze_reachability` | Structural reachability hypotheses for a target (uncertainty-graded, never runtime-proven). |
| `find_duplicate_behavior` | Candidate paths that duplicate a behavior. |
| `classify_legacy_paths` | Classify legacy paths by reachability/risk. |
| `analyze_change_impact` | Blast-radius hypotheses for a change. |
| `review_preflight` | Pre-coding orientation for a requested change. |
| `review_change` | Review an agent-generated change for risks. |
| `get_ownership` | Canonical owner of a behavior/symbol. |
| `investigate_failure` | Codebase-only hypotheses around a failure (not a debugger). |
| `analyze_test_paths` | Which tests reach a target. |
| `detect_architecture_drift` | Scattered ownership / parallel systems. |
| `map_call_stack` | Static call graph rooted at an entry point (confidence-graded; not a runtime trace). |
| `visualize_call_stack` | Render the call stack as a Mermaid/DOT/ASCII diagram spec. |
| `visualize_architecture` | Render modules / ownership / drift as a diagram spec. |

The tools only inspect codebase files and checked-in artifacts. They do not run the application, execute tests, inspect telemetry, or attach to a debugger.
