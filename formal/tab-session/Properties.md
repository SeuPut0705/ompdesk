# Frozen properties: tab-session

Frozen at: the commit that adds this model (29 Oct 2026). Any change to a definition below, to a `CONSTRAINT`, or to the fairness of `Spec` is a **model change**: say so in the report, with the old and the new text and the evidence. Never make one to turn a failing check green.

The definitions are the lines between the `\* FROZEN PROPERTIES` and `\* END FROZEN PROPERTIES` banners of `tla/TabSession.tla`; `git diff <frozen sha> -- formal/tab-session/tla/TabSession.tla` shows every change to them.

## NoMissingSession

- Kind: invariant
- Statement: `NoMissingSession == lastOpen.k = "session" => lastOpen.f \in written`
- Meaning: `--session` never names a file stock has not written (stock exits "Session not found").
- Source: `src/main/omp-launch.ts#sessionOpen` doc comment; sidecar.test.ts "starts a fresh session in its folder when the session's file was never written".
- Level: protocol
- Config: `MC.cfg`, `MC_missing.cfg`
- Result: holds

## KeepsSession

- Kind: invariant
- Statement: `KeepsSession == (proc = "booting" /\ shown # NoS /\ shown \in written) => onOmp = shown`
- Meaning: every spawn of a tab whose session stock has written opens that session.
- Source: `.omp/rules/interrupted-work.md` ("One conversation stays one session across a relaunch"); a10eb6877.
- Level: protocol
- Config: `MC.cfg`, `MC_keeps.cfg`, `MC_old.cfg` (must fail: the code before a10eb6877)
- Result: holds (violated by the code before a10eb6877)

## NeverAnother

- Kind: invariant
- Statement: `NeverAnother == (proc = "booting" /\ ~moved) => onOmp \in {shown} \cup NewIds`
- Meaning: no spawn puts the tab on another written session than the one it shows, unless the person moved it to another folder.
- Source: `resources/gui-bridge/fresh-launch.yml`; `SidecarOptions.fresh` ("Fresh GUI tabs must not inherit the CLI's persistent autoResume setting").
- Level: protocol
- Config: `MC.cfg`, `MC_another.cfg`, `MC_shipped.cfg` (must fail: a10eb6877, finding F1)
- Result: holds (violated by a10eb6877: F1)
