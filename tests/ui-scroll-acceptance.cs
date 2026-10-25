using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;
using CachePilotMonitor;

// In-process WPF components only: no visible window, real input, pipe or API.
public static class ScrollAcceptance {
 const int Pid=51003;
 static string xaml,currentCase;
 static int assertions,failures;
 static readonly List<object> Cases=new List<object>();
 static readonly List<object> Measurements=new List<object>();
 static string Text(Window w,string name){return ((TextBlock)w.FindName(name)).Text;}
 static void Check(bool ok,string reason){assertions++;if(!ok)throw new Exception(reason);}
 static void Run(string name,Action action){currentCase=name;int before=assertions;try{action();Cases.Add(new{name,passed=true,assertions=assertions-before});}catch(Exception error){failures++;Cases.Add(new{name,passed=false,assertions=assertions-before,error=error.GetType().Name,reason=error.Message});}}
 static void Pump(){Dispatcher.CurrentDispatcher.Invoke(DispatcherPriority.Background,new Action(()=>{}));}
 static bool HasPercent(Window w){return Text(w,"WindowRateValue").Contains("%");}
 sealed class Fixture:IDisposable {
  public readonly Window Window;
  public readonly FrameworkElement Root;
  public readonly ScrollViewer Scroll;
  public readonly MonitorHistory History=new MonitorHistory();
  public readonly MonitorReceiver Receiver;
  public long Now=1000;
  double height=600;
  public Fixture(){
   Window=(Window)XamlReader.Parse(File.ReadAllText(xaml,Encoding.UTF8));Root=(FrameworkElement)Window.Content;
   Scroll=(ScrollViewer)Window.FindName("MainScroller");
   Receiver=new MonitorReceiver(()=>Now,()=>1700000000000L+Now,p=>p==Pid,p=>p==Pid?(long?)1:null);Receiver.Select(Pid);
   MonitorApp.SetDetailsFolded(Window,false);((Expander)Window.FindName("ApiDetails")).IsExpanded=true;((Expander)Window.FindName("CloudDetails")).IsExpanded=true;
  }
  public void Layout(double availableHeight){
   height=availableHeight;MonitorApp.ConfigureViewport(Window,height);
   Root.Measure(new Size(440,Math.Max(1,height-24)));Root.Arrange(new Rect(0,0,440,Math.Min(Root.DesiredSize.Height,Math.Max(1,height-24))));Root.UpdateLayout();Pump();Root.UpdateLayout();
  }
  public void SetFolded(bool folded){MonitorApp.SetDetailsFolded(Window,folded);Layout(height);}
  public void Paint(){MonitorApp.ApplyCurrent(Window,History,Receiver,p=>p==Pid);Layout(height);}
  public void Send(long? tokens,long? inputs,long? hits){
   Now+=1000;long h=hits??0,n=inputs??0;
   var raw=new Dictionary<string,object>{{"schema",2},{"pid",Pid},{"startedAt",100000},{"sampledAt",1700000000000L+Now},{"version","0.6.8"},{"device","off"},{"backend","estimate"},{"hits",h},{"misses",n-h},{"reusedWithinCall",0},{"tokenizations",n},{"preparations",0},{"promptPreparations",0},{"failures",0},{"active",0},{"queued",0},{"rss",4096},{"providerCacheMeasured",false},{"hostRequestsIntercepted",false},{"analyses",inputs.HasValue?(object)inputs.Value:null},{"inputPositions",inputs.HasValue?(object)inputs.Value:null},{"cacheHitPositions",hits.HasValue?(object)hits.Value:null},{"cacheMissPositions",inputs.HasValue&&hits.HasValue?(object)(inputs.Value-hits.Value):null},{"lastInputTokens",tokens.HasValue?(object)0:null},{"totalInputTokens",tokens.HasValue?(object)tokens.Value:null},{"lastCompletedAt",1700000000000L+Now}};
   var ticket=Receiver.Reserve(Pid);Receiver.MarkBytes(ticket);var parsed=FrameCodec.Parse(new JavaScriptSerializer().Serialize(raw),Pid,1700000000000L+Now);
   Check(Receiver.Commit(ticket,parsed,0),"synthetic frame must be accepted");Receiver.EndTransport(ticket,true);Paint();
  }
  public void SixInputs(){Send(494,15,7);Send(590,18,9);Send(686,21,10);}
  public void Wheel(string name,int delta){Wheel((UIElement)Window.FindName(name),delta);}
  public void Wheel(UIElement target,int delta){var args=new MouseWheelEventArgs(Mouse.PrimaryDevice,Environment.TickCount,delta){RoutedEvent=Mouse.MouseWheelEvent,Source=target};target.RaiseEvent(args);Pump();Root.UpdateLayout();}
  public void Top(){Scroll.ScrollToTop();Pump();Root.UpdateLayout();}
  public bool InViewport(string name){var control=(FrameworkElement)Window.FindName(name);var rect=control.TransformToAncestor(Scroll).TransformBounds(new Rect(new Point(0,0),control.RenderSize));return control.Visibility==Visibility.Visible&&rect.Top>=-1&&rect.Bottom<=Scroll.ViewportHeight+1;}
  public void Dispose(){Window.Close();}
 }
 static void ScrollHeight(double height){using(var f=new Fixture()){
  f.SixInputs();f.Layout(height);f.Top();
  Check(!Double.IsInfinity(f.Scroll.MaxHeight)&&f.Scroll.MaxHeight<=height-46,"finite viewport reserves window and border space");
  Check(f.Scroll.ViewportHeight>0&&f.Scroll.ScrollableHeight>0,"expanded API/local/cloud content must overflow the constrained viewport");
  Check(!(f.Window.FindName("DetailsScroller") is ScrollViewer),"details must not contain a second page scroll owner");
  double before=f.Scroll.VerticalOffset;f.Wheel("ApiStats",-120);Check(f.Scroll.VerticalOffset>before,"wheel down over API content must move the page");
  before=f.Scroll.VerticalOffset;f.Wheel("ApiStats",120);Check(f.Scroll.VerticalOffset<before,"wheel up over API content must move the page");
  f.Top();int wheels=0;while(f.Scroll.VerticalOffset<f.Scroll.ScrollableHeight-0.5&&wheels++<200)f.Wheel("Counts",-120);
  Check(f.Scroll.VerticalOffset>=f.Scroll.ScrollableHeight-0.5,"wheel must reach bottom without ScrollToEnd");Check(f.InViewport("Updated"),"last status line must be reachable in viewport");
  while(f.Scroll.VerticalOffset>0.5&&wheels++<400)f.Wheel("Counts",120);Check(f.Scroll.VerticalOffset<=0.5,"wheel must return to top");
  Measurements.Add(new{test=currentCase,workAreaHeight=height,viewport=f.Scroll.ViewportHeight,extent=f.Scroll.ExtentHeight,scrollable=f.Scroll.ScrollableHeight,wheels});
 }}
 static void ChildOwnsWheel(string name){using(var f=new Fixture()){
  f.SixInputs();f.Layout(480);f.Top();var child=(UIElement)f.Window.FindName(name);int received=0;
  MouseWheelEventHandler handler=(s,e)=>{received++;e.Handled=true;};child.AddHandler(Mouse.MouseWheelEvent,handler,true);
  double before=f.Scroll.VerticalOffset;f.Wheel(child,-120);child.RemoveHandler(Mouse.MouseWheelEvent,handler);
  Check(received==1,"child control must receive its routed wheel event");Check(f.Scroll.VerticalOffset==before,"page must not steal a wheel event handled by a child");
 }}
 static void Tests(){
  Run("SCROLL01 finite 480 DIP, API/local/cloud expanded, routed wheel both directions",()=>ScrollHeight(480));
  Run("SCROLL02 finite 600 DIP, API/local/cloud expanded, routed wheel both directions",()=>ScrollHeight(600));
  Run("SCROLL03 finite 900 DIP, API/local/cloud expanded, routed wheel both directions",()=>ScrollHeight(900));
  Run("SCROLL04 wheel over both local chart canvases",()=>{using(var f=new Fixture()){f.SixInputs();f.Layout(480);f.Top();f.Wheel("TokenChart",-120);Check(f.Scroll.VerticalOffset>0,"token chart must not block page wheel");double before=f.Scroll.VerticalOffset;f.Wheel("RateChart",-120);Check(f.Scroll.VerticalOffset>before,"rate chart must not block page wheel");}});
  Run("SCROLL05 folding returns to charts without clearing receiver/history",()=>{using(var f=new Fixture()){f.SixInputs();f.Layout(480);f.Scroll.ScrollToEnd();Pump();int frames=f.Receiver.Capture().AcceptedSamples.Length;long watermark=f.Receiver.Capture().Boundary.Watermark;var tokens=f.History.CalculatedWindowTokens;f.SetFolded(true);Check(f.Scroll.VerticalOffset<0.5,"fold must return to top");Check(f.InViewport("TokenChart")&&f.InViewport("RateChart"),"folded view retains both local charts");Check(f.Receiver.Capture().AcceptedSamples.Length==frames&&f.Receiver.Capture().Boundary.Watermark==watermark,"fold does not issue or discard frames");Check(f.History.CalculatedWindowTokens==tokens,"fold does not recalculate token totals");f.SetFolded(false);Check(((FrameworkElement)f.Window.FindName("DetailsScroller")).Visibility==Visibility.Visible,"details unfold");}});
  Run("SCROLL06 handled ComboBox wheel belongs to child",()=>ChildOwnsWheel("Instances"));
  Run("SCROLL07 handled Slider wheel belongs to child",()=>ChildOwnsWheel("OpacitySlider"));
  Run("SCROLL08 short collapsed content needs no invented overflow",()=>{using(var f=new Fixture()){f.SetFolded(true);((Expander)f.Window.FindName("ApiDetails")).IsExpanded=false;f.Layout(900);Check(f.Scroll.ScrollableHeight==0,"short page has no scroll range");f.Wheel("TokenChart",-120);Check(f.Scroll.VerticalOffset==0,"wheel at non-overflow boundary remains zero");}});
  Run("COUNTS01 percentage and visible 3 / 6 tokenizer input items",()=>{using(var f=new Fixture()){f.SixInputs();Check(Text(f.Window,"WindowRateValue")=="50.0%","window rate is 3/6, not process cumulative rate");Check(Text(f.Window,"WindowRateCounts")=="命中 3 / 6 个分词输入项","numerator and denominator must be actual visible text");Check(f.History.CalculatedWindowTokens==192,"window token difference is 686-494");f.Layout(480);f.SetFolded(true);Check(f.InViewport("WindowRateCounts"),"3/6 text must be inside folded480DIP viewport, not merely present in the tree");Check(((TextBlock)f.Window.FindName("WindowRateCounts")).ToolTip.ToString().Contains("不是 Token"),"counts explicitly exclude Token/request units");}});
  Run("COUNTS02 first frame establishes baseline without percentage",()=>{using(var f=new Fixture()){f.Send(494,15,7);Check(!HasPercent(f.Window),"baseline has no rate");Check(Text(f.Window,"WindowRateCounts").Contains("基线建立中"),"baseline is labelled");}});
  Run("COUNTS03 one post-baseline frame is insufficient",()=>{using(var f=new Fixture()){f.Send(494,15,7);f.Send(590,18,9);Check(!HasPercent(f.Window),"one new frame has no rate");Check(Text(f.Window,"WindowRateCounts").Contains("样本不足"),"insufficient frames are labelled");}});
  Run("COUNTS04 fewer than five input items keeps counts without percentage",()=>{using(var f=new Fixture()){f.Send(494,15,7);f.Send(526,16,8);f.Send(558,17,8);Check(!HasPercent(f.Window),"small denominator is not promoted to percentage");Check(Text(f.Window,"WindowRateCounts")=="命中 1 / 2 个分词输入项 · 样本不足","small-sample raw counts remain explicit");}});
  Run("COUNTS05 missing measurement denominator is not zero percent",()=>{using(var f=new Fixture()){f.Send(null,null,null);Check(!HasPercent(f.Window),"missing denominator has no rate");Check(Text(f.Window,"WindowRateCounts")=="分词输入项：无分母","missing field has explicit visible label");}});
  Run("COUNTS06 zero new inputs is not zero percent",()=>{using(var f=new Fixture()){f.Send(0,0,0);f.Send(0,0,0);f.Send(0,0,0);Check(!HasPercent(f.Window),"zero denominator has no percentage");Check(Text(f.Window,"WindowRateCounts").Contains("命中 0 / 0 个分词输入项")&&Text(f.Window,"WindowRateCounts").Contains("暂无新增输入"),"zero input status retains explicit units");}});
  Run("COUNTS07 repeated heartbeats and layout refresh do not add Token/items",()=>{using(var f=new Fixture()){f.SixInputs();f.Send(686,21,10);int frames=f.Receiver.Capture().AcceptedSamples.Length;for(int i=0;i<4;i++){f.Layout(480+i*100);f.Paint();f.Wheel("ApiStats",-120);}Check(f.Receiver.Capture().AcceptedSamples.Length==frames,"refresh is not a receipt");Check(f.History.CalculatedWindowTokens==192&&f.History.WindowHitPositions==3&&f.History.WindowInputPositions==6,"heartbeat and rendering preserve 192 and 3/6");}});
  Run("COUNTS08 stale source clears numerator denominator and percentage",()=>{using(var f=new Fixture()){f.SixInputs();f.Now+=4000;f.Paint();Check(!HasPercent(f.Window),"stale source has no percentage");Check(Text(f.Window,"WindowRateCounts")=="分词输入项：无有效数据","old 3/6 is removed");}});
 }
 [STAThread]public static int Main(string[] args){
  if(args.Length!=2)return 2;xaml=Path.GetFullPath(args[0]);string output=Path.GetFullPath(args[1]);
  string candidate=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(xaml),".."));
  string[] allowed={Path.Combine(candidate,"validation")+Path.DirectorySeparatorChar,Path.Combine(candidate,"verification")+Path.DirectorySeparatorChar,Path.Combine(candidate,"tests")+Path.DirectorySeparatorChar};
  if(!allowed.Any(path=>output.StartsWith(path,StringComparison.OrdinalIgnoreCase))||!output.EndsWith(".json",StringComparison.OrdinalIgnoreCase)||File.Exists(output))return 2;
  Tests();var result=new{source="offline_fixture",uiVersion=MonitorApp.UiVersion,visibleWindowOpened=false,realDesktopInput=false,realPipeConnections=0,providerApiRequests=0,keyUsed=false,gpu="off",passed=Cases.Count-failures,failed=failures,cases=Cases,assertions,measurements=Measurements,limitations=new[]{"Routed in-process WPF events are not physical mouse/hit-test evidence.","Handled child wheel coverage does not open a real ComboBox popup.","Synthetic available heights do not verify real multi-monitor DPI/work-area changes."},checkedAtUtc=DateTimeOffset.UtcNow.ToString("o",CultureInfo.InvariantCulture)};
  string json=new JavaScriptSerializer().Serialize(result);using(var stream=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(stream,new UTF8Encoding(false)))writer.Write(json);Console.WriteLine(json);return failures==0?0:1;
 }
}
