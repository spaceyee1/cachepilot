using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace CachePilotMonitor {
 // Candidate-only bounded numeric audit buffer. It performs no I/O and invokes
 // no consumer callback. Receiver/bridge callers provide fixed event/reason
 // enums and numeric values only; no publisher strings enter this buffer.
 internal sealed class MonitorDiagnostics {
  internal const int Capacity=16384;
  readonly object gate=new object();
  readonly Queue<Dictionary<string,object>> records=new Queue<Dictionary<string,object>>();
  readonly string origin;
  long ordinal,dropped,failures;
  internal MonitorDiagnostics(string origin){this.origin=origin;}
  internal long DroppedCount {get{lock(gate)return dropped;}}
  internal long FailureCount {get{lock(gate)return failures;}}
  internal void NoteFailure(){try{lock(gate)if(failures<Int64.MaxValue)failures++;}catch{}}
  internal void Record(string eventCode,string reason,Dictionary<string,object> numeric){
   try {
    // Wall time is for correlation only. Decisions remain on the receiver's
    // existing monotonic clock; audit timing cannot feed back into acceptance.
    long ticks=Stopwatch.GetTimestamp(),wall=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock(gate){
     if(records.Count>=Capacity){records.Dequeue();if(dropped<Int64.MaxValue)dropped++;}
     var value=new Dictionary<string,object>();
     if(numeric!=null)foreach(var pair in numeric){
      object item=pair.Value;
      if(item is int||item is long||item is decimal||item is double||item is bool||item==null)value[pair.Key]=item;
     }
     if(ordinal<Int64.MaxValue)ordinal++;
     value["origin"]=origin;value["event"]=eventCode;value["reason"]=reason;
     value["auditOrdinal"]=ordinal;value["auditMonoTicks"]=ticks;value["auditMonoFrequency"]=Stopwatch.Frequency;value["auditUtcMs"]=wall;
     value["droppedTotal"]=dropped;value["loggingFailureTotal"]=failures;
     records.Enqueue(value);
    }
   }catch{NoteFailure();}
  }
  internal Dictionary<string,object>[] Drain(){lock(gate){var result=records.ToArray();records.Clear();return result;}}
 }
}
