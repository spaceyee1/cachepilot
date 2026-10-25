using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace CachePilotMonitor {
 // Core-compatible startup settings only. Never reads or executes a referenced resource.
 internal static class MonitorProfileSchema {
  internal const string DefaultJson="{\"device\":\"off\",\"blockSecrets\":true,\"tokenizer\":{\"backend\":\"estimate\",\"cache\":{\"enabled\":true,\"maxEntries\":512,\"maxBytes\":8388608,\"ttlMs\":300000}}}";
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static void Need(bool ok){if(!ok)throw new InvalidOperationException("PROFILE_SETTINGS_REJECTED");}
  internal static Dictionary<string,object> Defaults(){return Parse(Utf8.GetBytes(DefaultJson));}
  internal static Dictionary<string,object> Clone(Dictionary<string,object> data){var copy=new Dictionary<string,object>(StringComparer.Ordinal);foreach(var p in data)copy.Add(p.Key,p.Value is Dictionary<string,object>?Clone((Dictionary<string,object>)p.Value):p.Value);return copy;}
  static Dictionary<string,object> Obj(object value,string[] keys){var data=value as Dictionary<string,object>;Need(data!=null&&data.Keys.All(k=>keys.Contains(k)));return data;}
  static string Str(object value,int maximum){var s=value as string;Need(s!=null&&s.Length>0&&s.Length<=maximum&&!String.IsNullOrWhiteSpace(s));for(int i=0;i<s.Length;i++){Need(s[i]>=32&&s[i]!=127);if(Char.IsHighSurrogate(s[i])){Need(i+1<s.Length&&Char.IsLowSurrogate(s[++i]));}else Need(!Char.IsLowSurrogate(s[i]));}return s;}
  static decimal Number(object value,decimal min,decimal max,bool integer=true){Need(value is decimal||value is int||value is long);decimal n=Convert.ToDecimal(value,CultureInfo.InvariantCulture);Need(n>=min&&n<=max&&(!integer||Decimal.Truncate(n)==n));return n;}
  static void Bool(object value){Need(value is bool);}
  static void Local(string value){Str(value,4096);Need(Regex.IsMatch(value,@"^[A-Za-z]:\\")&&!Regex.IsMatch(value,@"[\x00-\x1f\x7f/<>""|?*]")&&value.IndexOf(':',2)<0);string full=Path.GetFullPath(value);Need(String.Equals(full.TrimEnd('\\'),value.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase));}
  static void Limits(Dictionary<string,object> d,string key,decimal min,decimal max){object v;if(d.TryGetValue(key,out v))Number(v,min,max);}
  static decimal Or(Dictionary<string,object> d,string key,decimal value){object v;return d.TryGetValue(key,out v)?Convert.ToDecimal(v,CultureInfo.InvariantCulture):value;}
  internal static void Validate(Dictionary<string,object> d){
   Obj(d,new[]{"contextWindow","reserveOutputTokens","overheadTokens","chunkTokens","maxChunks","device","model","modelPath","python","tokenizer","deduplicate","blockSecrets","batchSize","maxLength","timeoutMs","idleMs","session"});object v;
   if(d.TryGetValue("device",out v))Need(new[]{"off","cpu","cuda","auto"}.Contains(Str(v,16)));
   if(d.TryGetValue("model",out v))Str(v,256);
   if(d.TryGetValue("modelPath",out v)&&v!=null)Local(Str(v,4096));
   if(d.ContainsKey("device")&&(string)d["device"]!="off")Need(d.ContainsKey("modelPath")&&d["modelPath"] is string&&!String.IsNullOrWhiteSpace((string)d["modelPath"]));
   if(d.TryGetValue("python",out v)){string p=Str(v,4096);if(!Regex.IsMatch(p,@"^python(?:3(?:\.\d+)?)?(?:\.exe)?$",RegexOptions.IgnoreCase))Local(p);Need(!Regex.IsMatch(p,@"\.(?:cmd|bat|ps1|sh)$|(?:^|[\\/])(?:cmd|powershell|pwsh|sh|bash|zsh|cscript|wscript)(?:\.exe)?$",RegexOptions.IgnoreCase));}
   if(d.TryGetValue("blockSecrets",out v))Need(v is bool&&(bool)v);
   if(d.TryGetValue("deduplicate",out v))Bool(v);
   Limits(d,"contextWindow",128,1048576);Limits(d,"reserveOutputTokens",1,65536);Limits(d,"overheadTokens",0,65536);Limits(d,"chunkTokens",16,8192);Limits(d,"maxChunks",1,64);Limits(d,"batchSize",1,64);Limits(d,"maxLength",16,4096);Limits(d,"timeoutMs",100,120000);Limits(d,"idleMs",1,3600000);
   Need(Or(d,"reserveOutputTokens",1024)+Or(d,"overheadTokens",256)<Or(d,"contextWindow",8192));
   if(d.TryGetValue("tokenizer",out v)){
    var t=Obj(v,new[]{"backend","tokenizerPath","cache"});string backend=t.ContainsKey("backend")?Str(t["backend"],16):"estimate";Need(backend=="estimate"||backend=="local");Need(backend=="local"?t.ContainsKey("tokenizerPath"):!t.ContainsKey("tokenizerPath"));if(t.ContainsKey("tokenizerPath")){string path=Str(t["tokenizerPath"],4096);Local(path);Need(String.Equals(Path.GetExtension(path),".json",StringComparison.OrdinalIgnoreCase));}
    if(t.TryGetValue("cache",out v)){var c=Obj(v,new[]{"enabled","maxEntries","maxBytes","ttlMs"});if(c.TryGetValue("enabled",out v))Bool(v);Limits(c,"maxEntries",1,8192);Limits(c,"maxBytes",256,67108864);Limits(c,"ttlMs",1,86400000);}
   }
   if(d.TryGetValue("session",out v)){var s=Obj(v,new[]{"maxSessions","ttlMs","hysteresis"});Limits(s,"maxSessions",1,32);Limits(s,"ttlMs",1,86400000);if(s.TryGetValue("hysteresis",out v))Number(v,0,0.25m,false);}
  }
  // Finite UI precision boundary: reject rather than round a core-compatible number.
  static string NormalizeNumber(string text){
   bool negative=text.StartsWith("-",StringComparison.Ordinal);if(negative)text=text.Substring(1);
   int exp=0,index=text.IndexOfAny(new[]{'e','E'});if(index>=0){if(!Int32.TryParse(text.Substring(index+1),NumberStyles.AllowLeadingSign,CultureInfo.InvariantCulture,out exp))throw new InvalidOperationException("PROFILE_NUMBER_PRECISION_UNSUPPORTED");text=text.Substring(0,index);}
   int dot=text.IndexOf('.');int fractional=dot<0?0:text.Length-dot-1;string digits=text.Replace(".","").TrimStart('0');if(digits.Length==0)return "0";
   long power=(long)exp-fractional;int end=digits.Length;while(end>0&&digits[end-1]=='0'){end--;power++;}digits=digits.Substring(0,end);
   return (negative?"-":"")+digits+"e"+power.ToString(CultureInfo.InvariantCulture);
  }
  // Reject duplicate decoded keys before any deserializer can silently replace them.
  sealed class Parser {
   readonly string text;int at,keys;internal Parser(string value){text=value;}
   void White(){while(at<text.Length&&" \t\r\n".IndexOf(text[at])>=0)at++;}
   void Take(char c){White();Need(at<text.Length&&text[at++]==c);}
   string Quoted(){White();Need(at<text.Length&&text[at]=='"');int start=at++;while(at<text.Length){char c=text[at++];if(c=='"')return new JavaScriptSerializer().Deserialize<string>(text.Substring(start,at-start));Need(c>=32);if(c=='\\'){Need(at<text.Length);at++;}}throw new InvalidOperationException();}
   object Value(int depth){White();Need(depth<=8&&at<text.Length);if(text[at]=='{')return Object(depth+1);if(text[at]=='"')return Quoted();foreach(string literal in new[]{"true","false","null"})if(text.Substring(at).StartsWith(literal,StringComparison.Ordinal)){at+=literal.Length;return literal=="null"?null:(object)(literal=="true");}int start=at;while(at<text.Length&&"0123456789+-.eE".IndexOf(text[at])>=0)at++;string n=text.Substring(start,at-start);Need(Regex.IsMatch(n,@"\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z"));decimal number;if(!Decimal.TryParse(n,NumberStyles.Float,CultureInfo.InvariantCulture,out number)||NormalizeNumber(n)!=NormalizeNumber(number.ToString("G29",CultureInfo.InvariantCulture)))throw new InvalidOperationException("PROFILE_NUMBER_PRECISION_UNSUPPORTED");return number;}
   Dictionary<string,object> Object(int depth){var result=new Dictionary<string,object>(StringComparer.Ordinal);Take('{');White();if(at<text.Length&&text[at]=='}'){at++;return result;}while(true){string key=Quoted();Need(++keys<=128&&!result.ContainsKey(key));Take(':');result.Add(key,Value(depth));White();Need(at<text.Length);char c=text[at++];if(c=='}')return result;Need(c==',');}}
   internal Dictionary<string,object> Read(){var value=Object(0);White();Need(at==text.Length);return value;}
  }
  internal static Dictionary<string,object> Parse(byte[] bytes){Need(bytes!=null&&bytes.Length>0&&bytes.Length<=65536);string text=Utf8.GetString(bytes);if(text.StartsWith("\uFEFF",StringComparison.Ordinal))text=text.Substring(1);var value=new Parser(text).Read();Validate(value);return value;}
  internal static byte[] Serialize(Dictionary<string,object> value){Validate(value);byte[] b=Utf8.GetBytes(new JavaScriptSerializer().Serialize(value)+"\n");Need(b.Length<=65536);return b;}
 }
}
