using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace CachePilotMonitor {
 public static class FrameCodec {
  static readonly string[] requiredNumbers={"pid","startedAt","sampledAt","hits","misses","reusedWithinCall","tokenizations","preparations","promptPreparations","failures","active","queued","rss"};
  public static readonly string[] measuredNumbers={"analyses","inputPositions","cacheHitPositions","cacheMissPositions","lastInputTokens","totalInputTokens","lastCompletedAt"};
  static bool Number(object value) {
   if(!(value is int || value is long || value is decimal))return false;
   decimal n=Convert.ToDecimal(value);return n>=0 && n<=9007199254740991m && Decimal.Truncate(n)==n;
  }
  public static Dictionary<string,object> Parse(string json,uint actualPid,long receivedAt) {
   var value=new JavaScriptSerializer{MaxJsonLength=4096,RecursionLimit=4}.DeserializeObject(json) as Dictionary<string,object>;
   if(value==null || !value.ContainsKey("schema") || !(value["schema"] is int))throw new IOException();
   int schema=(int)value["schema"];
   if((schema!=1 && schema!=2) || value.Count!=(schema==1?19:26))throw new IOException();
   foreach(string name in requiredNumbers)if(!value.ContainsKey(name)||!Number(value[name]))throw new IOException();
   if(Convert.ToInt64(value["pid"])<=0 || Convert.ToInt64(value["pid"])!=actualPid)throw new IOException();
   if(!value.ContainsKey("version") || !Regex.IsMatch(value["version"] as string??"",@"^\d{1,3}\.\d{1,3}\.\d{1,3}$"))throw new IOException();
   foreach(var pair in new Dictionary<string,string[]>{{"device",new[]{"off","cpu","cuda","auto"}},{"backend",new[]{"estimate","local"}}})
    if(!value.ContainsKey(pair.Key)||Array.IndexOf(pair.Value,value[pair.Key] as string)<0)throw new IOException();
   foreach(string name in new[]{"providerCacheMeasured","hostRequestsIntercepted"})if(!value.ContainsKey(name)||!(value[name] is bool)||(bool)value[name])throw new IOException();
   foreach(string name in measuredNumbers) {
    if(schema==1)value[name]=null;
    else if(!value.ContainsKey(name)||(value[name]!=null && !Number(value[name])))throw new IOException();
   }
   if(value["inputPositions"]!=null && value["cacheHitPositions"]!=null && value["cacheMissPositions"]!=null
     && Convert.ToDecimal(value["inputPositions"])!=Convert.ToDecimal(value["cacheHitPositions"])+Convert.ToDecimal(value["cacheMissPositions"]))throw new IOException();
   if(value["inputPositions"]!=null && value["cacheHitPositions"]!=null && Convert.ToDecimal(value["cacheHitPositions"])>Convert.ToDecimal(value["inputPositions"]))throw new IOException();
   if(value["totalInputTokens"]!=null && value["lastInputTokens"]!=null && Convert.ToDecimal(value["lastInputTokens"])>Convert.ToDecimal(value["totalInputTokens"]))throw new IOException();
   value["receivedAt"]=receivedAt;return value;
  }
 }
 public sealed class DisplayData {
  public string State="● 暂无有效数据",Rate="无数据",LastTokens="暂无数据",TokenCaption="最近分词 Token（本地）",TotalTokens="累计本地计数：未测量",Counts="命中 — · 新文本计算 —",Formula="分母：分词输入项，非请求数 / 云端 Token",Work="执行 — · 排队 — · 失败 —",Device="GPU：等待数据",Updated="尚无有效快照",CacheName="本地缓存：分词计数 / 偏移结果缓存（内存）";
  public bool Live=false;
  static string N(object value){return value==null?"未测量":Convert.ToInt64(value).ToString("N0",CultureInfo.InvariantCulture);}
  public static DisplayData Build(Dictionary<string,object> sample,long now,Func<int,bool> alive) {
   var d=new DisplayData();if(sample==null)return d;
   int pid=Convert.ToInt32(sample["pid"]);double age=Math.Max(0,(now-Convert.ToInt64(sample["receivedAt"]))/1000.0);
   bool running=false;try{running=alive(pid);}catch{}
   d.Live=running && age<4;
   d.State=d.Live?"● 本地数据已连接 · 来源 PID "+pid:(!running?"● 数据过期：进程已退出 / 无法核验":"● 数据过期：超过 4 秒未更新");
   string suffix=d.Live?"":"（上次）";
   d.Counts="跨调用命中 "+N(sample["hits"])+" · 新文本计算 "+N(sample["misses"])+" · 同批重复 "+N(sample["reusedWithinCall"]);
   if(sample["inputPositions"]!=null && sample["cacheHitPositions"]!=null && Convert.ToInt64(sample["inputPositions"])>0) {
    d.Rate=(100.0*Convert.ToDouble(sample["cacheHitPositions"])/Convert.ToDouble(sample["inputPositions"])).ToString("F1",CultureInfo.InvariantCulture)+"%"+suffix;
    d.Formula="跨调用命中 "+N(sample["cacheHitPositions"])+" / "+N(sample["inputPositions"])+" 个分词输入项";
   }else if(sample["inputPositions"]==null){
    d.Rate="无分母";
    d.Formula=(int)sample["schema"]==1?"旧协议未提供分母（需 0.6.6+）":"本次快照的分母未提供 / 不可用";
   }else if(Convert.ToInt64(sample["inputPositions"])==0){
    d.Rate="暂无输入";d.Formula="分母为 0：本进程尚无分词输入项，不计算百分比";
   }else{
    d.Rate="缺命中数";d.Formula="分母已提供，但命中输入项计数未提供 / 不可用";
   }
   d.TokenCaption=(string)sample["backend"]=="estimate"?"最近分词 Token（估算）":"最近分词 Token（本地词表）";
   d.LastTokens=sample["lastInputTokens"]==null?"未测量":N(sample["lastInputTokens"])+suffix;
   d.TotalTokens="累计本地计数："+N(sample["totalInputTokens"])+" · 含重复输入";
   d.Work=String.Format("执行 {0} · 排队 {1} · 失败 {2}",sample["active"],sample["queued"],sample["failures"]);
   string gpu=(string)sample["device"];d.Device=String.Format("GPU：{0} · 插件内存 {1:F1} MB",gpu=="off"||gpu=="cpu"?"关闭":gpu,Convert.ToDouble(sample["rss"])/1048576.0);
   d.Updated=DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(sample["receivedAt"])).UtcDateTime.ToString("HH:mm:ss.fff 'UTC'",CultureInfo.InvariantCulture)+" · "+age.ToString("F1",CultureInfo.InvariantCulture)+" 秒前";
   return d;
  }
 }
}
