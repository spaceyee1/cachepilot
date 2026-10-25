// Original CachePilot API monitor: strict numeric telemetry, no prompts or credentials.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace CachePilotMonitor {
 public sealed class ApiScope {
  public readonly string ScopeId,ProfileId,Protocol,Source;
  public readonly long Requests,ReportedRequests,InputTokens,CacheObservedInputTokens,CacheReadTokens,CacheWriteTokens,OutputTokens,UnknownUsageRequests;
  public ApiScope(string id,string profile,string protocol,string source,long requests,long reported,long input,long observed,long read,long write,long output,long unknown){ScopeId=id;ProfileId=profile;Protocol=protocol;Source=source;Requests=requests;ReportedRequests=reported;InputTokens=input;CacheObservedInputTokens=observed;CacheReadTokens=read;CacheWriteTokens=write;OutputTokens=output;UnknownUsageRequests=unknown;}
  public bool Follows(ApiScope before){return before==null||before.ProfileId==ProfileId&&before.Protocol==Protocol&&before.Source==Source&&Requests>=before.Requests&&ReportedRequests>=before.ReportedRequests&&InputTokens>=before.InputTokens&&CacheObservedInputTokens>=before.CacheObservedInputTokens&&CacheReadTokens>=before.CacheReadTokens&&CacheWriteTokens>=before.CacheWriteTokens&&OutputTokens>=before.OutputTokens&&UnknownUsageRequests>=before.UnknownUsageRequests&&CacheReadTokens-before.CacheReadTokens<=CacheObservedInputTokens-before.CacheObservedInputTokens&&CacheObservedInputTokens-before.CacheObservedInputTokens<=InputTokens-before.InputTokens;}
 }
 public sealed class ApiFrame {
  public readonly int Pid; public readonly long Sequence,CreatedAt; public readonly string Session;public readonly ApiScope[] Scopes;
  public ApiFrame(int pid,long sequence,long created,string session,ApiScope[] scopes){Pid=pid;Sequence=sequence;CreatedAt=created;Session=session;Scopes=scopes;}
 }
 public static class ApiCodec {
  static void Fail(){throw new FormatException("Invalid numeric telemetry frame");}
  static long N(Dictionary<string,object> d,string key){object item;if(!d.TryGetValue(key,out item)||!(item is int||item is long||item is decimal))throw new FormatException("Missing integer counter");decimal n=Convert.ToDecimal(item);if(n<0||n>9007199254740991m||Decimal.Truncate(n)!=n)throw new FormatException("Invalid integer counter");return Decimal.ToInt64(n);}
  static string S(Dictionary<string,object> d,string key){object o;return d.TryGetValue(key,out o)?o as string:null;}
  public static ApiFrame Parse(string text,uint actualPid,long utc){
   if(text==null||System.Text.Encoding.UTF8.GetByteCount(text)>16384)Fail();
   var d=new JavaScriptSerializer{MaxJsonLength=16384,RecursionLimit=5}.DeserializeObject(text) as Dictionary<string,object>;
   if(d==null||d.Count!=9||N(d,"schema")!=3||S(d,"kind")!="api"||(S(d,"version")!="0.1.1"&&S(d,"version")!="0.1.2-semantic.1")||S(d,"device")!="off")Fail();
   long pid=N(d,"pid"),seq=N(d,"sequence"),created=N(d,"createdAt");string session=S(d,"processSession");object scopesRaw=null;
   if(pid<=0||pid>Int32.MaxValue||pid!=actualPid||seq<1||!Regex.IsMatch(session??"",@"\A[a-f0-9]{32}\z")||created>utc+5000||created<utc-4000||!d.TryGetValue("scopes",out scopesRaw))Fail();
   var scopes=scopesRaw as object[];if(scopes==null||scopes.Length>16)Fail();var result=new List<ApiScope>();var ids=new HashSet<string>(StringComparer.Ordinal);
   foreach(var item in scopes){var s=item as Dictionary<string,object>;if(s==null||s.Count!=12)Fail();string id=S(s,"scopeId"),profile=S(s,"profileId"),protocol=S(s,"protocol"),source=S(s,"source");
    if(!Regex.IsMatch(id??"",@"\A[a-f0-9]{64}\z")||!ids.Add(id)||!Regex.IsMatch(profile??"",@"\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}\z")||!new[]{"openai-responses","openai-chat","deepseek-chat","anthropic-messages","gemini"}.Contains(protocol)||!new[]{"interface_reported","offline_fixture"}.Contains(source))Fail();
    long requests=N(s,"requests"),reported=N(s,"reportedRequests"),input=N(s,"inputTokens"),observed=N(s,"cacheObservedInputTokens"),read=N(s,"cacheReadTokens"),write=N(s,"cacheWriteTokens"),output=N(s,"outputTokens"),unknown=N(s,"unknownUsageRequests");
    if(reported>requests||unknown>requests||reported+unknown>requests||read>observed||observed>input||reported==0&&(observed!=0||read!=0)||write>0&&reported+unknown==0)Fail();
    result.Add(new ApiScope(id,profile,protocol,source,requests,reported,input,observed,read,write,output,unknown));
   }
   return new ApiFrame((int)pid,seq,created,session,result.ToArray());
  }
 }
 public sealed class ApiTicket {
  internal readonly object Owner;public readonly int Pid;public readonly long Origin,Identity;internal long? Received;
  internal ApiTicket(object owner,int pid,long origin,long identity){Owner=owner;Pid=pid;Origin=origin;Identity=identity;}
 }
 public sealed class ApiReceipt {
  public readonly ApiScope Scope;public readonly string Session;public readonly int Pid;public readonly long Origin,At,Sequence,Identity;
  internal ApiReceipt(ApiScope scope,ApiFrame frame,ApiTicket ticket,long at){Scope=scope;Session=frame.Session;Pid=frame.Pid;Origin=ticket.Origin;At=at;Sequence=frame.Sequence;Identity=ticket.Identity;}
 }
 public sealed class ApiView {
  public readonly int Pid;public readonly string ScopeId,State;public readonly long Watermark,Generation,Now;public readonly ApiReceipt[] Receipts;public readonly ApiReceipt Current;
  internal ApiView(int pid,string scope,long water,long generation,long now,string state,ApiReceipt[] values){Pid=pid;ScopeId=scope;Watermark=water;Generation=generation;Now=now;State=state;Receipts=values;Current=values.Length==0?null:values[values.Length-1];}
 }
 public sealed class ApiChoice {
  public readonly int Pid;public readonly string ScopeId,ProfileId,Protocol,Source;
  public ApiChoice(int pid,ApiScope s){Pid=pid;ScopeId=s.ScopeId;ProfileId=s.ProfileId;Protocol=s.Protocol;Source=s.Source;}
  public override string ToString(){return "PID "+Pid+" · "+ProfileId+" · "+Protocol+" · "+ScopeId.Substring(0,8)+(Source=="offline_fixture"?" · 离线测试":"");}
 }
 public sealed class ApiReceiver {
  sealed class Source {public long Identity,Sequence,At;public string Session;public readonly Dictionary<string,ApiScope> Scopes=new Dictionary<string,ApiScope>();}
  readonly object gate=new object(),owner=new object();readonly Func<long> clock;readonly Func<int,long?> identity;readonly bool fixtures;
  readonly Dictionary<int,Source> sources=new Dictionary<int,Source>();readonly List<ApiReceipt> accepted=new List<ApiReceipt>();
  long issued,watermark,generation;int selected;string scopeId;bool invalid=true;
  public const int MaximumFrames=8192,MaximumSources=32;
  public ApiReceiver():this(Stopwatch.StartNew(),false){}
  ApiReceiver(Stopwatch clock,bool allowFixtures):this(()=>clock.ElapsedMilliseconds,ProcessIdentity,allowFixtures){}
  public ApiReceiver(Func<long> clock,Func<int,long?> identity,bool allowFixtures){this.clock=clock;this.identity=identity;fixtures=allowFixtures;}
  static long? ProcessIdentity(int pid){try{using(var p=Process.GetProcessById(pid))return p.HasExited?(long?)null:p.StartTime.ToUniversalTime().Ticks;}catch{return null;}}
  long Identity(int pid){try{return identity(pid)??-1;}catch{return -1;}}
  void Advance(){accepted.Clear();watermark=issued;generation++;invalid=true;}
  public void Select(int pid,string id){lock(gate){if(pid!=selected||id!=scopeId||generation==0){selected=pid;scopeId=id;Advance();}}}
  public ApiTicket Reserve(int actualPid){lock(gate){if(actualPid<=0||issued==Int64.MaxValue)throw new InvalidOperationException("Receiver capacity");return new ApiTicket(owner,actualPid,++issued,Identity(actualPid));}}
  public void MarkBytes(ApiTicket t){lock(gate){if(t!=null&&Object.ReferenceEquals(t.Owner,owner)&&!t.Received.HasValue)t.Received=clock();}}
  public void Reject(ApiTicket t){lock(gate){if(t!=null&&Object.ReferenceEquals(t.Owner,owner)&&t.Pid==selected&&t.Origin>watermark)Advance();}}
  public bool Commit(ApiTicket t,ApiFrame frame){lock(gate){
   if(t==null||!Object.ReferenceEquals(t.Owner,owner)||frame==null||!t.Received.HasValue||frame.Pid!=t.Pid||t.Identity<0||Identity(t.Pid)!=t.Identity)return false;
   if(t.Pid==selected&&t.Origin<=watermark)return false;
   long now=clock();if(now<t.Received.Value||now-t.Received.Value>=4000){Reject(t);return false;}
   Source source;if(!sources.TryGetValue(t.Pid,out source)){
    if(sources.Count>=MaximumSources){var oldest=sources.Where(p=>p.Key!=selected).OrderBy(p=>p.Value.At).FirstOrDefault();if(oldest.Value!=null)sources.Remove(oldest.Key);}
    if(sources.Count>=MaximumSources)return false;source=new Source{Identity=t.Identity,Session=frame.Session};sources.Add(t.Pid,source);
   }
   bool changed=source.Identity!=t.Identity||source.Session!=frame.Session;
   if(!changed&&frame.Sequence<=source.Sequence)return false;
   bool reset=false;foreach(var s in frame.Scopes){ApiScope old;source.Scopes.TryGetValue(s.ScopeId,out old);if(!s.Follows(old))reset=true;}
   if(changed||reset){source.Identity=t.Identity;source.Session=frame.Session;source.Sequence=frame.Sequence;source.Scopes.Clear();source.At=now;if(t.Pid==selected)Advance();return false;}
   source.Sequence=frame.Sequence;source.At=t.Received.Value;source.Scopes.Clear();foreach(var s in frame.Scopes)source.Scopes.Add(s.ScopeId,s);
   if(t.Pid==selected){ApiScope chosen;if(!source.Scopes.TryGetValue(scopeId??"",out chosen)||chosen.Source=="offline_fixture"&&!fixtures){Advance();return true;}
    accepted.Add(new ApiReceipt(chosen,frame,t,t.Received.Value));invalid=false;
    long lower=now-120000;while(accepted.Count>0&&accepted[0].At<lower)accepted.RemoveAt(0);
    if(accepted.Count>MaximumFrames){Advance();return false;}
   }
   return true;
  }}
  ApiView CaptureCore(){long now=clock();if(accepted.Count>0){var last=accepted[accepted.Count-1];if(now<last.At||now-last.At>=4000||Identity(selected)!=last.Identity)Advance();}long cutoff=now-120000;while(accepted.Count>0&&accepted[0].At<cutoff)accepted.RemoveAt(0);return new ApiView(selected,scopeId,watermark,generation,now,invalid?"无有效数据":"实时",accepted.ToArray());}
  public ApiView Capture(){lock(gate)return CaptureCore();}
  public ApiView Render(Action<ApiView> paint){lock(gate){var v=CaptureCore();paint(v);return v;}}
  public ApiView SelectAndRender(int pid,string id,Action<ApiView> paint){lock(gate){Select(pid,id);return Render(paint);}}
  public ApiChoice[] Choices(){lock(gate){var result=new List<ApiChoice>();foreach(var p in sources)foreach(var s in p.Value.Scopes.Values)if(fixtures||s.Source!="offline_fixture")result.Add(new ApiChoice(p.Key,s));return result.OrderBy(v=>v.Pid).ThenBy(v=>v.ProfileId).ToArray();}}
 }
 public sealed class ApiPoint {
  public readonly long At,TokenDelta,InputDelta,ReadDelta;public readonly double? Rate;
  public ApiPoint(long at,long tokens,long input,long read,double? rate){At=at;TokenDelta=tokens;InputDelta=input;ReadDelta=read;Rate=rate;}
 }
 public sealed class ApiHistory {
  public readonly List<ApiPoint> Points=new List<ApiPoint>();public string State="无有效数据",Tokens="未测量",Rate="未测量";public long ObservedMilliseconds;public ApiReceipt Baseline;
  public double Maximum {get{return Math.Max(1,Points.Count==0?1:Points.Max(p=>(double)p.TokenDelta));}}
  public void Update(ApiView view){Points.Clear();Baseline=null;ObservedMilliseconds=0;State="无有效数据";Tokens=Rate="未测量";if(view==null||view.Current==null||view.Receipts.Length==0)return;
   var values=view.Receipts;Baseline=values[0];State=Tokens=Rate="基线建立中";if(values.Length==1)return;
   var b=Baseline.Scope;var last=values[values.Length-1];ObservedMilliseconds=last.At-Baseline.At;
   for(int i=1;i<values.Length;i++){var r=values[i];if(r.Pid!=view.Pid||r.Scope.ScopeId!=view.ScopeId||r.Session!=Baseline.Session||r.Origin<=view.Watermark||!r.Scope.Follows(b)){Points.Clear();Baseline=null;State="无有效数据";Tokens=Rate="未测量";return;}
    long token=r.Scope.InputTokens-b.InputTokens,den=r.Scope.CacheObservedInputTokens-b.CacheObservedInputTokens,hit=r.Scope.CacheReadTokens-b.CacheReadTokens;
    long reported=r.Scope.ReportedRequests-b.ReportedRequests;
    if(i>=2&&(token>0||reported>0))Points.Add(new ApiPoint(r.At,token,den,hit,reported>0&&den>0&&hit<=den?(double?)(100.0*hit/den):null));
   }
   if(values.Length<3){State=Tokens=Rate="样本不足";return;}
   var end=last.Scope;long tokens=end.InputTokens-b.InputTokens,denom=end.CacheObservedInputTokens-b.CacheObservedInputTokens,read=end.CacheReadTokens-b.CacheReadTokens,known=end.ReportedRequests-b.ReportedRequests;
   Tokens=tokens>0||known>0?tokens.ToString("N0",CultureInfo.InvariantCulture):"未测量";
   if(known==0||denom<=0){State="样本不足";Rate=end.ReportedRequests==0?"未测量":"样本不足";return;}
   State="实时";Rate=(100.0*read/denom).ToString("F1",CultureInfo.InvariantCulture)+"%";
  }
  public static void Draw(Canvas canvas,ApiHistory history,bool rate,long now){canvas.Children.Clear();double width=canvas.ActualWidth>0?canvas.ActualWidth:canvas.Width,height=canvas.ActualHeight>0?canvas.ActualHeight:canvas.Height;if(Double.IsNaN(width)||width<4||Double.IsNaN(height)||height<4)return;
   var line=new Polyline{Stroke=new SolidColorBrush(rate?Color.FromRgb(124,227,199):Color.FromRgb(145,193,255)),StrokeThickness=1.8};
   double maximum=history.Maximum;
   foreach(var p in history.Points){if(rate&&!p.Rate.HasValue){if(line.Points.Count>1)canvas.Children.Add(line);line=new Polyline{Stroke=new SolidColorBrush(Color.FromRgb(124,227,199)),StrokeThickness=1.8};continue;}long age=now-p.At;if(age<0||age>120000)continue;line.Points.Add(new Point(2+(width-4)*(1-age/120000.0),2+(height-4)*(1-(rate?p.Rate.Value/100:p.TokenDelta/maximum))));}
   if(line.Points.Count>1)canvas.Children.Add(line);else if(line.Points.Count==1){var dot=new Ellipse{Width=4,Height=4,Fill=line.Stroke};Canvas.SetLeft(dot,line.Points[0].X-2);Canvas.SetTop(dot,line.Points[0].Y-2);canvas.Children.Add(dot);}
  }
 }
}
