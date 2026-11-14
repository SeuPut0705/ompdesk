# Retained view reopen model

This draft models a close-only reopen of a retained busy execution and the renderer consumers that can receive old results. See `SCOPE.md`, `Properties.md`, and `CORRESPONDENCE.md` for bounds, properties, and source mapping. No model result has been observed.

The matrix separates join, list, close, and frame scenarios. `MC_refuse.cfg` deliberately refuses an eligible zero-view retained execution and expects `JoinSafety` to fail. It does not model the intentional refusal for a matching visible tab. `mutations.json` specifies six more expected counterexamples. These are expectations, not reported detections.

For a SANY parse only, from the repository root, use a Java 11 or newer executable and the pinned TLA+ tools jar already present in the formal cache. Substitute the actual paths without downloading or installing anything:

```sh
<JAVA_11_OR_NEWER> -cp <TLA2TOOLS_1_8_0_JAR> tla2sany.SANY formal/retained-view-reopen/RetainedViewReopen.tla
```

The default jar location is `~/.cache/ompdesk/formal/tla/tla2tools-1.8.0/tla2tools.jar`, unless `OMPDESK_FORMAL_CACHE` changes the root. SANY resolves the standard `Naturals` module from the jar. SANY parses and performs semantic analysis only. It does not run TLC, check configuration files, execute mutations, or establish the invariants.

After the parent integrates the manifest, run the project's hosted formal workflow for this model. Check the matrix, each mutation, and the actual counterexample traces before drawing conclusions. A trace is not a production bug until the equivalent interleaving is reproduced in the real code. Do not stamp a model while covered files are dirty or the candidate frame boundary and its correspondence have not been checked.
