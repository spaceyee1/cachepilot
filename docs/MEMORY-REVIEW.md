# Memory arithmetic correction: historical observations only

The following are October 25, 2026 UTC snapshots, not current RAM measurements or expected model capacity. Each row uses available physical RAM and private working set from its own observation. GiB = 2^30 bytes.

| Observation | Actual available GiB | Observed private resident GiB | Actual gap to 4 GiB | Conditional available GiB | Conditional gap to 4 GiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier administrator sample: 2026-10-25T07:00:32.1895720Z | 2.706367 | 0.974758 | 1.293633 | 3.681126 | 0.318874 |
| Later historical observation: 2026-10-25T07:09:56.4710096Z | 2.384243 | 0.635857 | 1.615757 | 3.020100 | 0.979900 |

The conditional columns assume **100% of that observation's private resident pages are released and all other memory changes equal zero**. Thus 2.384243 + 0.635857 gives approximately 3.020100 GiB; actual gap 1.615757 GiB and conditional gap 0.979900 GiB are different quantities. The older 3.681126 GiB scenario uses the earlier observation and must not be combined with later inputs.

Neither private working set nor the scenario is a promised recovery amount or a complete upper/lower bound on the system-wide effect of stopping a parent service. Other children, shared-page references, paging, other processes and allocations during restart can alter it in either direction. Private committed bytes are not immediately reclaimable physical RAM. The observed increase in private commit alone does not prove a leak or provide a reclaim guarantee. Some source counters are sampled separately rather than atomically.

The WiFi child has no independent SCM service entry; its parent is ASUSOptimization. Stopping that parent has a broader potential scope, including hotkey components. No service is stopped or restarted by this package. If separately authorized later, take a pre-action sample and a sample after a confirmed stop, with timestamps, current parent/child identities, available RAM, private resident/committed bytes and relevant network state. Treat the difference as an observation subject to concurrent activity, not solely attributed reclaim. Sample again after rollback; real network/hotkey recovery needs separate checks.

The historical **53/53** result covers a pure in-memory state/logic model with synthetic identities and logical clocks. It does not include actual SCM calls, process termination/restart, network disconnection/recovery, measured memory recovery, GPU inference or 8B loading. It is not 53 real hardware/system failures. The two older 40/40 and 52/52 stage reports are not added to it.

The pending manual plan permits one normal stop only after separate authorization, a maximum 30-second wait, no forced stop/retry, and at most one normal start only if originally Running and confirmed Stopped. Unknown results remain unknown; failed recovery is escalated to the local user. This candidate does not execute that plan. Four GiB is only a preliminary gate, not proof an 8B workload fits.

This clarification is a new document. Historical observations and their original values remain unchanged; machine paths, PIDs and raw inventories are not included in this source publication.
