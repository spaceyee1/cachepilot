using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;

namespace CachePilotMonitor {
 // Explicit candidate-only numeric audit. Never reads prompts, credentials or host logs.
 public sealed class MonitorAuditWriter:IDisposable {
  const long MaxBytes=64L*1024*1024;const long MaxRecords=250000;
  readonly FileStream file;readonly StreamWriter writer;
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=24};
  long sequence;bool closed,failed;
  public bool Failed{get{return failed;}}
  public MonitorAuditWriter(string uiFolder,string run){
   if(!Regex.IsMatch(run??"",@"\A[a-z0-9-]{1,64}\z"))throw new ArgumentException("Audit run rejected");
   string expected;
   using(var resource=typeof(MonitorAuditWriter).Assembly.GetManifestResourceStream("CachePilotMonitor.AuditRoot")){
    if(resource==null||resource.Length<1||resource.Length>4096)throw new ArgumentException("Audit root rejected");
    using(var reader=new StreamReader(resource,new UTF8Encoding(false,true)))expected=reader.ReadToEnd();
   }
   if(!Path.IsPathRooted(expected)||expected.StartsWith(@"\\")||expected.StartsWith("//"))throw new ArgumentException("Audit root rejected");
   expected=Path.GetFullPath(expected);
   string ui=Path.GetFullPath(uiFolder).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
   if(!String.Equals(ui,Path.Combine(expected,"ui"),StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Audit root rejected");
   string phase=expected;
   string folder=Path.Combine(phase,"validation");
   var chain=new Stack<string>();for(string p=folder;p!=null;p=Path.GetDirectoryName(p))chain.Push(p);
   foreach(string p in chain){if((Directory.Exists(p)||File.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Audit path rejected");}
   var user=WindowsIdentity.GetCurrent().User;var system=new SecurityIdentifier("S-1-5-18");
   var directoryAcl=new DirectorySecurity();directoryAcl.SetOwner(user);directoryAcl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{user,system})directoryAcl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   if(!Directory.Exists(folder))Directory.CreateDirectory(folder,directoryAcl);
   var fileAcl=new FileSecurity();fileAcl.SetOwner(user);fileAcl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{user,system})fileAcl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
   file=new FileStream(Path.Combine(folder,run+".jsonl"),FileMode.CreateNew,FileSystemRights.FullControl,FileShare.Read,4096,FileOptions.WriteThrough,fileAcl);
   writer=new StreamWriter(file,new UTF8Encoding(false));
   Write("lifecycle",new{eventName="opened",uiVersion=MonitorApp.UiVersion,windowPid=Process.GetCurrentProcess().Id,qpcFrequency=Stopwatch.Frequency});Flush();
  }
  void Write(string channel,object value){
   if(closed||failed)return;
   try{
    if(sequence>=MaxRecords||file.Length>=MaxBytes){failed=true;return;}
    string line=json.Serialize(new{schema=1,auditSeq=++sequence,utcMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),qpc=Stopwatch.GetTimestamp(),channel,data=value});
    if(Encoding.UTF8.GetByteCount(line)>262144){failed=true;return;}
    writer.WriteLine(line);
   }catch{failed=true;}
  }
  void Flush(){if(closed)return;try{writer.Flush();file.Flush();}catch{failed=true;}}
  public void NoteLifecycle(string eventName,string reason,int sourcePid){
   if(eventName!="ui-closing"&&eventName!="ui-closed"&&eventName!="dialog-returned")throw new ArgumentException("Audit event rejected");
   if(reason!="unattributed"&&reason!="close-button"&&reason!="smoke-deadline")throw new ArgumentException("Audit reason rejected");
   Write("lifecycle",new{eventName,reason,windowPid=Process.GetCurrentProcess().Id,sourcePid});Flush();
  }
  static string Text(Window window,string name){var item=window.FindName(name) as TextBlock;return item==null?null:item.Text;}
  static object Value(Dictionary<string,object> sample,string name){object value;return sample!=null&&sample.TryGetValue(name,out value)?value:null;}
  public void Capture(Bridge bridge,ReceiverView view,MonitorHistory history,Window window,int[] sourcePids,long timerMono){
   if(closed)return;
   try{
    foreach(var item in bridge.Receiver.DrainDiagnostics())Write("receiver",item);
    foreach(var item in bridge.DrainDiagnostics())Write("bridge",item);
    var boundary=view==null?null:view.Boundary;var current=view==null?null:view.Current;var stamp=current==null?null:current.Stamp;var sample=current==null?null:current.Data;
    Write("paint",new{windowPid=Process.GetCurrentProcess().Id,uiVersion=MonitorApp.UiVersion,timerMono,live=view!=null&&view.Live,sourcePids,
     selectedPid=boundary==null?0:boundary.SelectedPid,boundaryReason=boundary==null?null:boundary.Reason,boundaryEpoch=boundary==null?null:boundary.Epoch,boundaryWatermark=boundary==null?(long?)null:boundary.Watermark,boundaryGeneration=boundary==null?(long?)null:boundary.SelectionGeneration,boundaryAtMono=boundary==null?(long?)null:boundary.AtMilliseconds,
     receiverNow=view==null?(long?)null:view.NowMilliseconds,originSeq=stamp==null?(long?)null:stamp.OriginSeq,transportId=stamp==null?(long?)null:stamp.TransportConnectionId,sourceSessionGeneration=stamp==null?(long?)null:stamp.SourceSessionGeneration,processIdentity=stamp==null?(long?)null:stamp.ProcessIdentity,startedAt=stamp==null?(long?)null:stamp.StartedAt,receivedMono=stamp==null?(long?)null:stamp.ReceivedMonotonicMilliseconds,receivedUtc=stamp==null?(long?)null:stamp.ReceivedUtcMilliseconds,
     rawInputs=Value(sample,"inputPositions"),rawHits=Value(sample,"cacheHitPositions"),rawTokens=Value(sample,"totalInputTokens"),lastCompletedAt=Value(sample,"lastCompletedAt"),
     historyBaselineFrameId=history.BaselineFrameId,historyBaselineSeq=history.BaselineOriginSeq,historyBaselineUtc=history.BaselineReceivedAt,historyBaselineTokens=history.BaselineTokens,historyBaselineInputs=history.BaselineInputPositions,historyBaselineHits=history.BaselineHitPositions,coverageMs=history.ObservedMilliseconds,postBaselineFrames=history.PostBaselineFrameCount,
     windowInputs=history.WindowInputPositions,windowHits=history.WindowHitPositions,windowTokens=history.CalculatedWindowTokens,windowRateText=Text(window,"WindowRateValue"),windowCountsText=Text(window,"WindowRateCounts"),windowTokenText=Text(window,"WindowTokenValue"),lifetimeRateText=Text(window,"LocalRate"),lifetimeCountsText=Text(window,"Formula"),lifetimeTokensText=Text(window,"TotalTokens"),chartState=Text(window,"ChartState"),rateVisibility=((Canvas)window.FindName("RateChart")).Visibility.ToString(),
     receiverDropped=bridge.Receiver.DiagnosticDroppedCount,bridgeDropped=bridge.DiagnosticDroppedCount,auditFailed=failed});Flush();
   }catch{failed=true;}
  }
  public void Dispose(){if(closed)return;Write("lifecycle",new{eventName="closed",failed,records=sequence});Flush();closed=true;try{writer.Dispose();}catch{}try{file.Dispose();}catch{}}
 }
}
