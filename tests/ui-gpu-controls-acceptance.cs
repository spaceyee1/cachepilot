using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using CachePilotMonitor;

// Offscreen component events, synthetic source dictionaries. No real desktop input.
public static class GpuControlsAcceptance {
 static string xaml,root;static int failures,assertions;
 static readonly List<object> cases=new List<object>();
 static void Check(bool ok,string reason){assertions++;if(!ok)throw new Exception(reason);}
 static void Run(string name,Action test){int before=assertions;try{test();cases.Add(new{name,passed=true,assertions=assertions-before});}catch(Exception e){failures++;cases.Add(new{name,passed=false,reason=e.Message,assertions=assertions-before});}}
 static string Text(Window w,string name){return ((TextBlock)w.FindName(name)).Text;}
 static void Click(Window w,string name){((Button)w.FindName(name)).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));}
 sealed class F:IDisposable{
  public readonly Window W;public readonly string Folder;public readonly GpuSettingsStore Store;
  public F(){Folder=Path.Combine(root,"validation","c-"+Guid.NewGuid().ToString("N").Substring(0,8));Directory.CreateDirectory(Folder);Store=new GpuSettingsStore(Folder);W=(Window)XamlReader.Parse(File.ReadAllText(xaml,Encoding.UTF8));MonitorGpuControls.Attach(W,Folder,"portable","default");}
  public void Set(bool enabled){((CheckBox)W.FindName("GpuEnabled")).IsChecked=enabled;}
  public void Paths(){File.WriteAllText(Path.Combine(Folder,"python.exe"),"offline path fixture; never executed");Directory.CreateDirectory(Path.Combine(Folder,"model"));((TextBox)W.FindName("GpuPythonPath")).Text=Path.Combine(Folder,"python.exe");((TextBox)W.FindName("GpuModelPath")).Text=Path.Combine(Folder,"model");}
  public void Dispose(){W.Close();}
 }
 static void Tests(){
  Run("GPU_UI01 load and checkbox do not write files or change source",()=>{using(var f=new F()){Check(((CheckBox)f.W.FindName("GpuEnabled")).IsChecked==false,"default off");Check(!File.Exists(f.Store.ConfigPath),"load has no settings write");MonitorGpuControls.RenderSource(f.W,new Dictionary<string,object>{{"pid",51001},{"device","off"}});f.Set(true);Check(!File.Exists(f.Store.ConfigPath),"checkbox alone does not write");Check(Text(f.W,"GpuSaveState").Contains("未保存"),"unsaved explicit");Check(Text(f.W,"GpuSourceMode").Contains("off")&&!Text(f.W,"GpuSourceMode").Contains("cuda"),"old source unchanged by selection");Check(((TextBox)f.W.FindName("GpuModelPath")).IsEnabled,"enable allows local paths");}});
  Run("GPU_UI02 enable without paths rejects and keeps missing file",()=>{using(var f=new F()){f.Set(true);Click(f.W,"SaveGpuButton");Check(!File.Exists(f.Store.ConfigPath),"invalid enable never saves");Check(Text(f.W,"GpuSaveState").Contains("保存未确认"),"failure explicit without promising no postcommit change");}});
  Run("GPU_UI03 save CUDA intent never marks current source active",()=>{using(var f=new F()){f.Set(true);f.Paths();MonitorGpuControls.RenderSource(f.W,new Dictionary<string,object>{{"pid",51001},{"device","off"}});Click(f.W,"SaveGpuButton");Check(f.Store.Load().Enabled,"cuda config exported");Check(Text(f.W,"GpuSaveState").Contains("待宿主接入并重载")&&Text(f.W,"GpuSaveState").Contains("实际 GPU 执行未验证"),"pending and unverified explicit");Check(Text(f.W,"GpuSourceMode").Contains("off"),"save does not counterfeit source mode");MonitorGpuControls.RenderSource(f.W,new Dictionary<string,object>{{"pid",51002},{"device","cuda"}});Check(Text(f.W,"GpuSourceMode").Contains("51002")&&Text(f.W,"GpuSourceMode").Contains("非实际 GPU 执行证明"),"new PID configuration is not CUDA execution proof");MonitorGpuControls.RenderSource(f.W,null);Check(Text(f.W,"GpuSourceMode")=="来源启动模式：无有效数据","expired source has no saved-mode fallback");}});
  Run("GPU_UI04 stale save is not retried or silently applied",()=>{using(var f=new F()){var original=f.Store.Load();var external=f.Store.Save(false,"","",original.Revision);f.Set(true);f.Paths();Click(f.W,"SaveGpuButton");Check(f.Store.Load().Revision==external.Revision&&!f.Store.Load().Enabled,"stale UI cannot overwrite external change");Check(Text(f.W,"GpuSaveState").Contains("版本冲突"),"stale conflict surfaced");Click(f.W,"ReloadGpuButton");Check(((CheckBox)f.W.FindName("GpuEnabled")).IsChecked==false,"explicit reload discards unsaved intent");}});
  Run("GPU_UI05 candidate-only off export and cancel never import host settings",()=>{using(var f=new F()){f.Set(true);f.Paths();Click(f.W,"ReloadGpuButton");Check(!File.Exists(f.Store.ConfigPath)&&((CheckBox)f.W.FindName("GpuEnabled")).IsChecked==false,"discard unsaved selection never writes");Click(f.W,"SaveGpuButton");var data=new JavaScriptSerializer().DeserializeObject(File.ReadAllText(f.Store.ConfigPath)) as Dictionary<string,object>;Check(data!=null&&data.Count==3&&(string)data["device"]=="off"&&(bool)data["blockSecrets"]&&data.ContainsKey("tokenizer"),"complete path-free default profile, no host/API changes");}});
 }
 [STAThread]public static int Main(string[] args){
  if(args.Length!=2)return 2;xaml=Path.GetFullPath(args[0]);root=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(xaml),".."));var output=Path.GetFullPath(args[1]);
  if(!output.StartsWith(Path.Combine(root,"validation")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||File.Exists(output))return 2;
  Tests();var result=new{uiVersion=MonitorApp.UiVersion,source="offline_fixture",visibleWindowOpened=false,realDesktopInput=false,gpuInitialized=false,pythonExecuted=false,keyUsed=false,apiRequests=0,passed=cases.Count-failures,failed=failures,assertions,cases,checkedAtUtc=DateTimeOffset.UtcNow.ToString("o",CultureInfo.InvariantCulture)};
  var json=new JavaScriptSerializer().Serialize(result);using(var s=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var w=new StreamWriter(s,new UTF8Encoding(false)))w.Write(json);Console.WriteLine(json);return failures==0?0:1;
 }
}
