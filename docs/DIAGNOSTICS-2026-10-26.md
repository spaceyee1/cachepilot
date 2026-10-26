# Recent CPU-model observations

Five predeclared sequential CPU-model rounds completed their model startup and
exit lifecycle. The combination of WinError5, cached NT status changing to
C000004B, a later valid terminating flag1 query and a later Wait258 was observed
in4/5 rounds, or4/4 conditional on observed WinError5.

The other round ended sampling on its pause-budget guard. Its last sample was
206.7447ms before the recorded DLL-detach callback. That is limited observation,
not a negative finding. All five strict sampling results remain invalid: four
failed snapshots and one budget overrun. The observed call-entry-to-Resume-return
upper bound in the latter was11.8893ms; it is not an exact target-halt duration.

The four later positive thread-Wait observations returned93.8452,117.9673,
106.9919 and119.7574ms after the corresponding failed Python-wrapper interval
ended. These are intrusive observation intervals, not production latency.

28,050 explicit parent-binding calls were retained, with no trace drops or
recorder errors. Direct queries had no failures. Node, Python launcher, model
process and main thread reached positive final exit observations with code0;
no test orphan remained at the3s/5s checks and no unrelated process was ended.

Cached NT status is not the direct NtSuspendThread return. The termination flag
belongs to a subsequent query time and an exact-host empirical ABI contract.
Temporal order, DLL-detach order and repeated observations establish no atomic
triple, unique cause or universal rule. Raw local records and private paths are
deliberately not included here. No provider Key or API request was used.
