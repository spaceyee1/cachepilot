using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace CachePilotMonitor {
 // Only the receiver creates these identities. Publisher JSON cannot supply or
 // replace a receipt, selection generation, process identity, or source session.
 public sealed class ReceiverStamp {
  public readonly string Epoch,FrameId,Backend;
  public readonly long OriginSeq,TransportConnectionId,SourceSessionGeneration,SelectionGeneration,ProcessIdentity,StartedAt,ReceivedMonotonicMilliseconds,ReceivedUtcMilliseconds;
  public readonly int FrameOrdinal,ActualPid;
  internal ReceiverStamp(string epoch,long seq,int ordinal,string frame,long transport,long session,long generation,int pid,long identity,long started,string backend,long mono,long utc){Epoch=epoch;OriginSeq=seq;FrameOrdinal=ordinal;FrameId=frame;TransportConnectionId=transport;SourceSessionGeneration=session;SelectionGeneration=generation;ActualPid=pid;ProcessIdentity=identity;StartedAt=started;Backend=backend;ReceivedMonotonicMilliseconds=mono;ReceivedUtcMilliseconds=utc;}
 }
 public sealed class ReceivedSample {
  readonly Dictionary<string,object> data;
  public readonly ReceiverStamp Stamp;
  internal ReceivedSample(ReceiverStamp stamp,Dictionary<string,object> value){Stamp=stamp;data=Copy(value);}
  public Dictionary<string,object> Data {get{return Copy(data);}}
  internal Dictionary<string,object> DiagnosticData {get{return data;}}
  static readonly HashSet<string> Fields=new HashSet<string>(new[]{"schema","pid","startedAt","sampledAt","hits","misses","reusedWithinCall","tokenizations","preparations","promptPreparations","failures","active","queued","rss","version","device","backend","providerCacheMeasured","hostRequestsIntercepted","analyses","inputPositions","cacheHitPositions","cacheMissPositions","lastInputTokens","totalInputTokens","lastCompletedAt","receivedAt"});
  internal static Dictionary<string,object> Copy(Dictionary<string,object> value){
   if(value==null)return null;var copy=new Dictionary<string,object>();
   foreach(var pair in value)if(Fields.Contains(pair.Key)){
    object item=pair.Value;copy[pair.Key]=item==null||item is string||item is bool||item is int||item is long||item is decimal?item:null;
   }
   return copy;
  }
 }
 public sealed class ReceiverBoundary {
  public readonly string Epoch,Reason;
  public readonly long Watermark,SelectionGeneration,AtMilliseconds;
  public readonly int SelectedPid;
  internal ReceiverBoundary(string epoch,long watermark,long generation,long at,int pid,string reason){Epoch=epoch;Watermark=watermark;SelectionGeneration=generation;AtMilliseconds=at;SelectedPid=pid;Reason=reason;}
 }
 public sealed class ReceiverView {
  readonly ReceivedSample[] samples;
  internal readonly object Owner;
  public readonly ReceiverBoundary Boundary;
  public readonly long NowMilliseconds;
  public readonly bool Live;
  public readonly string State;
  public readonly ReceivedSample Current;
  internal ReceiverView(object owner,ReceiverBoundary boundary,long now,bool live,string state,ReceivedSample current,ReceivedSample[] values){Owner=owner;Boundary=boundary;NowMilliseconds=now;Live=live;State=state;Current=current;samples=values;}
  public ReceivedSample[] AcceptedSamples {get{return (ReceivedSample[])samples.Clone();}}
 }
 public sealed class ReceiverTicket {
  internal readonly object Owner;
  public readonly string Epoch;
  public readonly long OriginSeq,TransportConnectionId,SourceSessionGeneration,ProcessIdentity,ReservedMonotonicMilliseconds;
  public readonly int ActualPid;
  internal long? ReceiptMono,ReceiptUtc;
  internal ReceiverTicket(object owner,string epoch,long seq,long transport,long session,int pid,long identity,long now){Owner=owner;Epoch=epoch;OriginSeq=seq;TransportConnectionId=transport;SourceSessionGeneration=session;ActualPid=pid;ProcessIdentity=identity;ReservedMonotonicMilliseconds=now;}
 }
 public sealed class MonitorReceiver {
  sealed class Source {
   public long Identity,Started,Generation=1,LastSeq=-1,LastReceipt=-1;
   public int LastOrdinal=-1;
   public string Backend;
   public bool? Measured;
   public Dictionary<string,object> Last;
  }
  sealed class Transport {
   public int Pid;public long Identity;public bool Closed,Revoked;
   public readonly HashSet<string> Committed=new HashSet<string>();
  }
  readonly object gate=new object(),owner=new object();
  readonly Func<long> now,utc;
  readonly Func<int,bool> alive;
  readonly Func<int,long?> processIdentity;
  readonly Dictionary<int,Source> sources=new Dictionary<int,Source>();
  readonly Dictionary<long,Transport> transports=new Dictionary<long,Transport>();
  readonly Dictionary<int,ReceivedSample> latest=new Dictionary<int,ReceivedSample>();
  readonly List<ReceivedSample> accepted=new List<ReceivedSample>();
  readonly MonitorDiagnostics diagnostics=new MonitorDiagnostics("receiver");
  string epoch=Guid.NewGuid().ToString("N");
  long diagnosticEpoch=1,boundaryDiagnosticEpoch=1;
  long issued,transportId,generation,frameId;
  ReceiverBoundary boundary;
  ReceivedSample current;
  bool invalid=true;
  // Freshness is not a source-identity boundary. A temporary telemetry gap
  // hides live values without deleting the receiver-owned 120-second evidence.
  bool telemetryStale;
  long telemetryStaleAt=-1,telemetryStaleOriginSeq=-1,lastCaptureMono=-1;
  public const long StaleMilliseconds=4000,WindowMilliseconds=120000;
  public const int MaximumSources=64,MaximumTransports=1024,MaximumFramesPerTransport=256;
  // Draining copies bounded numeric evidence only, after the caller has left
  // any receiver render callback. Neither recording nor draining performs I/O.
  public Dictionary<string,object>[] DrainDiagnostics(){lock(gate)return diagnostics.Drain();}
  public long DiagnosticDroppedCount {get{return diagnostics.DroppedCount;}}
  public long DiagnosticFailureCount {get{return diagnostics.FailureCount;}}
  static Dictionary<string,object> Detail(params object[] fields){try{var value=new Dictionary<string,object>();for(int i=0;i+1<fields.Length;i+=2)value[(string)fields[i]]=fields[i+1];return value;}catch{return null;}}
  static long DiagnosticCount(Dictionary<string,object> data,string key){long value;return Count(data,key,out value)?value:-1;}
  static long DiagnosticFrameId(ReceivedSample sample){if(sample==null)return -1;long value;string id=sample.Stamp.FrameId;int colon=id.LastIndexOf(':');return colon>=0&&Int64.TryParse(id.Substring(colon+1),out value)?value:-1;}
  static string DiagnosticReason(string reason){
   switch(reason){
    case "opened":case "selection":case "channel-stopped":case "closed":case "epoch":case "transport-aborted":case "transport-frame-capacity":case "invalid-frame":case "source-identity":case "counter-reset":case "stale-or-clock-frame":case "window-capacity":case "disconnected":case "stale-or-identity":case "rejected":case "invalid-transport-or-frame":return reason;
    case "监控通道已停止":return "channel-stopped-ui";
    case "界面快照应用失败":return "ui-apply-failed";
    default:return "other";
   }
  }
  string TicketFailure(ReceiverTicket ticket){
   if(ticket==null)return "ticket-null";if(!Object.ReferenceEquals(owner,ticket.Owner))return "ticket-owner";if(ticket.Epoch!=epoch)return "ticket-epoch";
   Transport transport;if(!transports.TryGetValue(ticket.TransportConnectionId,out transport))return "transport-missing";if(transport.Revoked)return "transport-revoked";return "ticket-invalid";
  }
  void Audit(string eventCode,string reason,ReceiverTicket ticket,int ordinal,Dictionary<string,object> detail){
   try {
    var value=new Dictionary<string,object>{{"epochId",diagnosticEpoch},{"boundaryEpochId",boundaryDiagnosticEpoch},{"watermark",boundary.Watermark},{"selectionGeneration",boundary.SelectionGeneration},{"boundaryAtMonoMs",boundary.AtMilliseconds},{"selectedPid",boundary.SelectedPid},{"issuedSequence",issued},{"lastIssuedFrameId",frameId},{"invalid",invalid?1:0},{"telemetryStale",telemetryStale?1:0},{"telemetryStaleAtMonoMs",telemetryStaleAt},{"telemetryStaleOriginSeq",telemetryStaleOriginSeq},{"sourceCount",sources.Count},{"transportCount",transports.Count},{"acceptedCount",accepted.Count},{"currentFrameId",DiagnosticFrameId(current)},{"currentPid",current==null?0:current.Stamp.ActualPid},{"currentReceiptMonoMs",current==null?-1:current.Stamp.ReceivedMonotonicMilliseconds},{"currentTokens",DiagnosticCount(current==null?null:current.DiagnosticData,"totalInputTokens")},{"currentInputs",DiagnosticCount(current==null?null:current.DiagnosticData,"inputPositions")},{"currentHits",DiagnosticCount(current==null?null:current.DiagnosticData,"cacheHitPositions")},{"ordinal",ordinal}};
    if(ticket!=null){
     value["originSeq"]=ticket.OriginSeq;value["transportConnectionId"]=ticket.TransportConnectionId;value["actualPid"]=ticket.ActualPid;value["processIdentity"]=ticket.ProcessIdentity;value["ticketSourceGeneration"]=ticket.SourceSessionGeneration;value["reservedMonoMs"]=ticket.ReservedMonotonicMilliseconds;value["receiptMonoMs"]=ticket.ReceiptMono.HasValue?ticket.ReceiptMono.Value:-1;value["receiptUtcMs"]=ticket.ReceiptUtc.HasValue?ticket.ReceiptUtc.Value:-1;
     Source source;if(sources.TryGetValue(ticket.ActualPid,out source)){value["sourceGeneration"]=source.Generation;value["sourceLastSeq"]=source.LastSeq;value["sourceLastOrdinal"]=source.LastOrdinal;value["sourceLastReceiptMonoMs"]=source.LastReceipt;}
    }
    if(detail!=null)foreach(var pair in detail)value[pair.Key]=pair.Value;
    diagnostics.Record(eventCode,reason,value);
   }catch{diagnostics.NoteFailure();}
  }
  void Audit(string eventCode,string reason){Audit(eventCode,reason,null,-1,null);}
  static bool Alive(int pid){try{using(var p=Process.GetProcessById(pid))return !p.HasExited;}catch{return false;}}
  static long? Identity(int pid){try{using(var p=Process.GetProcessById(pid))return p.StartTime.ToUniversalTime().Ticks;}catch{return null;}}
  public MonitorReceiver():this(Stopwatch.StartNew()){}
  MonitorReceiver(Stopwatch clock):this(()=>clock.ElapsedMilliseconds,()=>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),Alive,Identity){}
  public MonitorReceiver(Func<long> now,Func<long> utc,Func<int,bool> alive,Func<int,long?> processIdentity):this(now,utc,alive,processIdentity,0){}
  public MonitorReceiver(Func<long> now,Func<long> utc,Func<int,bool> alive,Func<int,long?> processIdentity,long initialSequence){
   if(now==null||utc==null||alive==null||processIdentity==null||initialSequence<0)throw new ArgumentException("Receiver dependencies");
   this.now=now;this.utc=utc;this.alive=alive;this.processIdentity=processIdentity;issued=initialSequence;
   boundary=new ReceiverBoundary(epoch,issued,0,now(),0,"opened");
   Audit("Opened","opened");
  }
  public long NowMilliseconds {get{lock(gate)return now();}}
  public int SourceCount {get{lock(gate)return sources.Count;}}
  public int TransportCount {get{lock(gate)return transports.Count;}}
  public ReceiverBoundary Select(int pid){lock(gate){if(pid<0)throw new ArgumentOutOfRangeException("pid");if(pid!=boundary.SelectedPid||generation==0)Advance(pid,"selection",true);return boundary;}}
  public void InvalidateSelected(string reason){lock(gate)Advance(boundary.SelectedPid,reason??"channel-stopped",false);}
  void Advance(int pid,string reason,bool force){
   if(!force&&invalid){Audit("AdvanceSkipped",DiagnosticReason(reason));return;}
   long oldGeneration=boundary.SelectionGeneration,oldWatermark=boundary.Watermark,oldAt=boundary.AtMilliseconds,oldEpoch=boundaryDiagnosticEpoch;
   int oldPid=boundary.SelectedPid;long oldTokens=DiagnosticCount(current==null?null:current.DiagnosticData,"totalInputTokens"),oldInputs=DiagnosticCount(current==null?null:current.DiagnosticData,"inputPositions"),oldHits=DiagnosticCount(current==null?null:current.DiagnosticData,"cacheHitPositions");
   Audit("AdvanceBefore",DiagnosticReason(reason),null,-1,Detail("nextPid",pid,"force",force?1:0));
   generation=checked(generation+1);boundary=new ReceiverBoundary(epoch,issued,generation,now(),pid,reason);current=null;accepted.Clear();invalid=true;
   telemetryStale=false;telemetryStaleAt=-1;telemetryStaleOriginSeq=-1;
   boundaryDiagnosticEpoch=diagnosticEpoch;
   Audit("AdvanceAfter",DiagnosticReason(reason),null,-1,Detail("oldPid",oldPid,"oldEpochId",oldEpoch,"oldGeneration",oldGeneration,"oldWatermark",oldWatermark,"oldBoundaryAtMonoMs",oldAt,"oldTokens",oldTokens,"oldInputs",oldInputs,"oldHits",oldHits,"force",force?1:0));
  }
  public void RestartEpoch(){lock(gate)RestartEpochCore();}
  void RestartEpochCore(){epoch=Guid.NewGuid().ToString("N");if(diagnosticEpoch<Int64.MaxValue)diagnosticEpoch++;issued=0;transports.Clear();latest.Clear();sources.Clear();Advance(boundary.SelectedPid,"epoch",true);}
  long NextSequence(){if(issued==Int64.MaxValue)RestartEpochCore();return ++issued;}
  bool InFlight(int pid){foreach(var item in transports.Values)if(item.Pid==pid&&!item.Closed)return true;return false;}
  void RemoveUnusedSource(int pid){if(pid!=boundary.SelectedPid&&!latest.ContainsKey(pid)&&!InFlight(pid))sources.Remove(pid);}
  Source GetSource(int pid,long identity){Source source;if(!sources.TryGetValue(pid,out source)){
   if(sources.Count>=MaximumSources){int remove=0;foreach(int candidate in sources.Keys)if(candidate!=boundary.SelectedPid&&!InFlight(candidate)){remove=candidate;break;}if(remove>0){sources.Remove(remove);latest.Remove(remove);}}
   if(sources.Count>=MaximumSources){Audit("ReserveRefused","source-capacity",null,-1,Detail("actualPid",pid));throw new InvalidOperationException("Receiver source capacity");}
   source=new Source{Identity=identity};sources.Add(pid,source);
  }return source;}
  long ActualIdentity(int pid){try{return processIdentity(pid)??-1;}catch{return -1;}}
  public ReceiverTicket Reserve(int actualPid){lock(gate){
   if(actualPid<=0){Audit("ReserveRefused","pid-invalid",null,-1,Detail("actualPid",actualPid));throw new ArgumentOutOfRangeException("actualPid");}
   if(transports.Count>=MaximumTransports){Audit("ReserveRefused","transport-capacity",null,-1,Detail("actualPid",actualPid));throw new InvalidOperationException("Receiver transport capacity");}
   long identity=ActualIdentity(actualPid);var source=GetSource(actualPid,identity);long seq=NextSequence();
   // Epoch rotation cleared source state; reacquire its new local generation.
   source=GetSource(actualPid,identity);
   long connection=checked(++transportId);transports.Add(connection,new Transport{Pid=actualPid,Identity=identity});
   var ticket=new ReceiverTicket(owner,epoch,seq,connection,source.Generation,actualPid,identity,now());Audit("Reserve","created",ticket,-1,null);return ticket;
  }}
  bool Ticket(ReceiverTicket ticket,out Transport transport){transport=null;return ticket!=null&&Object.ReferenceEquals(owner,ticket.Owner)&&ticket.Epoch==epoch&&transports.TryGetValue(ticket.TransportConnectionId,out transport)&&!transport.Revoked;}
  public ReceiverTicket ReserveRead(ReceiverTicket first){lock(gate){Transport transport;if(!Ticket(first,out transport)){Audit("ReserveReadRefused",TicketFailure(first),first,-1,null);throw new InvalidOperationException("Transport is not open");}if(transport.Closed){Audit("ReserveReadRefused","transport-closed",first,-1,null);throw new InvalidOperationException("Transport is not open");}long seq=NextSequence();if(first.Epoch!=epoch){Audit("ReserveReadRefused","epoch-changed",first,-1,null);throw new InvalidOperationException("Epoch changed");}var ticket=new ReceiverTicket(owner,epoch,seq,first.TransportConnectionId,first.SourceSessionGeneration,first.ActualPid,first.ProcessIdentity,now());Audit("ReserveRead","created",ticket,-1,null);return ticket;}}
  public bool MarkBytes(ReceiverTicket ticket){lock(gate){Transport transport;if(!Ticket(ticket,out transport)){Audit("MarkBytesRefused",TicketFailure(ticket),ticket,-1,null);return false;}if(transport.Closed){Audit("MarkBytesRefused","transport-closed",ticket,-1,null);return false;}bool first=!ticket.ReceiptMono.HasValue;if(first){ticket.ReceiptMono=now();ticket.ReceiptUtc=utc();}Audit("MarkBytes",first?"first-bytes":"already-marked",ticket,-1,null);return true;}}
  public void EndTransport(ReceiverTicket ticket,bool normal){lock(gate){Transport transport;if(!Ticket(ticket,out transport)){Audit("EndTransportIgnored",TicketFailure(ticket),ticket,-1,Detail("normal",normal?1:0));return;}if(transport.Closed){Audit("EndTransportIgnored","transport-closed",ticket,-1,Detail("normal",normal?1:0));return;}Audit("EndTransport",normal?"normal":"abnormal",ticket,-1,null);transport.Closed=true;if(!normal){transport.Revoked=true;if(ticket.OriginSeq>boundary.Watermark||ticket.ActualPid!=boundary.SelectedPid)Invalidate(ticket.ActualPid,"transport-aborted");}transports.Remove(ticket.TransportConnectionId);RemoveUnusedSource(ticket.ActualPid);TrimSources();}}
  void Invalidate(int pid,string reason){latest.Remove(pid);if(pid==boundary.SelectedPid)Advance(pid,reason,false);}
  public void Reject(ReceiverTicket ticket,string reason){lock(gate){Transport transport;if(!Ticket(ticket,out transport)){Audit("RejectIgnored",TicketFailure(ticket),ticket,-1,null);return;}if(transport.Closed){Audit("RejectIgnored","transport-closed",ticket,-1,null);return;}Audit("Reject",DiagnosticReason(reason??"rejected"),ticket,-1,null);transport.Revoked=true;transport.Closed=true;if(ticket.OriginSeq>boundary.Watermark||ticket.ActualPid!=boundary.SelectedPid)Invalidate(ticket.ActualPid,reason??"rejected");transports.Remove(ticket.TransportConnectionId);RemoveUnusedSource(ticket.ActualPid);}}
  static bool Count(Dictionary<string,object> value,string key,out long result){result=0;object item;if(value==null||!value.TryGetValue(key,out item)||!(item is int||item is long||item is decimal))return false;try{decimal n=Convert.ToDecimal(item);if(n<0||n>9007199254740991m||Decimal.Truncate(n)!=n)return false;result=Decimal.ToInt64(n);return true;}catch{return false;}}
  static bool Counters(Dictionary<string,object> value){
   long tokens,inputs,hits,misses;bool a=Count(value,"totalInputTokens",out tokens),b=Count(value,"inputPositions",out inputs),c=Count(value,"cacheHitPositions",out hits),d=Count(value,"cacheMissPositions",out misses);
   // Older schema has no measured counters. Partial or impossible measured
   // counters cannot become plausible-looking percentages.
   if(!a&&!b&&!c&&!d)return true;
   return a&&b&&c&&d&&hits<=inputs&&hits+misses==inputs&&(inputs>0||tokens==0);
  }
  static bool Delta(Dictionary<string,object> before,Dictionary<string,object> after){
   if(before==null)return true;
   long bt,bi,bh,bm,at,ai,ah,am;
   if(!Count(before,"totalInputTokens",out bt)||!Count(before,"inputPositions",out bi)||!Count(before,"cacheHitPositions",out bh)||!Count(before,"cacheMissPositions",out bm))return true;
   if(!Count(after,"totalInputTokens",out at)||!Count(after,"inputPositions",out ai)||!Count(after,"cacheHitPositions",out ah)||!Count(after,"cacheMissPositions",out am))return false;
   return at>=bt&&ai>=bi&&ah>=bh&&am>=bm&&ah-bh<=ai-bi&&ah-bh+am-bm==ai-bi&&(ai>bi||at==bt);
  }
  public bool Commit(ReceiverTicket ticket,Dictionary<string,object> validatedFrame,int ordinal){lock(gate){
   Transport transport;if(!Ticket(ticket,out transport)){Audit("CommitRefused",TicketFailure(ticket),ticket,ordinal,null);return false;}
   if(transport.Closed){Audit("CommitRefused","transport-closed",ticket,ordinal,null);return false;}
   if(ordinal<0){Audit("CommitRefused","ordinal-invalid",ticket,ordinal,null);return false;}
   if(!ticket.ReceiptMono.HasValue){Audit("CommitRefused","receipt-unmarked",ticket,ordinal,null);return false;}
   string key=ticket.OriginSeq+":"+ordinal;if(transport.Committed.Contains(key)){Audit("CommitRefused","frame-duplicate",ticket,ordinal,null);return false;}
   if(transport.Committed.Count>=MaximumFramesPerTransport){Audit("CommitRefused","transport-frame-capacity",ticket,ordinal,null);Reject(ticket,"transport-frame-capacity");return false;}
   transport.Committed.Add(key);
   validatedFrame=ReceivedSample.Copy(validatedFrame);
   Source source=GetSource(ticket.ActualPid,ticket.ProcessIdentity);
   if(ticket.SourceSessionGeneration!=source.Generation){Audit("CommitRefused","source-generation",ticket,ordinal,null);return false;}
   if(ticket.OriginSeq<source.LastSeq||(ticket.OriginSeq==source.LastSeq&&ordinal<=source.LastOrdinal)){Audit("CommitRefused","source-order",ticket,ordinal,null);return false;}
   // A stale cached/in-flight read is discarded before it can invalidate or
   // refresh the newly selected window.
   if(ticket.ActualPid==boundary.SelectedPid&&ticket.OriginSeq<=boundary.Watermark){Audit("CommitRefused","selection-watermark",ticket,ordinal,null);return false;}
   long actual=ActualIdentity(ticket.ActualPid),pid,start;
   string backend=null;object mode;
   if(validatedFrame!=null&&validatedFrame.TryGetValue("backend",out mode))backend=mode as string;
   if(actual<0||actual!=ticket.ProcessIdentity||!Count(validatedFrame,"pid",out pid)||pid!=ticket.ActualPid||!Count(validatedFrame,"startedAt",out start)||(backend!="estimate"&&backend!="local")||!Counters(validatedFrame)){
    long diagnosticPid,diagnosticStart;string diagnosticReason=actual<0?"identity-unavailable":actual!=ticket.ProcessIdentity?"identity-changed":!Count(validatedFrame,"pid",out diagnosticPid)?"frame-pid-missing":diagnosticPid!=ticket.ActualPid?"frame-pid-mismatch":!Count(validatedFrame,"startedAt",out diagnosticStart)?"frame-start-invalid":backend!="estimate"&&backend!="local"?"frame-backend-invalid":"frame-counters-invalid";
    Audit("CommitRefused",diagnosticReason,ticket,ordinal,Detail("actualIdentity",actual,"frameTokens",DiagnosticCount(validatedFrame,"totalInputTokens"),"frameInputs",DiagnosticCount(validatedFrame,"inputPositions"),"frameHits",DiagnosticCount(validatedFrame,"cacheHitPositions")));
    Invalidate(ticket.ActualPid,"invalid-frame");return false;
   }
   long measuredTokens;bool measured=Count(validatedFrame,"totalInputTokens",out measuredTokens);
   bool changed=source.Identity!=ticket.ProcessIdentity||(source.Backend!=null&&(source.Started!=start||source.Backend!=backend))||(source.Measured.HasValue&&source.Measured.Value!=measured);
   bool counters=!changed&&!Delta(source.Last,validatedFrame);
   if(changed||counters){
    Audit("SourceResetBefore",changed?"source-identity":"counter-reset",ticket,ordinal,Detail("identityChanged",source.Identity!=ticket.ProcessIdentity?1:0,"startChanged",source.Backend!=null&&source.Started!=start?1:0,"backendChanged",source.Backend!=null&&source.Backend!=backend?1:0,"measuredChanged",source.Measured.HasValue&&source.Measured.Value!=measured?1:0,"oldSourceTokens",DiagnosticCount(source.Last,"totalInputTokens"),"oldSourceInputs",DiagnosticCount(source.Last,"inputPositions"),"oldSourceHits",DiagnosticCount(source.Last,"cacheHitPositions"),"frameTokens",DiagnosticCount(validatedFrame,"totalInputTokens"),"frameInputs",DiagnosticCount(validatedFrame,"inputPositions"),"frameHits",DiagnosticCount(validatedFrame,"cacheHitPositions")));
    source.Identity=ticket.ProcessIdentity;source.Started=start;source.Backend=backend;source.Measured=measured;source.Generation=checked(source.Generation+1);source.Last=null;source.LastSeq=-1;source.LastOrdinal=-1;source.LastReceipt=-1;
    Audit("SourceResetAfter",changed?"source-identity":"counter-reset",ticket,ordinal,null);
    Invalidate(ticket.ActualPid,changed?"source-identity":"counter-reset");return false;
   }
   long receipt=ticket.ReceiptMono.Value,instant=now();
   if(receipt<ticket.ReservedMonotonicMilliseconds||receipt>instant||receipt<source.LastReceipt||instant-receipt>=StaleMilliseconds){Audit("CommitRefused",receipt<ticket.ReservedMonotonicMilliseconds?"receipt-before-reserve":receipt>instant?"receipt-in-future":receipt<source.LastReceipt?"receipt-before-source":"receipt-stale",ticket,ordinal,Detail("receiverNowMonoMs",instant,"snapshotAgeMs",instant-receipt,"actualIdentity",actual));Invalidate(ticket.ActualPid,"stale-or-clock-frame");return false;}
   source.Identity=ticket.ProcessIdentity;source.Started=start;source.Backend=backend;source.Measured=measured;source.Last=ReceivedSample.Copy(validatedFrame);source.LastSeq=ticket.OriginSeq;source.LastOrdinal=ordinal;source.LastReceipt=receipt;
   var data=ReceivedSample.Copy(validatedFrame);data["receivedAt"]=ticket.ReceiptUtc.Value;
   var stamp=new ReceiverStamp(epoch,ticket.OriginSeq,ordinal,epoch+":"+checked(++frameId),ticket.TransportConnectionId,source.Generation,generation,ticket.ActualPid,ticket.ProcessIdentity,start,backend,receipt,ticket.ReceiptUtc.Value);
   var sample=new ReceivedSample(stamp,data);latest[ticket.ActualPid]=sample;
   if(ticket.ActualPid==boundary.SelectedPid){
    if(receipt<boundary.AtMilliseconds){Audit("CommitRefused","receipt-before-boundary",ticket,ordinal,Detail("receiverNowMonoMs",instant,"snapshotAgeMs",instant-receipt));return false;}
    current=sample;invalid=false;accepted.Add(sample);
    if(telemetryStale){
     Audit("TelemetryRecovered","fresh-same-source",ticket,ordinal,Detail("receiverNowMonoMs",instant,"snapshotAgeMs",instant-receipt,"recoveryFromMonoMs",telemetryStaleAt,"recoveryFromOriginSeq",telemetryStaleOriginSeq,"recoveryDurationMs",instant-telemetryStaleAt,"acceptedFrameId",frameId));
     telemetryStale=false;telemetryStaleAt=-1;telemetryStaleOriginSeq=-1;
    }
    long cutoff=Math.Max(boundary.AtMilliseconds,instant-WindowMilliseconds);
    while(accepted.Count>0&&accepted[0].Stamp.ReceivedMonotonicMilliseconds<cutoff)accepted.RemoveAt(0);
    // Never silently remove an in-window baseline to satisfy a count limit.
    // Resource pressure explicitly ends the segment and requires a new frame.
    if(accepted.Count>8192){Audit("CommitRefused","window-capacity",ticket,ordinal,Detail("receiverNowMonoMs",instant,"snapshotAgeMs",instant-receipt));Advance(boundary.SelectedPid,"window-capacity",false);return false;}
   }
   TrimSources();Audit("CommitAccepted",ticket.ActualPid==boundary.SelectedPid?"selected":"other-source",ticket,ordinal,Detail("acceptedFrameId",frameId,"acceptedReceiptMonoMs",receipt,"acceptedReceiptUtcMs",ticket.ReceiptUtc.Value,"receiverNowMonoMs",instant,"snapshotAgeMs",instant-receipt,"actualIdentity",actual,"frameTokens",DiagnosticCount(validatedFrame,"totalInputTokens"),"frameInputs",DiagnosticCount(validatedFrame,"inputPositions"),"frameHits",DiagnosticCount(validatedFrame,"cacheHitPositions")));return true;
  }}
  void TrimSources(){if(latest.Count<=16)return;int remove=0;long oldest=Int64.MaxValue;foreach(var pair in latest)if(pair.Key!=boundary.SelectedPid&&!InFlight(pair.Key)&&pair.Value.Stamp.ReceivedMonotonicMilliseconds<oldest){oldest=pair.Value.Stamp.ReceivedMonotonicMilliseconds;remove=pair.Key;}if(remove>0){latest.Remove(remove);sources.Remove(remove);}}
  public ReceiverView Capture(){lock(gate){
   long instant=now(),previousCapture=lastCaptureMono;lastCaptureMono=instant;if(current!=null){bool running=false;try{running=alive(boundary.SelectedPid);}catch{}
    // Verify process identity even during a telemetry gap. A confirmed hard
    // identity failure must not be concealed by the softer freshness state.
    long receipt=current.Stamp.ReceivedMonotonicMilliseconds,actual=-2;bool checkedIdentity=false;string diagnosticReason=null;
    if(!running)diagnosticReason="capture-dead";
    else if(instant<receipt||instant<previousCapture)diagnosticReason="capture-clock";
    else {checkedIdentity=true;actual=ActualIdentity(boundary.SelectedPid);if(actual!=current.Stamp.ProcessIdentity)diagnosticReason="capture-identity";}
    if(diagnosticReason!=null){
     Audit("CaptureInvalidation",diagnosticReason,null,-1,Detail("receiverNowMonoMs",instant,"previousCaptureMonoMs",previousCapture,"snapshotAgeMs",instant-receipt,"running",running?1:0,"identityCheckPerformed",checkedIdentity?1:0,"actualIdentity",actual,"expectedIdentity",current.Stamp.ProcessIdentity,"currentOriginSeq",current.Stamp.OriginSeq,"currentSourceGeneration",current.Stamp.SourceSessionGeneration,"currentSelectionGeneration",current.Stamp.SelectionGeneration,"currentTransportConnectionId",current.Stamp.TransportConnectionId,"currentReceiptUtcMs",current.Stamp.ReceivedUtcMilliseconds));
     Advance(boundary.SelectedPid,!running?"disconnected":"stale-or-identity",false);
    }else if(instant-receipt>=StaleMilliseconds&&!telemetryStale){
     telemetryStale=true;telemetryStaleAt=instant;telemetryStaleOriginSeq=current.Stamp.OriginSeq;
     Audit("TelemetryStale","capture-stale",null,-1,Detail("receiverNowMonoMs",instant,"snapshotAgeMs",instant-receipt,"running",running?1:0,"identityCheckPerformed",checkedIdentity?1:0,"actualIdentity",actual,"expectedIdentity",current.Stamp.ProcessIdentity,"currentOriginSeq",current.Stamp.OriginSeq,"currentSourceGeneration",current.Stamp.SourceSessionGeneration,"currentSelectionGeneration",current.Stamp.SelectionGeneration,"currentTransportConnectionId",current.Stamp.TransportConnectionId,"currentReceiptUtcMs",current.Stamp.ReceivedUtcMilliseconds));
    }
   }
   bool live=current!=null&&!invalid&&!telemetryStale;
   return new ReceiverView(owner,boundary,instant,live,live?"有效数据":"无有效数据",current,accepted.ToArray());
  }}
  public ReceiverView RenderCurrent(Action<ReceiverView> render){
   if(render==null)throw new ArgumentNullException("render");
   lock(gate){var view=Capture();render(view);return view;}
  }
  public ReceiverView SelectAndRender(int pid,Action<ReceiverView> render){
   if(render==null)throw new ArgumentNullException("render");
   lock(gate){Select(pid);var view=Capture();render(view);return view;}
  }
  public bool TryRender(ReceiverView view,Action render){lock(gate){
   // Recheck liveness at the final paint gate as well as during Capture: a
   // queued callback must not keep a dead/stale source visible.
   var fresh=Capture();
   if(view==null||render==null||!Object.ReferenceEquals(view.Owner,owner)||view.Boundary.Epoch!=epoch||view.Boundary.SelectionGeneration!=boundary.SelectionGeneration||view.Boundary.Watermark!=boundary.Watermark||view.Boundary.SelectedPid!=boundary.SelectedPid)return false;
   if(view.Live!=fresh.Live)return false;
   if((view.Current==null)!=(current==null))return false;
   if(view.Current!=null&&(view.Current.Stamp.FrameId!=current.Stamp.FrameId||view.Current.Stamp.SourceSessionGeneration!=current.Stamp.SourceSessionGeneration||view.Current.Stamp.ProcessIdentity!=current.Stamp.ProcessIdentity))return false;
   render();return true;
  }}
  public Dictionary<string,object>[] GetSamples(){lock(gate){var values=new List<Dictionary<string,object>>();foreach(var sample in latest.Values)values.Add(sample.Data);values.Sort((a,b)=>Convert.ToInt64(b["startedAt"]).CompareTo(Convert.ToInt64(a["startedAt"])));return values.ToArray();}}
 }
}
