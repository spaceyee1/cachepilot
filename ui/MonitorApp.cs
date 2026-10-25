using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;

[assembly: AssemblyVersion("0.1.1.9")]
[assembly: AssemblyFileVersion("0.1.1.9")]

namespace CachePilotMonitor {
 public static class MonitorApp {
  public const string UiVersion="0.1.1-ui.9";
  static bool Alive(int pid){try{using(var p=Process.GetProcessById(pid))return !p.HasExited;}catch{return false;}}
  public static void ConfigureViewport(Window window,double workAreaHeight){
   if(window==null)throw new ArgumentNullException("window");
   if(Double.IsNaN(workAreaHeight)||Double.IsInfinity(workAreaHeight)||workAreaHeight<=0)throw new ArgumentOutOfRangeException("workAreaHeight");
   // Reserve 12 DIP at each work-area edge; Border padding/border uses 22 DIP.
   // The sole scrolling owner has a finite viewport even under SizeToContent.
   window.MaxHeight=Math.Max(1,workAreaHeight-24);
   ((ScrollViewer)window.FindName("MainScroller")).MaxHeight=Math.Max(1,window.MaxHeight-22);
  }
  public static void SetDetailsFolded(Window window,bool folded){
   ((FrameworkElement)window.FindName("DetailsScroller")).Visibility=folded?Visibility.Collapsed:Visibility.Visible;
   var fold=(Button)window.FindName("FoldButton");fold.Content=folded?"▾":"▴";
   fold.ToolTip=folded?"展开本地与云端明细":"折叠：保留命中率、Token 与实时趋势";
   if(folded)((ScrollViewer)window.FindName("MainScroller")).ScrollToTop();
  }
  public static string WindowInputCountText(MonitorHistory history,Dictionary<string,object> sample){
   if(sample==null)return "分词输入项：无有效数据";
   object value;if(!sample.TryGetValue("inputPositions",out value)||value==null)return "分词输入项：无分母";
   if(!sample.TryGetValue("cacheHitPositions",out value)||value==null)return "分词输入项：缺命中数";
   if(!history.HasBaseline)return "分词输入项：无有效数据";
   if(history.PostBaselineFrameCount==0)return "分词输入项：基线建立中";
   if(!history.WindowInputPositions.HasValue||!history.WindowHitPositions.HasValue)return "分词输入项：样本不足";
   string counts="命中 "+history.WindowHitPositions.Value.ToString(CultureInfo.InvariantCulture)+" / "+history.WindowInputPositions.Value.ToString(CultureInfo.InvariantCulture)+" 个分词输入项";
   if(history.PostBaselineFrameCount<MonitorHistory.MinimumPostBaselineFrames)return counts+" · 样本不足";
   if(history.WindowInputPositions.Value==0)return counts+" · 暂无新增输入";
   return counts+(history.WindowInputPositions.Value<MonitorHistory.MinimumInputPositions?" · 样本不足":"");
  }
  public static void Apply(Window window,DisplayData data) {
   foreach(string name in new[]{"LocalRate","LastTokens","TokenCaption","TotalTokens","Counts","Formula","Work","Device","Updated","CacheName"}) {
    string property=name=="LocalRate"?"Rate":name;
    ((TextBlock)window.FindName(name)).Text=(string)typeof(DisplayData).GetField(property).GetValue(data);
   }
   var connection=(TextBlock)window.FindName("Connection");connection.Text=data.State;
   connection.Foreground=new SolidColorBrush(data.Live?Color.FromRgb(124,227,199):Color.FromRgb(232,189,116));
  }
  static string Axis(double value){return value>=1000000?(value/1000000).ToString("0.##",CultureInfo.InvariantCulture)+"M":value>=1000?(value/1000).ToString("0.##",CultureInfo.InvariantCulture)+"k":value.ToString("0",CultureInfo.InvariantCulture);}
  public static void PaintApi(Window window,ApiHistory history,ApiView view,bool running){
   history.Update(view);((TextBlock)window.FindName("ApiTokenValue")).Text=history.Tokens;((TextBlock)window.FindName("ApiRateValue")).Text=history.Rate;
   ((TextBlock)window.FindName("ApiConnection")).Text="API · "+(running?(view.Current==null?"无有效数据":"已连接 · 数据 PID "+view.Pid):"本机通道不可用 / 已被其他窗口占用")+" · 窗口 PID "+Process.GetCurrentProcess().Id+" · GPU 关闭";
   ((TextBlock)window.FindName("ApiChartState")).Text=history.State+" · 已观测 "+(history.ObservedMilliseconds/1000.0).ToString("F1",CultureInfo.InvariantCulture)+" 秒 · 水位 "+view.Watermark;
   var token=(Canvas)window.FindName("ApiTokenChart");var rate=(Canvas)window.FindName("ApiRateChart");ApiHistory.Draw(token,history,false,view.Now);ApiHistory.Draw(rate,history,true,view.Now);
   rate.Visibility=history.Points.Any(p=>p.Rate.HasValue)?Visibility.Visible:Visibility.Hidden;token.Visibility=history.Points.Count>0?Visibility.Visible:Visibility.Hidden;
   ((TextBlock)window.FindName("ApiScope")).Text="作用域：PID "+view.Pid+" · "+(view.ScopeId??"未选择")+" · 不跨作用域合并";
   var current=view.Current;string stats="作用域累计请求 / 输入 / 输出 / 缓存读写：未测量";
   if(current!=null){var s=current.Scope;stats=(s.Source=="offline_fixture"?"离线测试数据 · ":"接口报告 · ")+s.ProfileId+" · "+s.Protocol+"\n作用域累计请求 "+s.Requests+" · 有效缓存用量 "+s.ReportedRequests+" · 用量缺失/不完整 "+s.UnknownUsageRequests+"\n累计已知输入 "+s.InputTokens+" · 已知输出 "+s.OutputTokens+" · 同记录缓存分母 "+s.CacheObservedInputTokens+"\n累计缓存读取 "+(s.ReportedRequests>0?s.CacheReadTokens.ToString():"未测量")+" · 累计已报告写入 "+s.CacheWriteTokens+"（字段覆盖未提供，非完整用量，不计入读取命中）";}
   ((TextBlock)window.FindName("ApiStats")).Text=stats;
  }
  public static DisplayData DisplayFor(ReceiverView view,Func<int,bool> alive){
   if(view==null || !view.Live || view.Current==null){var empty=new DisplayData();empty.State="● 所选 PID "+(view==null?0:view.Boundary.SelectedPid)+" · 无有效数据";return empty;}
   var sample=view.Current.Data;var stamp=view.Current.Stamp;
   // Use the receiver's monotonic age. Wall-clock rollback cannot refresh a frame.
   long age=Math.Max(0,view.NowMilliseconds-stamp.ReceivedMonotonicMilliseconds);
   return DisplayData.Build(sample,stamp.ReceivedUtcMilliseconds+age,alive);
  }
  public static bool ApplyView(Window window,MonitorHistory history,MonitorReceiver receiver,ReceiverView view,Func<int,bool> alive){
   ReceiverView applied;return ApplyView(window,history,receiver,view,alive,out applied);
  }
  public static bool ApplyView(Window window,MonitorHistory history,MonitorReceiver receiver,ReceiverView view,Func<int,bool> alive,out ReceiverView applied){
   ReceiverView painted=null;
   bool used=receiver.TryRender(view,()=>{
    // A queued but still-live receipt may have crossed a rolling-window edge.
    // Recapture under the final gate instead of retaining the old UI time.
    painted=receiver.Capture();Paint(window,history,painted,alive);
   });
   applied=painted;return used;
  }
  static void Paint(Window window,MonitorHistory history,ReceiverView view,Func<int,bool> alive){
   history.Update(view,view.NowMilliseconds);Apply(window,DisplayFor(view,alive));
   MonitorGpuControls.RenderSource(window,view.Live&&view.Current!=null?view.Current.Data:null);
   RenderCharts(window,history,view.Current==null?null:view.Current.Data,view.NowMilliseconds,view.Live);
  }
  public static ReceiverView ApplyCurrent(Window window,MonitorHistory history,MonitorReceiver receiver,Func<int,bool> alive){
   return receiver.RenderCurrent(view=>Paint(window,history,view,alive));
  }
  public static ReceiverView ApplySelection(Window window,MonitorHistory history,MonitorReceiver receiver,int pid,Func<int,bool> alive){
   return receiver.SelectAndRender(pid,view=>Paint(window,history,view,alive));
  }
  public static object ReceiptEvidence(ReceiverView view,MonitorHistory history){
   var stamp=view==null||view.Current==null?null:view.Current.Stamp;
   var boundary=view==null?null:view.Boundary;
   return new{
    renderedAtUtc=DateTimeOffset.UtcNow.ToString("o",CultureInfo.InvariantCulture),
    receiverNow=view==null?(long?)null:view.NowMilliseconds,
    epoch=boundary==null?null:boundary.Epoch,
    selectedPid=boundary==null?0:boundary.SelectedPid,
    actualPid=stamp==null?(int?)null:stamp.ActualPid,
    selectionGeneration=boundary==null?(long?)null:boundary.SelectionGeneration,
    watermark=boundary==null?(long?)null:boundary.Watermark,
    originSeq=stamp==null?(long?)null:stamp.OriginSeq,
    frameOrdinal=stamp==null?(int?)null:stamp.FrameOrdinal,
    frameId=stamp==null?null:stamp.FrameId,
    transportConnectionId=stamp==null?(long?)null:stamp.TransportConnectionId,
    sourceSessionGeneration=stamp==null?(long?)null:stamp.SourceSessionGeneration,
    receivedMono=stamp==null?(long?)null:stamp.ReceivedMonotonicMilliseconds,
    receivedUtc=stamp==null?(long?)null:stamp.ReceivedUtcMilliseconds,
    baselineFrameId=history.BaselineFrameId,baselineOriginSeq=history.BaselineOriginSeq,
    baselineTokens=history.BaselineTokens,baselineInputPositions=history.BaselineInputPositions,baselineHits=history.BaselineHitPositions,
    postBaselineFrames=history.PostBaselineFrameCount,state=history.CurrentState
   };
  }
  public static void RenderCharts(Window window,MonitorHistory history,Dictionary<string,object> sample,long elapsedNow,bool live){
   if(sample!=null && Convert.ToInt32(sample["pid"])!=history.SelectedPid)sample=null;
   var tokenCanvas=(Canvas)window.FindName("TokenChart");var rateCanvas=(Canvas)window.FindName("RateChart");
   HistoryRenderer.Draw(tokenCanvas,history,false,elapsedNow);HistoryRenderer.Draw(rateCanvas,history,true,elapsedNow);
   tokenCanvas.Opacity=rateCanvas.Opacity=live?1:0.4;
   var points=history.Points;var last=history.LatestWindow;
   var scale=(TextBlock)window.FindName("TokenScale");scale.Text=points.Any(p=>p.WindowTokens.HasValue)?Axis(history.TokenAxisMaximum):"—";
   scale.ToolTip=points.Any(p=>p.WindowTokens.HasValue)?history.TokenAxisMaximum.ToString("N0",CultureInfo.InvariantCulture):"未测量";
   ((TextBlock)window.FindName("ChartTokenKind")).Text=sample==null?"本地":(string)sample["backend"]=="estimate"?"估算":"词表";
   bool tokenMeasured=live&&last!=null&&last.WindowTokens.HasValue;
   bool rateMeasured=live&&last!=null&&last.WindowHitRatePercent.HasValue;
   tokenCanvas.Visibility=tokenMeasured?Visibility.Visible:Visibility.Hidden;
   rateCanvas.Visibility=rateMeasured?Visibility.Visible:Visibility.Hidden;
   var tokenAxis=window.FindName("TokenAxis") as FrameworkElement;var rateAxis=window.FindName("RateAxis") as FrameworkElement;
   if(tokenAxis!=null)tokenAxis.Visibility=tokenMeasured?Visibility.Visible:Visibility.Hidden;
   if(rateAxis!=null)rateAxis.Visibility=rateMeasured?Visibility.Visible:Visibility.Hidden;
   ((TextBlock)window.FindName("WindowTokenValue")).Text=history.TokenValueText;
   ((TextBlock)window.FindName("WindowRateValue")).Text=history.RateValueText;
   ((TextBlock)window.FindName("WindowRateCounts")).Text=WindowInputCountText(history,sample);
   ((TextBlock)window.FindName("ChartState")).Text=history.CurrentState;
   ((TextBlock)window.FindName("WindowRateValue")).ToolTip="区间新增输入项："+(history.WindowInputPositions.HasValue?history.WindowInputPositions.Value.ToString(CultureInfo.InvariantCulture):"未形成区间")+"；基线后有效帧："+history.PostBaselineFrameCount+"。至少2帧且新增输入项不少于5才显示比例。";
   ((TextBlock)window.FindName("ChartWindowLabel")).Text="近 120 秒 · 已观测 "+(history.ObservedMilliseconds/1000.0).ToString("F1",CultureInfo.InvariantCulture)+" 秒";
   ((TextBlock)window.FindName("ChartOrigin")).Text=history.BaselineReceivedAt.HasValue?"区间起点："+DateTimeOffset.FromUnixTimeMilliseconds(history.BaselineReceivedAt.Value).ToLocalTime().ToString("HH:mm:ss zzz",CultureInfo.InvariantCulture)+" · 首帧起算，满 120 秒后滚动":"起点：打开 / 切换 / 硬失效重建后的首个有效快照";
   ((TextBlock)window.FindName("ChartSource")).Text="候选 UI "+UiVersion+"（未安装） · "+(sample==null?"所选 PID "+history.SelectedPid+" · 无有效数据":"核心 v"+sample["version"]+" · PID "+history.SelectedPid);
  }
  [STAThread] public static int Main(string[] args) {
   int smoke=0,preferredPid=0;string report=null,testPipe=null,auditRun=null,storageMode="user",profileId="default";MonitorAuditWriter audit=null;
   try {
    if(args.Any(arg=>new[]{"--audit-run","--smoke-seconds","--report","--test-pipe"}.Any(flag=>arg==flag||arg.StartsWith(flag+"=",StringComparison.Ordinal)))){Console.Error.WriteLine("DIAGNOSTICS_DISABLED");return 2;}
    foreach(string arg in args) {
     if(arg.StartsWith("--storage=")){storageMode=arg.Substring(10);if(storageMode!="user"&&storageMode!="portable")throw new ArgumentException();}
     else if(arg.StartsWith("--profile=")){profileId=arg.Substring(10);if(!Regex.IsMatch(profileId,@"\A[a-z0-9][a-z0-9_-]{0,63}\z")||Regex.IsMatch(profileId,@"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\z",RegexOptions.IgnoreCase))throw new ArgumentException();}
     else if(arg.StartsWith("--smoke-seconds=")){smoke=Int32.Parse(arg.Substring(16));if(smoke<1||smoke>60)throw new ArgumentException();}
     else if(arg.StartsWith("--report=")){report=arg.Substring(9);if(!Path.IsPathRooted(report)||report.StartsWith(@"\\")||report.StartsWith("//"))throw new ArgumentException();}
     else if(arg.StartsWith("--pid=")){preferredPid=Int32.Parse(arg.Substring(6));if(preferredPid<=0)throw new ArgumentException();}
     else if(arg.StartsWith("--test-pipe=")){testPipe=arg.Substring(12);if(!Regex.IsMatch(testPipe,@"^cachepilot-test-[a-fA-F0-9-]{16,64}$"))throw new ArgumentException();}
     else if(arg.StartsWith("--audit-run=")){auditRun=arg.Substring(12);if(!Regex.IsMatch(auditRun,@"\A[a-z0-9-]{1,64}\z"))throw new ArgumentException();}
     else throw new ArgumentException();
    }
    if((smoke>0)!=(report!=null))throw new ArgumentException();
    if(testPipe!=null&&smoke==0)throw new ArgumentException();
    if(report!=null){
     string allowed=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","validation"))+Path.DirectorySeparatorChar;
     report=Path.GetFullPath(report);
     if(!report.StartsWith(allowed,StringComparison.OrdinalIgnoreCase)||!report.EndsWith(".json",StringComparison.OrdinalIgnoreCase)||File.Exists(report))throw new ArgumentException();
    }
    // The verified in-memory markup is parsed before any audit output or pipe.
    var window=MonitorXamlLoader.LoadOwnWindow();
    if(auditRun!=null)audit=new MonitorAuditWriter(AppDomain.CurrentDomain.BaseDirectory,auditRun);
    using(var bridge=testPipe==null?new Bridge():new Bridge(testPipe)) using(var apiBridge=testPipe==null?new ApiBridge():new ApiBridge("cachepilot-api-test-"+Guid.NewGuid().ToString("N"),true)) {
     string localFailure=null;try{bridge.Start();}catch{localFailure="本地监控通道不可用 / 已被其他窗口占用";}
     // The API pipe is independent: an existing local monitor is never stopped.
     try{apiBridge.Start();}catch{}
     ((TextBlock)window.FindName("WindowIdentity")).Text="候选 UI "+UiVersion+" · 窗口 PID "+Process.GetCurrentProcess().Id+" · 未安装";
     MonitorGpuControls.Attach(window,Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..")),storageMode,profileId);
     ((Button)window.FindName("BindApiButton")).Click+=(s,e)=>{
      try{
       // Only a user click launches the fixed sibling native UI. No shell,
       // credential, URL, script, or environment argument is constructed.
       string helper=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"CachePilot.ApiLocalHelper.exe"));
       if(!File.Exists(helper))throw new IOException();
       var start=new ProcessStartInfo{FileName=helper,Arguments="bind",WorkingDirectory=AppDomain.CurrentDomain.BaseDirectory,UseShellExecute=false,CreateNoWindow=true,ErrorDialog=false};
       using(var process=Process.Start(start)){if(process==null)throw new IOException();}
      }catch{MessageBox.Show("本机绑定窗口暂不可用。请核对候选文件完整性。","CachePilot");}
     };
     if(smoke>0)window.Title="CachePilot API · "+UiVersion+" 候选离线验收（合成数据）";
     var choices=(ComboBox)window.FindName("Instances");var fold=(Button)window.FindName("FoldButton");var details=(StackPanel)window.FindName("DetailsPanel");
     var apiChoices=(ComboBox)window.FindName("ApiInstances");var apiHistory=new ApiHistory();bool updatingApiChoices=false;
     Action refreshApi=()=>apiBridge.Receiver.Render(v=>PaintApi(window,apiHistory,v,apiBridge.Running));
     SelectionChangedEventHandler apiChanged=(s,e)=>{if(updatingApiChoices)return;var choice=apiChoices.SelectedItem as ApiChoice;if(choice!=null)apiBridge.Receiver.SelectAndRender(choice.Pid,choice.ScopeId,v=>PaintApi(window,apiHistory,v,apiBridge.Running));};
     apiChoices.SelectionChanged+=apiChanged;
     Action updateApiChoices=()=>{
      var before=apiChoices.SelectedItem as ApiChoice;var all=apiBridge.Receiver.Choices().ToList();
      if(before!=null&&!all.Any(c=>c.Pid==before.Pid&&c.ScopeId==before.ScopeId))all.Insert(0,before);
      string oldKey=String.Join(";",apiChoices.Items.Cast<ApiChoice>().Select(c=>c.Pid+":"+c.ScopeId));string newKey=String.Join(";",all.Select(c=>c.Pid+":"+c.ScopeId));
      if(oldKey==newKey)return;updatingApiChoices=true;try{apiChoices.Items.Clear();foreach(var c in all)apiChoices.Items.Add(c);apiChoices.SelectedItem=before==null?all.FirstOrDefault():all.FirstOrDefault(c=>c.Pid==before.Pid&&c.ScopeId==before.ScopeId);}finally{updatingApiChoices=false;}
      var chosen=apiChoices.SelectedItem as ApiChoice;if(chosen!=null)apiBridge.Receiver.Select(chosen.Pid,chosen.ScopeId);
     };
     var slider=(Slider)window.FindName("OpacitySlider");var opacity=(TextBlock)window.FindName("OpacityLabel");
     var area=SystemParameters.WorkArea;ConfigureViewport(window,area.Height);window.Left=Math.Max(area.Left,area.Right-window.Width-24);window.Top=area.Top+12;
     bool everConnected=false,nativeVisible=false,folded=true,chartsVisibleWhenFolded=false;
     var selection=new MonitorSelection(choices);
     if(preferredPid>0)selection.PinPid(preferredPid);
     var latest=new Dictionary<string,object>[0];var display=new DisplayData();
     var history=new MonitorHistory();Dictionary<string,object> currentSample=null;ReceiverView renderedView=null;
     var chartRefreshTrace=new List<object>();
     var clock=Stopwatch.StartNew();
     bridge.Receiver.Select(selection.SelectedPid);
     Action refresh=()=>{
      ReceiverView painted=bridge.Receiver.Capture().Boundary.SelectedPid!=selection.SelectedPid?
       ApplySelection(window,history,bridge.Receiver,selection.SelectedPid,Alive):ApplyCurrent(window,history,bridge.Receiver,Alive);
      renderedView=painted;currentSample=painted.Current==null?null:painted.Current.Data;display=DisplayFor(painted,Alive);
      if(localFailure!=null)((TextBlock)window.FindName("Connection")).Text=localFailure+" · 窗口 PID "+Process.GetCurrentProcess().Id;
     };
     SetDetailsFolded(window,true);
     // Clear prior PID controls and curves synchronously on an explicit selection.
     SelectionChangedEventHandler changed=(s,e)=>{
      if(selection.SelectedPid==bridge.Receiver.Capture().Boundary.SelectedPid)return;
      refresh();
     };
     choices.SelectionChanged+=changed;
     string closeReason="unattributed";
     ((Button)window.FindName("CloseButton")).Click+=(s,e)=>{closeReason="close-button";window.Close();};
     window.Closing+=(s,e)=>{if(audit!=null)audit.NoteLifecycle("ui-closing",closeReason,selection.SelectedPid);};
     // Close explicitly releases the actual pipe and cancellation registrations.
     window.Closed+=(s,e)=>{if(audit!=null)audit.NoteLifecycle("ui-closed",closeReason,selection.SelectedPid);choices.SelectionChanged-=changed;apiChoices.SelectionChanged-=apiChanged;selection.Dispose();bridge.Dispose();apiBridge.Dispose();};
     fold.Click+=(s,e)=>{folded=!folded;SetDetailsFolded(window,folded);};
     ((Grid)window.FindName("DragArea")).MouseLeftButtonDown+=(s,e)=>{
      var source=e.OriginalSource as DependencyObject;while(source!=null){if(source is Button)return;source=VisualTreeHelper.GetParent(source);}
      if(e.ButtonState==MouseButtonState.Pressed){try{window.DragMove();}catch{}}
     };
     slider.ValueChanged+=(s,e)=>{window.Opacity=slider.Value;opacity.Text=Math.Round(slider.Value*100).ToString(CultureInfo.InvariantCulture)+"%";};
     window.Loaded+=(s,e)=>{var handle=new WindowInteropHelper(window).Handle;Bridge.ShowOverlay(handle);nativeVisible=Bridge.IsWindowVisible(handle);};
     window.SizeChanged+=(s,e)=>{window.Top=Math.Max(area.Top,Math.Min(window.Top,area.Bottom-window.ActualHeight-8));};
     ((Canvas)window.FindName("TokenChart")).SizeChanged+=(s,e)=>refresh();
     ((Canvas)window.FindName("RateChart")).SizeChanged+=(s,e)=>refresh();
     var timer=new DispatcherTimer{Interval=TimeSpan.FromSeconds(1)};
     timer.Tick+=(s,e)=>{
      try {
       latest=bridge.GetSamples();selection.Update(latest);
       if(!bridge.Running)bridge.Receiver.InvalidateSelected("监控通道已停止");
       refresh();everConnected|=display.Live;
       updateApiChoices();refreshApi();
      }catch{bridge.Receiver.InvalidateSelected("界面快照应用失败");refresh();}
      chartsVisibleWhenFolded|=folded&&((TextBlock)window.FindName("WindowTokenValue")).IsVisible&&((TextBlock)window.FindName("WindowRateValue")).IsVisible;
      if(audit!=null)audit.Capture(bridge,renderedView,history,window,latest.Select(v=>Convert.ToInt32(v["pid"])).ToArray(),clock.ElapsedMilliseconds);
      if(smoke>0 && chartRefreshTrace.Count<90){var lastPoint=history.LatestWindow;chartRefreshTrace.Add(new{receiptEvidence=ReceiptEvidence(renderedView,history),elapsedMs=clock.ElapsedMilliseconds,selectedPid=selection.SelectedPid,resolvedPid=currentSample==null?(int?)null:Convert.ToInt32(currentSample["pid"]),processRateText=display.Rate,processLastTokens=display.LastTokens,processTotalTokens=display.TotalTokens,historyLatestWindowTokens=lastPoint==null?(double?)null:lastPoint.WindowTokens,historyLatestWindowRate=lastPoint==null?(double?)null:lastPoint.WindowHitRatePercent,windowInputPositions=lastPoint==null?(long?)null:lastPoint.WindowInputPositions,windowHitPositions=lastPoint==null?(long?)null:lastPoint.WindowHitPositions,observedMilliseconds=history.ObservedMilliseconds,hasBaseline=history.HasBaseline,baselineReceivedAt=history.BaselineReceivedAt,rawTotalTokens=currentSample==null?null:currentSample["totalInputTokens"],rawPositions=currentSample==null?null:currentSample["inputPositions"],rawHitPositions=currentSample==null?null:currentSample["cacheHitPositions"],chartWindowTokenText=((TextBlock)window.FindName("WindowTokenValue")).Text,chartWindowRateText=((TextBlock)window.FindName("WindowRateValue")).Text,tokenSegments=history.GetSegments(false).Length,rateSegments=history.GetSegments(true).Length,tokenVisuals=((Canvas)window.FindName("TokenChart")).Children.Count,rateVisuals=((Canvas)window.FindName("RateChart")).Children.Count,sourcePids=latest.Select(v=>Convert.ToInt32(v["pid"])).ToArray(),rejected=bridge.Rejected});}
      if(smoke>0 && clock.Elapsed.TotalSeconds>=smoke){closeReason="smoke-deadline";window.Close();}
     };
     refresh();refreshApi();timer.Start();try{window.ShowDialog();if(audit!=null)audit.NoteLifecycle("dialog-returned",closeReason,selection.SelectedPid);}finally{timer.Stop();if(audit!=null)audit.Capture(bridge,renderedView,history,window,latest.Select(v=>Convert.ToInt32(v["pid"])).ToArray(),clock.ElapsedMilliseconds);choices.SelectionChanged-=changed;apiChoices.SelectionChanged-=apiChanged;selection.Dispose();bridge.Dispose();apiBridge.Dispose();}
     if(report!=null){
      var result=new{uiVersion=UiVersion,uiLoaded=true,nativeVisible,everConnected,processes=latest.Length,pipeReleased=!bridge.Running,rejected=bridge.Rejected,connectionText=display.State,rateText=display.Rate,lastTokens=display.LastTokens,totalTokens=display.TotalTokens,formula=display.Formula,updated=display.Updated,folded,topmost=window.Topmost,allowsTransparency=window.AllowsTransparency,opacity=window.Opacity,selectedPid=selection.SelectedPid,historyPoints=history.Points,tokenSegments=history.GetSegments(false).Length,rateSegments=history.GetSegments(true).Length,chartsVisibleWhenFolded,chartRefreshTrace,samples=latest};
      using(var stream=new FileStream(report,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(stream,new UTF8Encoding(false)))writer.Write(new JavaScriptSerializer().Serialize(result));
     }
    }return 0;
   }catch(ArgumentException){Console.Error.WriteLine("INVALID_LAUNCH_ARGUMENTS");return 2;
   }catch(MonitorXamlIntegrityException){
    Console.Error.WriteLine("XAML_INTEGRITY_REJECTED");
    if(smoke==0)MessageBox.Show("Monitor.xaml 缺失、被修改或无法核验，已拒绝加载。未启动监控通道。","CachePilot · 完整性校验失败");
    return 2;
   }catch{if(smoke==0)MessageBox.Show("监控框已打开或本机通道不可用。请关闭已有监控框后重试。","CachePilot");return 1;}finally{if(audit!=null)audit.Dispose();}
  }
 }
}
