using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace CachePilotMonitor {
 // Only Bridge-owned receiver stamps establish identity, order and duration.
 // Payload timestamps and sequence-like JSON fields never establish a baseline.
 public sealed class HistoryPoint {
  public readonly long AtMilliseconds,ReceivedAt,ObservedMilliseconds;
  public readonly double? WindowTokens,WindowHitRatePercent;
  public readonly long? WindowInputPositions,WindowHitPositions;
  public readonly string FrameId,BaselineFrameId,Epoch;
  public readonly long OriginSeq,BaselineOriginSeq,SelectionGeneration,Watermark;
  public HistoryPoint(long at,long received,double? tokens,double? rate,long? inputs,long? hits,long observed){AtMilliseconds=at;ReceivedAt=received;WindowTokens=tokens;WindowHitRatePercent=rate;WindowInputPositions=inputs;WindowHitPositions=hits;ObservedMilliseconds=observed;}
  public HistoryPoint(ReceiverStamp stamp,ReceiverStamp baseline,ReceiverBoundary boundary,double? tokens,double? rate,long? inputs,long? hits):this(stamp.ReceivedMonotonicMilliseconds,stamp.ReceivedUtcMilliseconds,tokens,rate,inputs,hits,stamp.ReceivedMonotonicMilliseconds-baseline.ReceivedMonotonicMilliseconds){FrameId=stamp.FrameId;BaselineFrameId=baseline.FrameId;Epoch=stamp.Epoch;OriginSeq=stamp.OriginSeq;BaselineOriginSeq=baseline.OriginSeq;SelectionGeneration=boundary.SelectionGeneration;Watermark=boundary.Watermark;}
 }
 public sealed class MonitorHistory {
  public const long WindowMilliseconds=120000;
  public const long StaleMilliseconds=4000;
  public const int MaximumPoints=256;
  public const int MinimumPostBaselineFrames=2;
  public const int MinimumInputPositions=5;
  sealed class RawSnapshot {
   public readonly ReceiverStamp Stamp;
   public readonly long Tokens,Inputs,Hits;
   public readonly long? Misses;
   public RawSnapshot(ReceiverStamp stamp,long tokens,long inputs,long hits,long? misses){Stamp=stamp;Tokens=tokens;Inputs=inputs;Hits=hits;Misses=misses;}
  }
  readonly List<HistoryPoint> points=new List<HistoryPoint>();
  readonly List<RawSnapshot> raw=new List<RawSnapshot>();
  HistoryPoint latestWindow;
  public int SelectedPid {get;private set;}
  public long? StartedAt {get;private set;}
  public string TokenLabel {get;private set;}
  public string CurrentState {get;private set;}
  public string TokenValueText {get;private set;}
  public string RateValueText {get;private set;}
  public int PostBaselineFrameCount {get{return raw.Count>0?raw.Count-1:0;}}
  public bool HasBaseline {get{return raw.Count>0;}}
  public long? BaselineReceivedAt {get{return raw.Count==0?(long?)null:raw[0].Stamp.ReceivedUtcMilliseconds;}}
  public long? BaselineMonotonicMilliseconds {get{return raw.Count==0?(long?)null:raw[0].Stamp.ReceivedMonotonicMilliseconds;}}
  public long? BaselineOriginSeq {get{return raw.Count==0?(long?)null:raw[0].Stamp.OriginSeq;}}
  public string BaselineFrameId {get{return raw.Count==0?null:raw[0].Stamp.FrameId;}}
  public long? BaselineTokens {get{return raw.Count==0?(long?)null:raw[0].Tokens;}}
  public long? BaselineInputPositions {get{return raw.Count==0?(long?)null:raw[0].Inputs;}}
  public long? BaselineHitPositions {get{return raw.Count==0?(long?)null:raw[0].Hits;}}
  public long ObservedMilliseconds {get{return raw.Count<2?0:raw[raw.Count-1].Stamp.ReceivedMonotonicMilliseconds-raw[0].Stamp.ReceivedMonotonicMilliseconds;}}
  public long? CalculatedWindowTokens {get;private set;}
  public long? WindowInputPositions {get;private set;}
  public long? WindowHitPositions {get;private set;}
  public double? CalculatedWindowHitRatePercent {get;private set;}
  public ReceiverBoundary Boundary {get;private set;}
  public HistoryPoint LatestWindow {get{return latestWindow;}}
  public HistoryPoint Latest {get{return latestWindow;}}
  public HistoryPoint[] Points {get{return points.ToArray();}}
  public double TokenAxisMaximum {get{double maximum=1;foreach(var point in points)if(point.WindowTokens.HasValue && point.WindowTokens.Value>maximum)maximum=point.WindowTokens.Value;return maximum;}}
  public MonitorHistory(){Reset();}
  public void Reset(){ClearSeries();SelectedPid=0;StartedAt=null;Boundary=null;TokenLabel="近 120 秒本地 Token（未测量）";}
  void ClearSeries(){points.Clear();raw.Clear();latestWindow=null;CalculatedWindowTokens=null;WindowInputPositions=null;WindowHitPositions=null;CalculatedWindowHitRatePercent=null;CurrentState="无有效数据";TokenValueText="无有效数据";RateValueText="无有效数据";}
  static bool Number(Dictionary<string,object> sample,string key,out long value){
   value=0;object item;
   if(sample==null || !sample.TryGetValue(key,out item) || !(item is int || item is long || item is decimal))return false;
   try{decimal number=Convert.ToDecimal(item);if(number<0 || number>9007199254740991m || Decimal.Truncate(number)!=number)return false;value=Decimal.ToInt64(number);return true;}catch{return false;}
  }
  static bool Read(ReceivedSample sample,out RawSnapshot snapshot){
   snapshot=null;if(sample==null || sample.Stamp==null)return false;
   var data=sample.Data;long total,inputs,hits,misses;
   if(!Number(data,"totalInputTokens",out total) || !Number(data,"inputPositions",out inputs) || !Number(data,"cacheHitPositions",out hits) || hits>inputs)return false;
   bool hasMisses=data.ContainsKey("cacheMissPositions");misses=0;
   if(hasMisses && (!Number(data,"cacheMissPositions",out misses) || hits+misses!=inputs))return false;
   snapshot=new RawSnapshot(sample.Stamp,total,inputs,hits,hasMisses?(long?)misses:null);return true;
  }
  static bool Consistent(RawSnapshot before,RawSnapshot after){
   if(before==null)return true;
   long inputs=after.Inputs-before.Inputs,hits=after.Hits-before.Hits;
   if(after.Tokens<before.Tokens || inputs<0 || hits<0 || hits>inputs)return false;
   if(inputs==0 && after.Tokens!=before.Tokens)return false;
   if(before.Misses.HasValue && after.Misses.HasValue){long misses=after.Misses.Value-before.Misses.Value;if(misses<0 || hits+misses!=inputs)return false;}
   return true;
  }
  static bool SameIdentity(ReceiverStamp first,ReceiverStamp current){return first.Epoch==current.Epoch && first.ActualPid==current.ActualPid && first.ProcessIdentity==current.ProcessIdentity && first.StartedAt==current.StartedAt && first.Backend==current.Backend && first.SourceSessionGeneration==current.SourceSessionGeneration;}
  static bool After(ReceiverStamp before,ReceiverStamp after){return after.OriginSeq>before.OriginSeq || (after.OriginSeq==before.OriginSeq && after.FrameOrdinal>before.FrameOrdinal);}
  // Derive the entire current window from one immutable receiver view. This is
  // intentional: samples that left the window cannot retain a display vote,
  // and an old UI polling time cannot make an old receipt fresh again.
  public void Update(ReceiverView view){
   ClearSeries();StartedAt=null;TokenLabel="近 120 秒本地 Token（未测量）";
   if(view==null || view.Boundary==null){SelectedPid=0;Boundary=null;return;}
   Boundary=view.Boundary;SelectedPid=Boundary.SelectedPid;
   long now=view.NowMilliseconds;
   if(!view.Live || view.Current==null || SelectedPid<=0 || now<0 || Boundary.AtMilliseconds<0 || Boundary.AtMilliseconds>now)return;
   long lower=Math.Max(Boundary.AtMilliseconds,now>WindowMilliseconds?now-WindowMilliseconds:0);
   var seen=new HashSet<string>(StringComparer.Ordinal);
   ReceiverStamp first=null,previousStamp=null;RawSnapshot previous=null;
   foreach(var accepted in view.AcceptedSamples){
    if(accepted==null || accepted.Stamp==null){ClearSeries();return;}
    var stamp=accepted.Stamp;
    if(stamp.Epoch!=Boundary.Epoch || stamp.SelectionGeneration!=Boundary.SelectionGeneration || stamp.ActualPid!=SelectedPid || stamp.OriginSeq<=Boundary.Watermark || String.IsNullOrEmpty(stamp.FrameId)){ClearSeries();return;}
    if(!seen.Add(stamp.FrameId))continue;
    if(previousStamp!=null && (!After(previousStamp,stamp) || stamp.ReceivedMonotonicMilliseconds<previousStamp.ReceivedMonotonicMilliseconds)){ClearSeries();return;}
    if(first!=null && !SameIdentity(first,stamp)){ClearSeries();return;}
    if(stamp.Backend!="estimate" && stamp.Backend!="local"){ClearSeries();return;}
    RawSnapshot current;if(!Read(accepted,out current) || !Consistent(previous,current)){ClearSeries();return;}
    if(first==null)first=stamp;previous=current;previousStamp=stamp;
    // Never extend coverage backwards beyond this boundary or window.
    if(stamp.ReceivedMonotonicMilliseconds<lower)continue;
    if(stamp.ReceivedMonotonicMilliseconds>now){ClearSeries();return;}
    raw.Add(current);
   }
   if(raw.Count==0)return;
   var baseline=raw[0];var latest=raw[raw.Count-1];
   if(now-latest.Stamp.ReceivedMonotonicMilliseconds>=StaleMilliseconds || latest.Stamp.FrameId!=view.Current.Stamp.FrameId){ClearSeries();return;}
   StartedAt=baseline.Stamp.StartedAt;
   TokenLabel=baseline.Stamp.Backend=="estimate"?"近 120 秒本地 Token（估算）":"近 120 秒本地 Token（本地词表）";
   if(raw.Count==1){CurrentState=TokenValueText=RateValueText="基线建立中";return;}
   CalculatedWindowTokens=latest.Tokens-baseline.Tokens;WindowInputPositions=latest.Inputs-baseline.Inputs;WindowHitPositions=latest.Hits-baseline.Hits;
   CalculatedWindowHitRatePercent=WindowInputPositions.Value>0?(double?)(100.0*WindowHitPositions.Value/WindowInputPositions.Value):null;
   // Each point is computed only from the baseline still inside this view's
   // window. Baselines and repeated frame IDs never count as post-baseline
   // observations. A waiting phase contributes no fabricated zero point.
   for(int index=1;index<raw.Count;index++){
    var item=raw[index];long tokenDelta=item.Tokens-baseline.Tokens,inputDelta=item.Inputs-baseline.Inputs,hitDelta=item.Hits-baseline.Hits;
    bool enoughFrames=index>=MinimumPostBaselineFrames;
    double? visibleTokens=enoughFrames?(double?)tokenDelta:null;
    double? visibleRate=enoughFrames && inputDelta>=MinimumInputPositions?(double?)(100.0*hitDelta/inputDelta):null;
    var point=new HistoryPoint(item.Stamp,baseline.Stamp,Boundary,visibleTokens,visibleRate,inputDelta,hitDelta);
    latestWindow=point;
    if(visibleTokens.HasValue || visibleRate.HasValue)points.Add(point);
   }
   if(PostBaselineFrameCount<MinimumPostBaselineFrames){CurrentState=TokenValueText=RateValueText="样本不足";return;}
   TokenValueText=CalculatedWindowTokens.Value.ToString("N0",CultureInfo.InvariantCulture);
   if(WindowInputPositions.Value==0){CurrentState="暂无新增输入";RateValueText="暂无新增输入";return;}
   if(WindowInputPositions.Value<MinimumInputPositions){CurrentState="样本不足";RateValueText="样本不足";return;}
   CurrentState="实时";RateValueText=CalculatedWindowHitRatePercent.Value.ToString("F1",CultureInfo.InvariantCulture)+"%";
  }
  // Retained as a convenience for callers migrating to the receiver API. The
  // receiver's clock is authoritative; a separate UI timestamp is not used.
  public void Update(ReceiverView view,long unusedUiNow){Update(view);}
  public HistoryPoint[][] GetSegments(bool hitRate){
   var segments=new List<HistoryPoint[]>();var segment=new List<HistoryPoint>();
   foreach(var point in points){
    bool available=hitRate?point.WindowHitRatePercent.HasValue:point.WindowTokens.HasValue;
    if(available)segment.Add(point);
    else if(segment.Count>0){segments.Add(segment.ToArray());segment.Clear();}
   }
   if(segment.Count>0)segments.Add(segment.ToArray());
   return segments.ToArray();
  }
 }
 public static class HistoryRenderer {
  static readonly Brush TokenBrush=new SolidColorBrush(Color.FromRgb(145,193,255));
  static readonly Brush RateBrush=new SolidColorBrush(Color.FromRgb(124,227,199));
  public static void Draw(Canvas canvas,MonitorHistory history,bool hitRate,long now){
   if(canvas==null || history==null)return;
   canvas.Children.Clear();
   double width=canvas.ActualWidth>0?canvas.ActualWidth:canvas.Width;
   double height=canvas.ActualHeight>0?canvas.ActualHeight:canvas.Height;
   if(Double.IsNaN(width) || Double.IsInfinity(width) || Double.IsNaN(height) || Double.IsInfinity(height) || width<4 || height<4)return;
   canvas.Clip=new RectangleGeometry(new Rect(0,0,width,height));
   double left=2,top=2,right=2,bottom=2;
   double plotWidth=Math.Max(1,width-left-right),plotHeight=Math.Max(1,height-top-bottom);
   var segments=history.GetSegments(hitRate);
   double maximum=hitRate?100:history.TokenAxisMaximum;
   foreach(var segment in segments){
    var line=new Polyline{Stroke=hitRate?RateBrush:TokenBrush,StrokeThickness=1.8,StrokeLineJoin=PenLineJoin.Round};
    foreach(var point in segment){
     double age=now-point.AtMilliseconds;if(age<0 || age>MonitorHistory.WindowMilliseconds)continue;
     double value=hitRate?point.WindowHitRatePercent.Value:point.WindowTokens.Value;
     line.Points.Add(new Point(left+plotWidth*(1-age/MonitorHistory.WindowMilliseconds),top+plotHeight*(1-value/maximum)));
    }
    if(line.Points.Count>=2)canvas.Children.Add(line);
    if(line.Points.Count==1){var dot=new Ellipse{Width=4,Height=4,Fill=hitRate?RateBrush:TokenBrush};Canvas.SetLeft(dot,line.Points[0].X-2);Canvas.SetTop(dot,line.Points[0].Y-2);canvas.Children.Add(dot);}
   }
  }
 }
}
