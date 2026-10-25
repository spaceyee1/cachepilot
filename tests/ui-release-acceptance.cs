using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

public static class ReleaseAcceptance {
 static readonly List<object> Cases=new List<object>();static int failed;static string root,product;
 static void Check(bool v){if(!v)throw new InvalidOperationException();}
 static string Hash(string p){using(var h=SHA256.Create())using(var f=File.OpenRead(p))return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant();}
 static void Run(string name,Action test){try{test();Cases.Add(new{name,passed=true});}catch(Exception e){failed++;Cases.Add(new{name,passed=false,errorClass=e.GetType().Name});}}
 static void Rejected(string argument,string expected){
  var start=new ProcessStartInfo(product,argument){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};start.EnvironmentVariables.Clear();foreach(string n in new[]{"SystemRoot","WINDIR","TEMP","TMP"})if(Environment.GetEnvironmentVariable(n)!=null)start.EnvironmentVariables[n]=Environment.GetEnvironmentVariable(n);start.EnvironmentVariables["CUDA_VISIBLE_DEVICES"]="-1";
  using(var p=Process.Start(start)){var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();if(!p.WaitForExit(4000)){p.Kill();throw new TimeoutException();}Check(p.ExitCode==2&&error.Wait(1000)&&error.Result.Trim()==expected&&output.Wait(1000)&&String.IsNullOrWhiteSpace(output.Result));}
 }
 public static int Main(string[] args){
  if(args.Length!=2)return 2;root=Path.GetFullPath(args[0]);product=Path.Combine(root,"ui","CachePilot.Monitor.exe");string before=Hash(product);
  Run("release_only_embeds_trusted_xaml_no_author_audit_root",()=>{var a=Assembly.LoadFile(product);var names=a.GetManifestResourceNames();Check(!names.Contains("CachePilotMonitor.AuditRoot")&&names.Contains("CachePilotMonitor.TrustedMonitorXaml"));using(var s=a.GetManifestResourceStream("CachePilotMonitor.TrustedMonitorXaml"))using(var m=new MemoryStream()){s.CopyTo(m);Check(m.ToArray().SequenceEqual(File.ReadAllBytes(Path.Combine(root,"ui","Monitor.xaml"))));}Check(a.GetName().Version==typeof(CachePilotMonitor.MonitorApp).Assembly.GetName().Version);});
  foreach(string flag in new[]{"--audit-run","--smoke-seconds","--report","--test-pipe"}){string f=flag;Run("release_rejects_bare_"+f,()=>Rejected(f,"DIAGNOSTICS_DISABLED"));Run("release_rejects_value_"+f,()=>Rejected(f+"=not-used","DIAGNOSTICS_DISABLED"));}
  Run("invalid_storage_rejected_before_user_profile_access",()=>Rejected("--storage=shared","INVALID_LAUNCH_ARGUMENTS"));
  Run("profile_traversal_rejected_before_user_profile_access",()=>Rejected("--storage=portable --profile=../outside","INVALID_LAUNCH_ARGUMENTS"));
  Run("default_example_is_path_free_and_matches_compiled_default",()=>{string text=File.ReadAllText(Path.Combine(root,"defaults","default.off.json"));Check(text.Trim()==CachePilotMonitor.MonitorProfileSchema.DefaultJson&&!text.Contains("python")&&!text.Contains("modelPath")&&!text.Contains(":"+"\\"));});
  Run("launchers_use_relative_executable_user_default_portable_explicit",()=>{string normal=File.ReadAllText(Path.Combine(root,"Start-Monitor.cmd")),portable=File.ReadAllText(Path.Combine(root,"Start-Portable.cmd"));Check(normal.Contains("%~dp0ui\\CachePilot.Monitor.exe")&&normal.Contains("--storage=user")&&!normal.Contains("--storage=portable")&&portable.Contains("--storage=portable"));});
  Run("product_exe_unchanged_during_checks",()=>Check(before==Hash(product)));
  var result=new{schema=1,uiVersion=CachePilotMonitor.MonitorApp.UiVersion,source="offline_release_checks",passed=Cases.Count-failed,failed,total=Cases.Count,visibleWindowOpened=false,actualUserProfileAccessed=false,gpuExecuted=false,keyUsed=false,providerApiRequests=0,productExeSha256Before=before,productExeSha256After=Hash(product),cases=Cases};
  using(var f=new FileStream(args[1],FileMode.CreateNew,FileAccess.Write,FileShare.Read))using(var w=new StreamWriter(f,new UTF8Encoding(false)))w.Write(new JavaScriptSerializer().Serialize(result));Console.WriteLine("UI8 release: "+result.passed+"/"+result.total+"; failed="+failed);return failed==0?0:1;
 }
}
